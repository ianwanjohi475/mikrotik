// OneISP simulator - ISP billing & customer management that provisions a MikroTik router.
// Run: node oneisp/server.js   then open http://localhost:8080  (login admin / admin)
const path = require('path');
const crypto = require('crypto');
const { createApp, HttpError } = require('../lib/http');
const { Store } = require('../lib/db');
const { toCli, RestClient, SimRouter } = require('../lib/routeros');
const P = require('./provision');
const { Mpesa, normalizePhone, RESULT_CODES } = require('./mpesa');
const { deliver } = require('./notify');
const seed = require('./seed');

const PORT = Number(process.env.ONEISP_PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const db = new Store(path.join(__dirname, '..', 'data', 'oneisp.json'), seed.seed);
const app = createApp({ publicDir: path.join(__dirname, 'public') });

// settings with nested defaults (new keys appear automatically in older data files)
function settings() {
  const s = db.obj('settings', seed.DEFAULT_SETTINGS);
  for (const k of ['smsTemplates', 'mpesa', 'messaging', 'smartolt']) s[k] = { ...seed.DEFAULT_SETTINGS[k], ...(s[k] || {}) };
  for (const k of ['sms', 'whatsapp']) s.messaging[k] = { ...seed.DEFAULT_SETTINGS.messaging[k], ...(s.messaging[k] || {}) };
  return s;
}
const now = () => new Date();
const iso = d => new Date(d).toISOString();
const rand = (n, chars = 'abcdefghjkmnpqrstuvwxyz23456789') => Array.from(crypto.randomBytes(n), b => chars[b % chars.length]).join('');
const need = (v, msg) => { if (v === undefined || v === null || v === '') throw new HttpError(400, msg); return v; };
const hashPw = p => crypto.createHash('sha256').update('oneisp:' + p).digest('hex');
const fmtMac = m => (m ? String(m).toUpperCase().replace(/[^0-9A-F]/g, '').match(/.{1,2}/g).join(':') : '');

// ---------------------------------------------------------------- auth
const sessions = new Map();
app.use(req => {
  if (!req.path.startsWith('/api/')) return;
  if (req.path.startsWith('/api/auth/') || req.path.startsWith('/api/portal/')) return;
  if (req.path.startsWith('/api/v1/')) {
    const tok = req.headers['x-token'] || req.query.token;
    if (tok !== settings().apiToken) throw new HttpError(401, 'Invalid or missing X-Token');
    return;
  }
  const uid = sessions.get(req.cookies.oisid);
  req.user = uid && db.get('users', uid);
  if (!req.user) throw new HttpError(401, 'Login required');
});
const safeUser = u => u && ({ id: u.id, username: u.username, name: u.name, role: u.role, phone: u.phone });

app.post('/api/auth/login', (req, res) => {
  const u = db.findOne('users', x => x.username === req.body.username && x.passwordHash === hashPw(req.body.password || ''));
  if (!u) throw new HttpError(401, 'Wrong username or password');
  const sid = rand(32);
  sessions.set(sid, u.id);
  res.cookie('oisid', sid);
  return { user: safeUser(u) };
});
app.post('/api/auth/logout', (req, res) => { sessions.delete(req.cookies.oisid); res.cookie('oisid', '', '; Max-Age=0'); return { ok: true }; });
app.get('/api/auth/me', req => {
  const u = db.get('users', sessions.get(req.cookies.oisid));
  if (!u) throw new HttpError(401, 'Login required');
  return { user: safeUser(u), company: settings().companyName, currency: settings().currency };
});

// ---------------------------------------------------------------- router plumbing
function routerFor(site) {
  if (site.mode === 'live') return new RestClient(site);
  const all = db.obj('simRouters');
  all[site.id] = all[site.id] || {};
  return new SimRouter(all[site.id]);
}

async function applyOps(site, ops, context, extra = {}) {
  const r = routerFor(site);
  const results = [];
  let ok = true;
  for (const op of ops) {
    const cli = toCli(op);
    if (!ok) { results.push({ cli, note: op.note, ok: false, error: 'skipped (previous command failed)' }); continue; }
    try {
      const res = await r.run(op);
      // show the command a human would have typed: "add" when it was new, "set [find ...]" when it existed
      results.push({ cli: res && res.did ? toCli({ ...op, action: res.did }) : cli, note: op.note, ok: true });
    }
    catch (e) { ok = false; results.push({ cli, note: op.note, ok: false, error: e.message }); }
  }
  if (ops.length) {
    db.insert('routerLogs', { siteId: site.id, siteName: site.name, mode: site.mode, context, ok, ops: results, ...extra });
    db.trim('routerLogs', 800);
  }
  if (site.mode === 'live') db.update('sites', site.id, { lastContact: iso(now()), status: ok ? 'online' : 'error', lastError: ok ? null : results.find(x => !x.ok).error });
  return { ok, mode: site.mode, ops: results };
}

const pkgOf = c => db.get('packages', c.packageId);
const siteOf = c => db.get('sites', c.siteId);
const policyOf = pkg => (pkg && pkg.policyId ? db.get('policies', pkg.policyId) : null);

function computeStatus(c) {
  if (c.disabled) return 'disabled';
  if (!c.expiresAt || new Date(c.expiresAt) <= now()) return 'expired';
  return 'active';
}

// Push the customer's current state to its router.
async function provision(c, context) {
  const site = siteOf(c), pkg = pkgOf(c);
  if (!site || !pkg) return { ok: false, ops: [], error: 'Customer has no site or package' };
  const policy = policyOf(pkg);
  const ops = P.customerOps(c, pkg, policy, site, computeStatus(c) === 'active' ? 'activate' : 'suspend', settings());
  return applyOps(site, ops, context, { customerId: c.id });
}
async function deprovision(c, context) {
  const site = siteOf(c), pkg = pkgOf(c);
  if (!site || !pkg) return { ok: true, ops: [] };
  return applyOps(site, P.customerOps(c, pkg, policyOf(pkg), site, 'delete', settings()), context, { customerId: c.id });
}

// ---------------------------------------------------------------- helpers
function ipToInt(ip) { return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0); }
function intToIp(n) { return [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.'); }
function nextFreeIp(site, type, exceptId) {
  const gw = type === 'dhcp' ? site.dhcpGateway : site.staticGateway;
  const base = ipToInt(gw) & 0xffffff00;
  const [from, to] = type === 'dhcp' ? [200, 254] : [10, 254];
  const used = new Set(db.find('customers', c => c.siteId === site.id && c.id !== exceptId && c.ipAddress).map(c => c.ipAddress));
  for (let i = from; i <= to; i++) { const ip = intToIp(base + i); if (!used.has(ip)) return ip; }
  throw new HttpError(400, 'No free IP addresses left on this site');
}

function render(tpl, c, extra = {}) {
  const pkg = c && pkgOf(c);
  const s = settings();
  const vars = {
    company: s.companyName, paybill: s.paybill, name: c?.name, account: c?.accountNo, username: c?.username, password: c?.password,
    package: pkg?.name, price: pkg?.price, expiry: c?.expiresAt ? new Date(c.expiresAt).toLocaleString() : '-', currency: s.currency, ...extra,
  };
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}
// Queue a message and deliver it in the background (SMS via Africa's Talking, WhatsApp via Meta/Twilio, or simulated).
// `to` is a phone number or { sms, whatsapp } numbers; channel 'sms' | 'whatsapp' | 'both' (default from settings).
function sendSms(to, message, customerId, kind = 'manual', channel) {
  const m = settings().messaging;
  const ch = channel || m.defaultChannel || 'sms';
  const recs = (ch === 'both' ? ['sms', 'whatsapp'] : [ch]).map(c => {
    const phone = typeof to === 'object' && to ? to[c] || to.sms : to;
    if (!phone) return null;
    const rec = db.insert('sms', { to: phone, message, customerId: customerId || null, kind, channel: c, status: 'sending' });
    deliver(m, c, phone, message)
      .then(r => Object.assign(rec, r, { sentAt: iso(now()) }))
      .catch(e => Object.assign(rec, { status: 'failed: ' + e.message }))
      .finally(() => { db.trim('sms', 3000); db.save(); });
    return rec;
  }).filter(Boolean);
  return recs[0] || null;
}
const numbersOf = c => ({ sms: c.phone, whatsapp: c.whatsapp || c.phone });
function smsTemplate(c, key, extra, channel) {
  const tpl = settings().smsTemplates[key];
  if (tpl && settings().smsEnabled) sendSms(numbersOf(c), render(tpl, c, extra), c.id, key, channel);
}
function logActivity(c, action, detail = '', by = 'system') {
  if (!c) return;
  db.insert('activity', { customerId: c.id, action, detail, by });
  db.trim('activity', 5000);
}

function decorate(c) {
  const pkg = pkgOf(c), site = siteOf(c);
  return { ...c, status: computeStatus(c), packageName: pkg?.name || '-', price: pkg?.price || 0, siteName: site?.name || '-' };
}

function extendCustomer(c, periods = 1) {
  const pkg = pkgOf(c);
  let base = c.expiresAt && new Date(c.expiresAt) > now() ? new Date(c.expiresAt) : now();
  for (let i = 0; i < periods; i++) base = new Date(base.getTime() + P.validityMs(pkg));
  c.expiresAt = iso(base);
  c.reminderSentFor = null;
}

async function applyPayment({ customerId, amount, method = 'cash', reference, note, by, silent }) {
  const c = db.get('customers', customerId);
  if (!c) throw new HttpError(404, 'Customer not found');
  amount = Number(need(amount, 'Amount is required'));
  if (!(amount > 0)) throw new HttpError(400, 'Amount must be positive');
  const pkg = pkgOf(c);
  const before = c.expiresAt;
  c.balance = Number(c.balance || 0) + amount;
  let periods = 0;
  while (pkg && pkg.price > 0 && c.balance >= pkg.price) { c.balance -= pkg.price; periods++; }
  if (periods) extendCustomer(c, periods);
  c.status = computeStatus(c);
  db.save();
  const pay = db.insert('payments', {
    customerId: c.id, customerName: c.name, accountNo: c.accountNo, amount, method,
    reference: reference || (method === 'mpesa' ? 'S' + rand(9, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789') : rand(8).toUpperCase()),
    note, periods, packageName: pkg?.name, expiryBefore: before, expiryAfter: c.expiresAt, by: by || 'system',
  });
  if (!silent) smsTemplate(c, 'payment', { amount });
  logActivity(c, 'payment', `${settings().currency} ${amount} via ${method} (${pay.reference}) - ${periods} period(s)`, by);
  const router = await provision(c, `Payment ${pay.reference}: ${periods} period(s) added`);
  return { payment: pay, customer: decorate(c), router };
}

// ---------------------------------------------------------------- dashboard
app.get('/api/dashboard', () => {
  const customers = db.col('customers').map(decorate);
  const pays = db.col('payments');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const month = new Date(today.getFullYear(), today.getMonth(), 1);
  const sum = arr => arr.reduce((a, p) => a + Number(p.amount), 0);
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const s = new Date(today.getFullYear(), today.getMonth() - i, 1), e = new Date(today.getFullYear(), today.getMonth() - i + 1, 1);
    months.push({ label: s.toLocaleString('en', { month: 'short' }), total: sum(pays.filter(p => new Date(p.createdAt) >= s && new Date(p.createdAt) < e)) });
  }
  const soon = new Date(Date.now() + 3 * 864e5);
  const byType = {};
  for (const t of ['pppoe', 'static', 'dhcp', 'hotspot']) byType[t] = customers.filter(c => c.connectionType === t).length;
  return {
    stats: {
      total: customers.length, active: customers.filter(c => c.status === 'active').length,
      expired: customers.filter(c => c.status === 'expired').length, disabled: customers.filter(c => c.status === 'disabled').length,
      online: customers.filter(c => c.online).length, byType,
      revenueToday: sum(pays.filter(p => new Date(p.createdAt) >= today)), revenueMonth: sum(pays.filter(p => new Date(p.createdAt) >= month)),
      expensesMonth: db.col('expenses').filter(e => new Date(e.date) >= month).reduce((a, e) => a + Number(e.amount), 0),
      openTickets: db.find('tickets', t => !['resolved', 'closed'].includes(t.status)).length,
      newLeads: db.find('leads', l => l.status === 'new').length,
      vouchersUnused: db.find('vouchers', v => v.status === 'unused').length,
    },
    revenueByMonth: months,
    expiringSoon: customers.filter(c => c.status === 'active' && new Date(c.expiresAt) < soon).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)).slice(0, 10),
    recentPayments: pays.slice(-8).reverse(),
    sites: db.col('sites').map(s => ({ id: s.id, name: s.name, mode: s.mode, status: s.mode === 'live' ? s.status || 'unknown' : 'simulated', customers: customers.filter(c => c.siteId === s.id).length, online: customers.filter(c => c.siteId === s.id && c.online).length })),
  };
});

// ---------------------------------------------------------------- sites
const SITE_FIELDS = ['name', 'location', 'mode', 'host', 'port', 'useHttps', 'username', 'password', 'wanInterface', 'pppoeInterface', 'hotspotInterface', 'dhcpInterface', 'staticInterface',
  'pppoeGateway', 'pppoePool', 'expiredPool', 'hotspotGateway', 'hotspotPool', 'hotspotServer', 'hotspotDns', 'dhcpGateway', 'dhcpPool', 'dhcpServer', 'staticGateway', 'dns'];
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));
const publicSite = s => ({ ...s, password: s.password ? '********' : '' });

app.get('/api/sites', () => db.col('sites').map(s => ({ ...publicSite(s), customers: db.find('customers', c => c.siteId === s.id).length })));
app.get('/api/sites/:id', req => { const s = db.get('sites', req.params.id); if (!s) throw new HttpError(404, 'Site not found'); return publicSite(s); });
app.post('/api/sites', req => {
  need(req.body.name, 'Site name is required');
  return publicSite(db.insert('sites', { ...seed.DEFAULT_SITE, ...pick(req.body, SITE_FIELDS), port: Number(req.body.port || 80), useHttps: !!req.body.useHttps }));
});
app.put('/api/sites/:id', req => {
  const patch = pick(req.body, SITE_FIELDS);
  if (patch.password === '********') delete patch.password;
  if (patch.port) patch.port = Number(patch.port);
  if (patch.useHttps !== undefined) patch.useHttps = patch.useHttps === true || patch.useHttps === 'true';
  const s = db.update('sites', req.params.id, patch);
  if (!s) throw new HttpError(404, 'Site not found');
  return publicSite(s);
});
app.delete('/api/sites/:id', req => {
  if (db.find('customers', c => c.siteId === Number(req.params.id)).length) throw new HttpError(400, 'Move or delete this site\'s customers first');
  db.remove('sites', req.params.id);
  return { ok: true };
});
const siteOr404 = id => { const s = db.get('sites', id); if (!s) throw new HttpError(404, 'Site not found'); return s; };

app.post('/api/sites/:id/test', async req => {
  const s = siteOr404(req.params.id);
  if (s.mode !== 'live') return { ok: true, mode: 'simulate', resource: { 'board-name': 'Simulated CHR', version: '7.x (simulated)', uptime: '-', 'cpu-load': '3', 'free-memory': '-' } };
  try {
    const r = new RestClient(s);
    const [resource, identity] = await Promise.all([r.request('GET', '/system/resource'), r.request('GET', '/system/identity')]);
    db.update('sites', s.id, { status: 'online', lastContact: iso(now()), lastError: null, identity: identity?.name });
    return { ok: true, mode: 'live', identity: identity?.name, resource };
  } catch (e) {
    db.update('sites', s.id, { status: 'error', lastError: e.message });
    return { ok: false, mode: 'live', error: e.message };
  }
});

const TABLES = {
  'ppp-secret': '/ppp/secret', 'ppp-active': '/ppp/active', 'ppp-profile': '/ppp/profile', 'hotspot-user': '/ip/hotspot/user',
  'hotspot-active': '/ip/hotspot/active', 'hotspot-profile': '/ip/hotspot/user/profile', queue: '/queue/simple', lease: '/ip/dhcp-server/lease',
  'address-list': '/ip/firewall/address-list', arp: '/ip/arp', interface: '/interface', pool: '/ip/pool', address: '/ip/address',
  'pppoe-server': '/interface/pppoe-server/server', hotspot: '/ip/hotspot', 'dhcp-server': '/ip/dhcp-server', 'firewall-filter': '/ip/firewall/filter', nat: '/ip/firewall/nat',
};
app.get('/api/sites/:id/router/:table', async req => {
  const s = siteOr404(req.params.id);
  const menu = TABLES[req.params.table];
  if (!menu) throw new HttpError(400, 'Unknown table');
  try { return { menu, cli: `/${menu.slice(1).replace(/\//g, ' ')} print`, rows: await routerFor(s).list(menu) }; }
  catch (e) { throw new HttpError(502, e.message); }
});
app.get('/api/sites/:id/script', (req, res) => res.send(P.bootstrapScript(siteOr404(req.params.id), { ...settings(), portalPort: PORT }, settings().serverIp), 'text/plain; charset=utf-8'));
app.post('/api/sites/:id/script/push', async req => {
  const s = siteOr404(req.params.id);
  const script = P.bootstrapScript(s, { ...settings(), portalPort: PORT }, settings().serverIp).split('\n').filter(l => l && !l.startsWith('#')).join('\n');
  return applyOps(s, [{ action: 'exec', script, note: 'Bootstrap script via /rest/execute' }], 'Push provisioning script');
});
app.get('/api/sites/:id/hotspot-login.html', (req, res) => {
  const s = siteOr404(req.params.id);
  res.send(P.hotspotLoginHtml(s, `http://${settings().serverIp}:${PORT}`), 'text/html; charset=utf-8', 200, { 'Content-Disposition': 'attachment; filename="login.html"' });
});
app.post('/api/sites/:id/terminal', async req => {
  const s = siteOr404(req.params.id);
  const cmd = need(req.body.command, 'Command required');
  if (s.mode !== 'live') throw new HttpError(400, 'The terminal needs a live router (site mode = live). In simulate mode use the router tables.');
  try {
    const out = await new RestClient(s).request('POST', '/execute', { script: cmd, 'as-string': '' });
    return { output: out && out.ret !== undefined ? out.ret : JSON.stringify(out, null, 2) };
  } catch (e) { throw new HttpError(502, e.message); }
});
app.post('/api/sites/:id/reprovision', async req => {
  const s = siteOr404(req.params.id);
  const results = [];
  for (const pkg of db.col('packages')) {
    const ops = P.packageOps(pkg, policyOf(pkg), s);
    if (ops.length) results.push(await applyOps(s, ops, `Re-push package ${pkg.name}`));
  }
  for (const c of db.find('customers', c => c.siteId === s.id)) results.push(await provision(c, `Re-provision ${c.accountNo}`));
  for (const v of db.find('vouchers', v => v.siteId === s.id && v.status !== 'expired')) {
    const pkg = db.get('packages', v.packageId);
    if (pkg) results.push(await applyOps(s, P.voucherOps(v, pkg, policyOf(pkg), s, 'activate'), `Re-push voucher ${v.code}`));
  }
  return { ok: results.every(r => r.ok), count: results.length, failed: results.filter(r => !r.ok).length };
});
app.post('/api/sites/:id/sync', async req => syncSite(siteOr404(req.params.id)));

// Import existing PPP secrets / hotspot users from the router as customers (OneISP "Import from MikroTik").
app.post('/api/sites/:id/import', async req => {
  const s = siteOr404(req.params.id);
  const r = routerFor(s);
  let created = 0;
  const defaultPkg = type => db.findOne('packages', p => p.type === type);
  try {
    for (const sec of await r.list('/ppp/secret')) {
      if (db.findOne('customers', c => c.siteId === s.id && c.username === sec.name)) continue;
      const pkg = db.findOne('packages', p => P.profileName(p) === sec.profile) || defaultPkg('pppoe');
      createCustomerRecord({ name: sec.comment || sec.name, username: sec.name, password: sec.password || rand(6), connectionType: 'pppoe', siteId: s.id, packageId: pkg?.id, expiresAt: iso(Date.now() + 30 * 864e5), imported: true });
      created++;
    }
    for (const u of await r.list('/ip/hotspot/user')) {
      if (u.name === 'default-trial' || db.findOne('vouchers', v => v.code === u.name) || db.findOne('customers', c => c.siteId === s.id && c.username === u.name)) continue;
      const pkg = db.findOne('packages', p => P.profileName(p) === u.profile) || defaultPkg('hotspot');
      createCustomerRecord({ name: u.comment || u.name, username: u.name, password: u.password || rand(6), connectionType: 'hotspot', siteId: s.id, packageId: pkg?.id, expiresAt: iso(Date.now() + P.validityMs(pkg || {})), imported: true });
      created++;
    }
  } catch (e) { throw new HttpError(502, e.message); }
  return { created };
});

// ---------------------------------------------------------------- packages & bandwidth policies
const PKG_FIELDS = ['name', 'type', 'price', 'validityValue', 'validityUnit', 'download', 'upload', 'policyId', 'sharedUsers', 'description', 'public'];
function cleanPkg(b) {
  const p = pick(b, PKG_FIELDS);
  for (const k of ['price', 'validityValue', 'sharedUsers', 'policyId']) if (p[k] !== undefined) p[k] = p[k] === '' ? null : Number(p[k]);
  if (p.public !== undefined) p.public = p.public === true || p.public === 'true';
  return p;
}
async function pushPackageEverywhere(pkg) {
  const out = [];
  for (const s of db.col('sites')) {
    const ops = P.packageOps(pkg, policyOf(pkg), s);
    if (ops.length) out.push(await applyOps(s, ops, `Package ${pkg.name} saved`));
  }
  // static/dhcp queues carry the speed per customer, so refresh those customers too
  if (['static', 'dhcp'].includes(pkg.type)) for (const c of db.find('customers', c => c.packageId === pkg.id)) out.push(await provision(c, `Package ${pkg.name} speed changed`));
  return out;
}
app.get('/api/packages', () => db.col('packages').map(p => ({ ...p, policyName: policyOf(p)?.name || '-', customers: db.find('customers', c => c.packageId === p.id).length, profile: P.profileName(p), rateLimit: P.rateLimit(p, policyOf(p)) })));
app.post('/api/packages', async req => {
  const p = cleanPkg(req.body);
  need(p.name, 'Name required'); need(p.type, 'Type required'); need(p.download, 'Download speed required'); need(p.upload, 'Upload speed required');
  const pkg = db.insert('packages', { validityUnit: 'months', validityValue: 1, sharedUsers: 1, public: true, ...p });
  return { package: pkg, router: await pushPackageEverywhere(pkg) };
});
app.put('/api/packages/:id', async req => {
  const pkg = db.update('packages', req.params.id, cleanPkg(req.body));
  if (!pkg) throw new HttpError(404, 'Package not found');
  return { package: pkg, router: await pushPackageEverywhere(pkg) };
});
app.delete('/api/packages/:id', req => {
  if (db.find('customers', c => c.packageId === Number(req.params.id)).length) throw new HttpError(400, 'Package has customers');
  db.remove('packages', req.params.id);
  return { ok: true };
});

const POLICY_FIELDS = ['name', 'burstEnabled', 'burstDownload', 'burstUpload', 'thresholdDownload', 'thresholdUpload', 'burstTime', 'priority', 'description'];
app.get('/api/policies', () => db.col('policies').map(p => ({ ...p, packages: db.find('packages', k => k.policyId === p.id).length })));
app.post('/api/policies', req => {
  const p = pick(req.body, POLICY_FIELDS);
  need(p.name, 'Name required');
  p.burstEnabled = p.burstEnabled === true || p.burstEnabled === 'true';
  return db.insert('policies', p);
});
app.put('/api/policies/:id', async req => {
  const p = pick(req.body, POLICY_FIELDS);
  if (p.burstEnabled !== undefined) p.burstEnabled = p.burstEnabled === true || p.burstEnabled === 'true';
  const pol = db.update('policies', req.params.id, p);
  if (!pol) throw new HttpError(404, 'Policy not found');
  for (const pkg of db.find('packages', k => k.policyId === pol.id)) await pushPackageEverywhere(pkg);
  return pol;
});
app.delete('/api/policies/:id', req => {
  db.col('packages').forEach(p => { if (p.policyId === Number(req.params.id)) p.policyId = null; });
  db.remove('policies', req.params.id);
  return { ok: true };
});

// ---------------------------------------------------------------- customers
const CUSTOMER_FIELDS = ['name', 'phone', 'altPhone', 'whatsapp', 'installedAt', 'routerModel', 'routerSerial', 'email', 'idNumber', 'address', 'location', 'gps', 'siteId', 'packageId', 'connectionType', 'username', 'password', 'ipAddress', 'macAddress', 'expiresAt', 'notes', 'onuSn', 'installationFee'];
function cleanCustomer(b) {
  const c = pick(b, CUSTOMER_FIELDS);
  if (c.siteId !== undefined) c.siteId = Number(c.siteId);
  if (c.packageId !== undefined) c.packageId = Number(c.packageId);
  if (c.macAddress !== undefined) c.macAddress = fmtMac(c.macAddress);
  if (c.expiresAt) c.expiresAt = iso(c.expiresAt);
  return c;
}
function createCustomerRecord(input) {
  const s = settings();
  const seq = db.nextId('accountNo');
  const accountNo = `${s.accountPrefix}${1000 + seq}`;
  const c = { accountNo, username: accountNo.toLowerCase(), password: rand(6), balance: 0, disabled: false, online: false, ...input };
  need(c.name, 'Name is required'); need(c.connectionType, 'Connection type is required');
  if (!db.get('sites', c.siteId)) throw new HttpError(400, 'Choose a site');
  const pkg = db.get('packages', c.packageId);
  if (!pkg) throw new HttpError(400, 'Choose a package');
  if (pkg.type !== c.connectionType) throw new HttpError(400, `Package "${pkg.name}" is for ${pkg.type}, not ${c.connectionType}`);
  if (db.findOne('customers', x => x.siteId === c.siteId && x.username === c.username)) throw new HttpError(400, `Username ${c.username} already exists on this site`);
  if (c.connectionType === 'dhcp' && !c.macAddress) throw new HttpError(400, 'DHCP customers need the MAC address of their router');
  if (['static', 'dhcp'].includes(c.connectionType) && !c.ipAddress) c.ipAddress = nextFreeIp(db.get('sites', c.siteId), c.connectionType);
  const rec = db.insert('customers', c);
  rec.status = computeStatus(rec);
  return rec;
}

app.get('/api/customers', req => {
  const q = req.query;
  const all = db.col('customers').map(decorate);
  const stats = { total: all.length, active: 0, expired: 0, disabled: 0, online: 0 };
  all.forEach(c => { stats[c.status]++; if (c.online) stats.online++; });
  const s = (q.search || '').toLowerCase();
  const rows = all.filter(c =>
    (!q.type || c.connectionType === q.type) && (!q.status || c.status === q.status || (q.status === 'online' && c.online)) &&
    (!q.siteId || c.siteId === Number(q.siteId)) && (!q.packageId || c.packageId === Number(q.packageId)) &&
    (!s || [c.name, c.accountNo, c.username, c.phone, c.ipAddress, c.macAddress, c.address, c.onuSn].some(v => String(v || '').toLowerCase().includes(s))));
  return { stats, rows: rows.reverse() };
});
app.get('/api/customers.csv', (req, res) => {
  const cols = ['accountNo', 'name', 'phone', 'altPhone', 'whatsapp', 'email', 'idNumber', 'address', 'location', 'gps', 'connectionType', 'username', 'password', 'ipAddress', 'macAddress', 'packageName', 'price', 'siteName', 'status', 'expiresAt', 'balance', 'onuSn', 'routerModel', 'installedAt', 'createdAt'];
  const rows = db.col('customers').map(decorate).filter(c => !req.query.type || c.connectionType === req.query.type);
  res.send([cols.join(','), ...rows.map(c => cols.map(k => `"${String(c[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n'), 'text/csv', 200, { 'Content-Disposition': 'attachment; filename="customers.csv"' });
});
app.get('/api/customers/:id', req => {
  const c = db.get('customers', req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found');
  return {
    customer: decorate(c), package: pkgOf(c), site: c.siteId && publicSite(siteOf(c) || {}),
    payments: db.find('payments', p => p.customerId === c.id).reverse(),
    tickets: db.find('tickets', t => t.customerId === c.id).reverse(),
    sms: db.find('sms', m => m.customerId === c.id).reverse().slice(0, 30),
    logs: db.find('routerLogs', l => l.customerId === c.id).reverse().slice(0, 20),
    activity: db.find('activity', a => a.customerId === c.id).reverse().slice(0, 100),
    mpesa: db.find('mpesa', m => m.customerId === c.id).reverse().slice(0, 30),
    adjustments: db.find('adjustments', a => a.customerId === c.id).reverse(),
  };
});
app.post('/api/customers', async req => {
  const input = cleanCustomer(req.body);
  for (const k of ['username', 'password', 'ipAddress', 'expiresAt']) if (!input[k]) delete input[k];
  const pkg = db.get('packages', input.packageId);
  const c = createCustomerRecord(input);
  if (!c.expiresAt && req.body.activate !== false && req.body.activate !== 'false' && pkg) { extendCustomer(c); c.status = computeStatus(c); }
  if (req.body.leadId) db.update('leads', req.body.leadId, { status: 'converted', customerId: c.id });
  if (Number(req.body.initialPayment) > 0) {
    db.insert('payments', { customerId: c.id, customerName: c.name, accountNo: c.accountNo, amount: Number(req.body.initialPayment), method: req.body.paymentMethod || 'cash', reference: rand(8).toUpperCase(), note: 'Initial payment', periods: 1, packageName: pkg?.name, expiryAfter: c.expiresAt, by: req.user.username });
  }
  db.save();
  smsTemplate(c, 'welcome');
  logActivity(c, 'created', `${c.connectionType} on ${siteOf(c)?.name}, package ${pkg?.name}`, req.user.username);
  return { customer: decorate(c), router: await provision(c, `New customer ${c.accountNo}`) };
});
app.put('/api/customers/:id', async req => {
  const c = db.get('customers', req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found');
  const before = { ...c };
  const patch = cleanCustomer(req.body);
  if (patch.packageId && patch.packageId !== c.packageId) {
    const pkg = db.get('packages', patch.packageId);
    if (!pkg || pkg.type !== (patch.connectionType || c.connectionType)) throw new HttpError(400, 'Package does not match the connection type');
  }
  const identityChanged = ['siteId', 'username', 'connectionType', 'ipAddress', 'macAddress'].some(k => patch[k] !== undefined && String(patch[k]) !== String(before[k]));
  Object.assign(c, patch);
  if (['static', 'dhcp'].includes(c.connectionType) && !c.ipAddress) c.ipAddress = nextFreeIp(siteOf(c), c.connectionType, c.id);
  c._profileChanged = patch.packageId && patch.packageId !== before.packageId;
  const router = [];
  if (identityChanged) router.push(await deprovision(before, `Remove old router entry of ${c.accountNo}`));
  router.push(await provision(c, `Update customer ${c.accountNo}`));
  delete c._profileChanged;
  db.update('customers', c.id, {});
  const changes = Object.keys(patch).filter(k => String(patch[k] ?? '') !== String(before[k] ?? '')).map(k => k === 'password' ? 'password' : `${k}: ${before[k] ?? '-'} -> ${patch[k]}`);
  if (changes.length) logActivity(c, 'updated', changes.join(', '), req.user.username);
  return { customer: decorate(c), router };
});
app.delete('/api/customers/:id', async req => {
  const c = db.get('customers', req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found');
  const router = await deprovision(c, `Delete customer ${c.accountNo}`);
  db.remove('customers', c.id);
  return { ok: true, router };
});

async function customerAction(c, action, body = {}, user = 'system') {
  switch (action) {
    case 'disable': c.disabled = true; break;
    case 'enable': c.disabled = false; break;
    case 'extend': {
      const days = Number(body.days || 0);
      if (body.expiresAt) c.expiresAt = iso(body.expiresAt);
      else { const base = c.expiresAt && new Date(c.expiresAt) > now() ? new Date(c.expiresAt) : now(); c.expiresAt = iso(base.getTime() + days * 864e5); }
      break;
    }
    case 'expire': c.expiresAt = iso(now()); break;
    case 'kick': {
      const site = siteOf(c);
      const op = c.connectionType === 'hotspot' ? { menu: '/ip/hotspot/active', action: 'remove', find: { user: c.username } } : { menu: '/ppp/active', action: 'remove', find: { name: c.username } };
      c.online = false;
      return applyOps(site, [op], `Disconnect ${c.accountNo}`, { customerId: c.id });
    }
    case 'sms': return sendSms(c.phone, render(need(body.message, 'Message required'), c), c.id, 'manual');
    case 'resync': break;
    case 'reset-password': {
      c.password = rand(8);
      db.save();
      logActivity(c, 'reset-password', 'New password generated', user);
      const r = await provision(c, `New password for ${c.accountNo}`);
      if (body.notify !== false) smsTemplate(c, 'credentials', {}, body.channel);
      return r;
    }
    case 'send-credentials':
      logActivity(c, 'send-credentials', `via ${body.channel || settings().messaging.defaultChannel}`, user);
      return sendSms(numbersOf(c), render(settings().smsTemplates.credentials, c), c.id, 'credentials', body.channel);
    case 'adjust-balance': {
      const amount = Number(need(body.amount, 'Amount required'));
      c.balance = Number(c.balance || 0) + amount;
      db.insert('adjustments', { customerId: c.id, amount, note: body.note || '', by: user, balanceAfter: c.balance });
      logActivity(c, 'adjust-balance', `${amount > 0 ? '+' : ''}${amount} (${body.note || 'no note'}) -> balance ${c.balance}`, user);
      db.save();
      return null;
    }
    case 'stk': {
      const pkg = pkgOf(c);
      logActivity(c, 'stk-request', `M-Pesa request ${body.amount || pkg?.price} to ${body.phone || c.phone}`, user);
      return startPayment({ phone: body.phone || c.phone, amount: Number(body.amount || pkg?.price), purpose: 'account', payload: { customerId: c.id, by: user }, reference: c.accountNo, description: 'Internet' });
    }
    case 'note': logActivity(c, 'note', need(body.text, 'Note text required'), user); return null;
    case 'delete': { const r = await deprovision(c, `Delete customer ${c.accountNo}`); db.remove('customers', c.id); return r; }
    default: throw new HttpError(400, 'Unknown action ' + action);
  }
  const prev = c.status;
  c.status = computeStatus(c);
  db.save();
  if (prev !== c.status && c.status === 'expired') smsTemplate(c, 'expired');
  logActivity(c, action, action === 'extend' ? `expiry -> ${c.expiresAt}` : '', user);
  return provision(c, `${action} ${c.accountNo}`);
}
app.post('/api/customers/:id/action/:action', async req => {
  const c = db.get('customers', req.params.id);
  if (!c) throw new HttpError(404, 'Customer not found');
  const router = await customerAction(c, req.params.action, req.body, req.user.username);
  return { customer: db.get('customers', c.id) ? decorate(c) : null, router };
});
app.post('/api/customers/bulk', async req => {
  const ids = (req.body.ids || []).map(Number);
  let ok = 0, failed = 0;
  for (const id of ids) {
    const c = db.get('customers', id);
    if (!c) continue;
    try { const r = await customerAction(c, req.body.action, req.body, req.user.username); if (r && r.ok === false) failed++; else ok++; } catch { failed++; }
  }
  return { ok, failed };
});

// --- fiber link to SmartOLT
async function smartolt(pathname, opts = {}) {
  const s = settings().smartolt || {};
  if (!s.url) throw new HttpError(400, 'SmartOLT is not configured (Settings > Integrations)');
  let r;
  try {
    r = await fetch(s.url.replace(/\/$/, '') + pathname, {
      method: opts.method || 'GET', headers: { 'X-Token': s.token || '', 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(6000),
    });
  } catch (e) { throw new HttpError(502, `Cannot reach SmartOLT at ${s.url}: ${e.message}`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === false) throw new HttpError(502, 'SmartOLT: ' + (j.error || r.status));
  return j;
}
app.get('/api/customers/:id/onu', async req => {
  const c = db.get('customers', req.params.id);
  if (!c?.onuSn) return { linked: false };
  const d = await smartolt(`/api/onu/get_onu_details/${encodeURIComponent(c.onuSn)}`);
  return { linked: true, onu: d.onu_details };
});
app.post('/api/customers/:id/onu/:action', async req => {
  const c = db.get('customers', req.params.id);
  if (!c?.onuSn) throw new HttpError(400, 'No ONU linked');
  const map = { reboot: 'reboot', resync: 'resync_config', enable: 'enable', disable: 'disable' };
  if (!map[req.params.action]) throw new HttpError(400, 'Unknown ONU action');
  return smartolt(`/api/onu/${map[req.params.action]}/${encodeURIComponent(c.onuSn)}`, { method: 'POST' });
});
app.get('/api/smartolt/onus', async () => smartolt('/api/onu/get_all_onus_details'));
app.get('/api/smartolt/unconfigured', async () => smartolt('/api/onu/unconfigured_onus'));

// ---------------------------------------------------------------- payments, expenses
app.get('/api/payments', req => {
  const { from, to, method, search } = req.query;
  return db.col('payments').filter(p =>
    (!from || p.createdAt >= from) && (!to || p.createdAt <= to + 'T23:59:59') && (!method || p.method === method) &&
    (!search || [p.customerName, p.accountNo, p.reference].some(v => String(v || '').toLowerCase().includes(search.toLowerCase())))).slice().reverse();
});
app.post('/api/payments', async req => applyPayment({ ...req.body, by: req.user.username }));
app.delete('/api/payments/:id', req => { db.remove('payments', req.params.id); return { ok: true }; });

app.get('/api/expenses', () => db.col('expenses').slice().reverse());
app.post('/api/expenses', req => { need(req.body.amount, 'Amount required'); return db.insert('expenses', { category: req.body.category || 'Other', amount: Number(req.body.amount), note: req.body.note || '', date: req.body.date || iso(now()).slice(0, 10), by: req.user.username }); });
app.delete('/api/expenses/:id', req => { db.remove('expenses', req.params.id); return { ok: true }; });

// ---------------------------------------------------------------- vouchers
app.get('/api/vouchers', req => db.col('vouchers').filter(v => (!req.query.status || v.status === req.query.status) && (!req.query.batch || v.batch === req.query.batch))
  .map(v => ({ ...v, packageName: db.get('packages', v.packageId)?.name, price: db.get('packages', v.packageId)?.price, siteName: db.get('sites', v.siteId)?.name })).reverse());
app.post('/api/vouchers/generate', async req => {
  const pkg = db.get('packages', req.body.packageId);
  const site = db.get('sites', req.body.siteId);
  if (!pkg || pkg.type !== 'hotspot') throw new HttpError(400, 'Choose a hotspot package');
  if (!site) throw new HttpError(400, 'Choose a site');
  const count = Math.min(Number(req.body.count || 10), 500);
  const len = Math.min(Math.max(Number(req.body.length || 6), 4), 12);
  const batch = `B${Date.now().toString(36).toUpperCase()}`;
  const created = [];
  for (let i = 0; i < count; i++) {
    let code;
    do { code = (req.body.prefix || '') + rand(len, req.body.numeric === 'true' || req.body.numeric === true ? '0123456789' : 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); } while (db.findOne('vouchers', v => v.code === code));
    created.push(db.insert('vouchers', { code, packageId: pkg.id, siteId: site.id, batch, status: 'unused' }));
  }
  const ops = P.packageOps(pkg, policyOf(pkg), site);
  created.forEach(v => ops.push(...P.voucherOps(v, pkg, policyOf(pkg), site, 'activate').slice(-1)));
  const router = await applyOps(site, ops, `Generate ${count} vouchers (${batch})`);
  return { batch, vouchers: created, router: { ...router, ops: router.ops.slice(0, 6) } };
});
async function useVoucher(v, mac) {
  const pkg = db.get('packages', v.packageId);
  v.status = 'used'; v.usedAt = iso(now()); v.usedBy = fmtMac(mac) || 'manual'; v.expiresAt = iso(Date.now() + P.validityMs(pkg));
  db.insert('payments', { customerId: null, customerName: `Voucher ${v.code}`, accountNo: '-', amount: pkg.price, method: 'voucher', reference: v.code, periods: 1, packageName: pkg.name, by: 'portal' });
  db.save();
}
app.post('/api/vouchers/:id/use', async req => { const v = db.get('vouchers', req.params.id); if (!v || v.status !== 'unused') throw new HttpError(400, 'Voucher not usable'); await useVoucher(v, req.body.mac); return v; });
app.delete('/api/vouchers/:id', async req => {
  const v = db.get('vouchers', req.params.id);
  if (!v) throw new HttpError(404, 'Not found');
  const site = db.get('sites', v.siteId), pkg = db.get('packages', v.packageId);
  if (site && pkg) await applyOps(site, P.voucherOps(v, pkg, null, site, 'delete'), `Delete voucher ${v.code}`);
  db.remove('vouchers', v.id);
  return { ok: true };
});

// ---------------------------------------------------------------- leads, tickets
app.get('/api/leads', () => db.col('leads').slice().reverse());
app.post('/api/leads', req => { need(req.body.name, 'Name required'); return db.insert('leads', { status: 'new', ...pick(req.body, ['name', 'phone', 'email', 'location', 'source', 'interest', 'notes', 'status']) }); });
app.put('/api/leads/:id', req => db.update('leads', req.params.id, pick(req.body, ['name', 'phone', 'email', 'location', 'source', 'interest', 'notes', 'status'])));
app.delete('/api/leads/:id', req => { db.remove('leads', req.params.id); return { ok: true }; });

app.get('/api/tickets', () => db.col('tickets').map(t => ({ ...t, customerName: db.get('customers', t.customerId)?.name || '-' })).reverse());
app.get('/api/tickets/:id', req => { const t = db.get('tickets', req.params.id); if (!t) throw new HttpError(404, 'Not found'); return { ...t, customer: t.customerId ? decorate(db.get('customers', t.customerId) || {}) : null }; });
app.post('/api/tickets', req => {
  need(req.body.subject, 'Subject required');
  const t = db.insert('tickets', { number: `TK${1000 + db.col('tickets').length + 1}`, status: 'open', priority: 'medium', comments: [], ...pick(req.body, ['subject', 'description', 'category', 'priority', 'assignedTo']), customerId: req.body.customerId ? Number(req.body.customerId) : null, openedBy: req.user.username });
  const c = t.customerId && db.get('customers', t.customerId);
  if (c) smsTemplate(c, 'ticket', { ticket: t.number });
  return t;
});
app.put('/api/tickets/:id', req => db.update('tickets', req.params.id, pick(req.body, ['subject', 'description', 'category', 'priority', 'assignedTo', 'status'])));
app.post('/api/tickets/:id/comments', req => {
  const t = db.get('tickets', req.params.id);
  if (!t) throw new HttpError(404, 'Not found');
  t.comments.push({ by: req.user.username, text: need(req.body.text, 'Text required'), at: iso(now()) });
  if (req.body.status) t.status = req.body.status;
  db.save();
  return t;
});
app.delete('/api/tickets/:id', req => { db.remove('tickets', req.params.id); return { ok: true }; });

// ---------------------------------------------------------------- sms, logs, users, settings
app.get('/api/sms', () => db.col('sms').slice(-300).reverse());
app.post('/api/sms/send', req => {
  const msg = need(req.body.message, 'Message required');
  let targets = [];
  if (req.body.group) targets = db.col('customers').filter(c => req.body.group === 'all' || computeStatus(c) === req.body.group);
  else if (req.body.customerIds) targets = req.body.customerIds.map(id => db.get('customers', id)).filter(Boolean);
  if (targets.length) targets.forEach(c => sendSms(c.phone, render(msg, c), c.id, 'bulk'));
  else sendSms(need(req.body.to, 'Recipient required'), msg, null, 'manual');
  return { sent: targets.length || 1 };
});
app.get('/api/logs', req => db.col('routerLogs').filter(l => !req.query.siteId || l.siteId === Number(req.query.siteId)).slice(-300).reverse());
app.delete('/api/logs', () => { db.data.routerLogs = []; db.save(); return { ok: true }; });

app.get('/api/users', () => db.col('users').map(safeUser));
app.post('/api/users', req => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Admins only');
  need(req.body.username, 'Username required'); need(req.body.password, 'Password required');
  if (db.findOne('users', u => u.username === req.body.username)) throw new HttpError(400, 'Username taken');
  return safeUser(db.insert('users', { username: req.body.username, name: req.body.name, phone: req.body.phone, role: req.body.role || 'support', passwordHash: hashPw(req.body.password) }));
});
app.put('/api/users/:id', req => {
  if (req.user.role !== 'admin' && req.user.id !== Number(req.params.id)) throw new HttpError(403, 'Admins only');
  const patch = pick(req.body, ['name', 'phone', 'role']);
  if (req.body.password) patch.passwordHash = hashPw(req.body.password);
  return safeUser(db.update('users', req.params.id, patch));
});
app.delete('/api/users/:id', req => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Admins only');
  if (req.user.id === Number(req.params.id)) throw new HttpError(400, 'You cannot delete yourself');
  db.remove('users', req.params.id);
  return { ok: true };
});

app.get('/api/settings', () => settings());
app.put('/api/settings', req => {
  const s = settings();
  const b = req.body;
  for (const k of ['companyName', 'currency', 'paybill', 'accountPrefix', 'expiredAction', 'reminderDays', 'serverIp', 'apiToken', 'smsEnabled']) if (b[k] !== undefined) s[k] = b[k];
  s.smsEnabled = s.smsEnabled === true || s.smsEnabled === 'true';
  s.reminderDays = Number(s.reminderDays);
  if (b.smsTemplates) s.smsTemplates = { ...s.smsTemplates, ...b.smsTemplates };
  if (b.smartolt) s.smartolt = { ...s.smartolt, ...b.smartolt };
  if (b.mpesa) { s.mpesa = { ...s.mpesa, ...b.mpesa }; s.mpesa.c2bRejectUnknown = s.mpesa.c2bRejectUnknown === true || s.mpesa.c2bRejectUnknown === 'true'; }
  if (b.messaging) {
    const m = b.messaging;
    s.messaging = { ...s.messaging, ...m, sms: { ...s.messaging.sms, ...(m.sms || {}) }, whatsapp: { ...s.messaging.whatsapp, ...(m.whatsapp || {}) } };
    s.messaging.sms.sandbox = s.messaging.sms.sandbox === true || s.messaging.sms.sandbox === 'true';
    s.messaging.whatsapp.templateHasParam = s.messaging.whatsapp.templateHasParam === true || s.messaging.whatsapp.templateHasParam === 'true';
  }
  db.save();
  return s;
});
app.post('/api/settings/smartolt/test', async () => { const j = await smartolt('/api/system/get_olts'); return { ok: true, olts: j.response.length }; });
app.post('/api/settings/reset', req => {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Admins only');
  const fresh = new Store(db.file + '.reset', seed.seed);
  db.data = fresh.data; db.flush(); require('fs').unlinkSync(fresh.file);
  sessions.clear();
  return { ok: true };
});

// ---------------------------------------------------------------- M-Pesa payment engine
// Every STK push is stored in the "mpesa" collection. Its result arrives either through the Daraja callback
// (needs a public https URL, e.g. a cloudflared/ngrok tunnel) or through polling the STK query API
// (works on a home PC with no public URL). Whichever comes first completes the payment exactly once.
let _mp = null, _mpKey = '';
function mp() {
  const cfg = settings().mpesa;
  const key = JSON.stringify(cfg);
  if (key !== _mpKey) { _mp = new Mpesa(cfg); _mpKey = key; }
  return _mp;
}
const publicTxn = r => ({ id: r.token, status: r.status, message: r.message, amount: r.amount, phone: r.phone, mode: r.mode, result: r.status === 'success' ? r.result : undefined });
const RECEIPT_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

async function startPayment({ phone, amount, purpose, payload = {}, reference, description }) {
  let msisdn;
  try { msisdn = normalizePhone(need(phone, 'Enter your M-Pesa phone number')); } catch (e) { throw new HttpError(400, e.message); }
  amount = Math.ceil(Number(amount));
  if (!(amount >= 1)) throw new HttpError(400, 'Amount must be at least 1');
  const cfg = settings().mpesa;
  const rec = db.insert('mpesa', { kind: 'stk', token: rand(20), mode: cfg.mode, purpose, phone: msisdn, amount, reference, payload, customerId: payload.customerId || null, status: 'pending', message: '' });
  if (cfg.mode === 'simulate') {
    rec.message = `Simulated STK push to ${msisdn}: it auto-approves in 4 seconds. (Settings > M-Pesa to use the real Daraja sandbox)`;
    setTimeout(() => completePayment(rec, { receipt: 'SIM' + rand(7, RECEIPT_CHARS) }), 4000);
    db.save();
    return publicTxn(rec);
  }
  const callbackUrl = cfg.callbackBase ? cfg.callbackBase.replace(/\/$/, '') + '/api/portal/mpesa/callback' : 'https://example.com/oneisp-no-callback';
  try {
    const r = await mp().stkPush({ phone: msisdn, amount, reference, description, callbackUrl });
    Object.assign(rec, { checkoutRequestId: r.CheckoutRequestID, merchantRequestId: r.MerchantRequestID, message: `${r.CustomerMessage || 'Request sent'} - check your phone and enter your M-Pesa PIN.`, request: { callbackUrl, reference, at: iso(now()) } });
  } catch (e) {
    Object.assign(rec, { status: 'failed', message: 'M-Pesa: ' + e.message, error: e.body || e.message });
    db.save();
    throw new HttpError(502, rec.message);
  }
  db.save();
  return publicTxn(rec);
}

async function completePayment(rec, { receipt, callback } = {}) {
  if (rec.status !== 'pending') return;
  rec.status = 'processing';
  rec.receipt = receipt;
  if (callback) rec.callback = callback;
  try {
    rec.result = await FULFIL[rec.purpose](rec, receipt);
    rec.status = 'success';
    rec.message = rec.result.message;
  } catch (e) {
    rec.status = 'error';
    rec.message = 'Payment received but could not be applied: ' + e.message;
    console.error('fulfilment failed', e);
  }
  rec.completedAt = iso(now());
  db.save();
}
function failPayment(rec, code, desc) {
  if (rec.status !== 'pending') return;
  Object.assign(rec, { status: Number(code) === 1032 ? 'cancelled' : 'failed', resultCode: Number(code), message: RESULT_CODES[code] || desc || 'Payment failed', completedAt: iso(now()) });
  db.save();
}

const FULFIL = {
  // Customer account renewal (portal, admin "request payment", reminders)
  account: async (rec, receipt) => {
    const r = await applyPayment({ customerId: rec.customerId, amount: rec.amount, method: 'mpesa', reference: receipt, by: rec.payload.by || 'mpesa', note: `STK ${rec.phone}` });
    return { expiresAt: r.customer.expiresAt, message: `Payment of ${settings().currency} ${rec.amount} received (${receipt}). Active until ${new Date(r.customer.expiresAt).toLocaleString()}.` };
  },
  // Hotspot purchase: create/renew a hotspot account whose username and password are one short code
  hotspot: async (rec, receipt) => {
    const site = db.get('sites', rec.payload.siteId), pkg = db.get('packages', rec.payload.packageId);
    if (!site || !pkg) throw new Error('Site or package no longer exists');
    const mac = fmtMac(rec.payload.mac);
    let c = db.findOne('customers', x => x.connectionType === 'hotspot' && x.siteId === site.id && x.phone === rec.phone);
    if (!c) {
      let code;
      do { code = rand(6, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'); } while (db.findOne('customers', x => x.username === code) || db.findOne('vouchers', v => v.code === code));
      c = createCustomerRecord({ name: `Hotspot ${rec.phone}`, phone: rec.phone, whatsapp: rec.phone, connectionType: 'hotspot', siteId: site.id, packageId: pkg.id, username: code, password: code, lastMac: mac });
      logActivity(c, 'created', 'Self sign-up on hotspot portal', 'hotspot-portal');
    } else {
      if (c.packageId !== pkg.id) { c.packageId = pkg.id; c._profileChanged = true; }
      if (computeStatus(c) !== 'active') c.expiresAt = null; // a new purchase starts now, not from an old expiry
      c.lastMac = mac;
    }
    await applyPayment({ customerId: c.id, amount: rec.amount, method: 'mpesa', reference: receipt, by: 'hotspot-portal', silent: true });
    delete c._profileChanged;
    const m = settings().messaging;
    sendSms(numbersOf(c), render(settings().smsTemplates.hotspotCode, c, { code: c.username, site: site.name, receipt }), c.id, 'hotspot-code', m.hotspotChannel);
    return { username: c.username, password: c.password, code: c.username, expiresAt: c.expiresAt, sentVia: m.hotspotChannel, message: `Paid (${receipt}). Your WiFi code is ${c.username} - also sent to ${rec.phone} by ${m.hotspotChannel}.` };
  },
};

// Poll Daraja for pending STK pushes (no public URL needed).
let polling = false;
async function pollMpesa() {
  if (polling) return;
  polling = true;
  try {
    for (const rec of db.find('mpesa', r => r.kind === 'stk' && r.status === 'pending' && r.mode !== 'simulate' && r.checkoutRequestId)) {
      const age = Date.now() - new Date(rec.createdAt);
      if (age > 180000) { failPayment(rec, 1037, 'Timed out waiting for the customer'); continue; }
      if (age < 8000 || (rec.lastQueryAt && Date.now() - new Date(rec.lastQueryAt) < 6000)) continue;
      rec.lastQueryAt = iso(now());
      try {
        const q = await mp().stkQuery(rec.checkoutRequestId);
        rec.query = q;
        const code = q.ResultCode !== undefined ? Number(q.ResultCode) : NaN;
        if (code === 0) await completePayment(rec, { receipt: 'STK' + rec.checkoutRequestId.slice(-8).toUpperCase() });
        else if (!Number.isNaN(code)) failPayment(rec, code, q.ResultDesc);
      } catch (e) {
        // 500.001.1001 = "The transaction is being processed" -> still waiting for the PIN
        if (e.code !== '500.001.1001' && !/being processed/i.test(e.message)) rec.lastError = e.message;
      }
    }
  } finally { polling = false; }
}

// --- Daraja callbacks (public). Point Settings > M-Pesa > Public base URL at a tunnel to this server.
app.post('/api/portal/mpesa/callback', async req => {
  const cb = req.body?.Body?.stkCallback;
  db.insert('mpesaCallbacks', { kind: 'stk', body: req.body });
  db.trim('mpesaCallbacks', 500);
  if (!cb) return { ResultCode: 0, ResultDesc: 'Accepted' };
  const rec = db.findOne('mpesa', r => r.checkoutRequestId === cb.CheckoutRequestID);
  if (!rec) return { ResultCode: 0, ResultDesc: 'Accepted' };
  const meta = Object.fromEntries((cb.CallbackMetadata?.Item || []).map(i => [i.Name, i.Value]));
  if (Number(cb.ResultCode) === 0) {
    const receipt = meta.MpesaReceiptNumber || 'STK' + rec.checkoutRequestId.slice(-8).toUpperCase();
    if (rec.status === 'pending') await completePayment(rec, { receipt, callback: cb });
    else if (rec.status === 'success' && rec.receipt !== receipt) {
      // polling completed it first with a placeholder - swap in the real M-Pesa receipt number
      const pay = db.findOne('payments', p => p.reference === rec.receipt);
      if (pay) pay.reference = receipt;
      rec.receipt = receipt; rec.callback = cb;
      db.save();
    }
  } else failPayment(rec, cb.ResultCode, cb.ResultDesc);
  return { ResultCode: 0, ResultDesc: 'Accepted' };
});
// C2B: customer pays to the paybill from the M-Pesa menu using their account number.
app.post('/api/portal/mpesa/c2b/validation', req => {
  const ref = String(req.body.BillRefNumber || '').trim().toLowerCase();
  const ok = !settings().mpesa.c2bRejectUnknown || db.findOne('customers', c => c.accountNo.toLowerCase() === ref || c.username.toLowerCase() === ref);
  return ok ? { ResultCode: 0, ResultDesc: 'Accepted' } : { ResultCode: 'C2B00012', ResultDesc: 'Invalid Account Number' };
});
app.post('/api/portal/mpesa/c2b/confirmation', async req => {
  const b = req.body || {};
  if (db.findOne('mpesa', r => r.kind === 'c2b' && r.receipt === b.TransID)) return { ResultCode: 0, ResultDesc: 'Accepted' };
  const ref = String(b.BillRefNumber || '').trim().toLowerCase();
  const phone = String(b.MSISDN || '');
  // match the account number first; fall back to the phone only when exactly one (non-hotspot) customer has it
  const byPhone = phone.length > 9 ? db.find('customers', x => x.connectionType !== 'hotspot' && (() => { try { return normalizePhone(x.phone) === phone; } catch { return false; } })()) : [];
  const c = db.findOne('customers', x => x.accountNo.toLowerCase() === ref || x.username.toLowerCase() === ref) || (byPhone.length === 1 ? byPhone[0] : null);
  const rec = db.insert('mpesa', { kind: 'c2b', mode: settings().mpesa.mode, purpose: 'account', phone, amount: Number(b.TransAmount), reference: b.BillRefNumber, receipt: b.TransID, payer: [b.FirstName, b.MiddleName, b.LastName].filter(Boolean).join(' '), customerId: c?.id || null, status: c ? 'success' : 'unmatched', callback: b, message: c ? '' : `No customer with account "${b.BillRefNumber}" - allocate it manually` });
  if (c) { const r = await applyPayment({ customerId: c.id, amount: rec.amount, method: 'mpesa', reference: b.TransID, by: 'mpesa-c2b', note: `Paybill from ${rec.payer || phone}` }); rec.message = `Applied to ${c.accountNo}, expiry ${r.customer.expiresAt}`; db.save(); }
  return { ResultCode: 0, ResultDesc: 'Accepted' };
});

// --- admin M-Pesa endpoints
app.get('/api/mpesa', req => db.col('mpesa').filter(r => !req.query.status || r.status === req.query.status).slice(-500).reverse().map(r => ({ ...r, customerName: r.customerId ? db.get('customers', r.customerId)?.name : null })));
app.get('/api/mpesa/callbacks', () => db.col('mpesaCallbacks').slice(-100).reverse());
app.post('/api/mpesa/test', async () => {
  const cfg = settings().mpesa;
  if (cfg.mode === 'simulate') return { ok: true, message: 'Mode is "simulate" - no connection needed. Switch to sandbox to test your Daraja keys.' };
  _mpKey = '';
  const t = await mp().token().catch(e => { throw new HttpError(502, e.message); });
  return { ok: true, message: `Connected to Daraja ${cfg.mode}. Access token ${t.slice(0, 6)}... received.` };
});
app.post('/api/mpesa/stk', async req => startPayment({ phone: req.body.phone, amount: req.body.amount, purpose: req.body.customerId ? 'account' : 'test', payload: { customerId: req.body.customerId ? Number(req.body.customerId) : null, by: req.user.username }, reference: req.body.reference || 'TEST', description: 'Test' }));
FULFIL.test = async (rec, receipt) => ({ message: `Test payment of ${rec.amount} received (${receipt})` });
app.post('/api/mpesa/:id/recheck', async req => { const r = db.get('mpesa', req.params.id); if (!r) throw new HttpError(404, 'Not found'); r.lastQueryAt = null; r.createdAt = r.createdAt; await pollMpesa(); return r; });
app.post('/api/mpesa/:id/allocate', async req => {
  const r = db.get('mpesa', req.params.id);
  const c = db.get('customers', req.body.customerId);
  if (!r || r.status !== 'unmatched') throw new HttpError(400, 'Only unmatched C2B payments can be allocated');
  if (!c) throw new HttpError(400, 'Choose a customer');
  const res = await applyPayment({ customerId: c.id, amount: r.amount, method: 'mpesa', reference: r.receipt, by: req.user.username, note: 'Manually allocated C2B' });
  Object.assign(r, { status: 'success', customerId: c.id, message: `Allocated to ${c.accountNo} by ${req.user.username}` });
  db.save();
  return res;
});
app.post('/api/mpesa/c2b/register', async () => {
  const cfg = settings().mpesa;
  if (!cfg.callbackBase) throw new HttpError(400, 'Set "Public base URL" first (a https tunnel to this server)');
  const base = cfg.callbackBase.replace(/\/$/, '');
  return mp().c2bRegister({ confirmationUrl: base + '/api/portal/mpesa/c2b/confirmation', validationUrl: base + '/api/portal/mpesa/c2b/validation' }).catch(e => { throw new HttpError(502, e.message); });
});
app.post('/api/mpesa/c2b/simulate', async req => {
  if (settings().mpesa.mode === 'simulate') {
    // no Daraja: feed our own confirmation endpoint, exactly what Safaricom would POST
    const body = { TransactionType: 'Pay Bill', TransID: 'SIM' + rand(7, RECEIPT_CHARS), TransTime: require('./mpesa').timestamp(), TransAmount: String(req.body.amount), BusinessShortCode: settings().mpesa.shortcode, BillRefNumber: req.body.billRef, MSISDN: normalizePhone(req.body.phone || '254708374149'), FirstName: 'John', LastName: 'Doe' };
    const r = await fetch(`http://127.0.0.1:${PORT}/api/portal/mpesa/c2b/confirmation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { simulated: true, sent: body, response: await r.json() };
  }
  return mp().c2bSimulate({ amount: req.body.amount, phone: req.body.phone || '254708374149', billRef: req.body.billRef }).catch(e => { throw new HttpError(502, e.message); });
});
app.post('/api/messaging/test', req => {
  const rec = sendSms(need(req.body.to, 'Enter a phone number'), req.body.message || `Test message from ${settings().companyName} (OneISP simulator)`, null, 'test', req.body.channel);
  return { ok: true, id: rec?.id };
});
app.get('/api/sms/:id', req => db.get('sms', req.params.id) || {});

// ---------------------------------------------------------------- customer portals (public)
app.get('/api/portal/site/:id', req => {
  const s = siteOr404(req.params.id);
  return { site: { id: s.id, name: s.name }, company: settings().companyName, currency: settings().currency, paybill: settings().paybill, mpesaMode: settings().mpesa.mode, sendVia: settings().messaging.hotspotChannel, packages: db.find('packages', p => p.type === 'hotspot' && p.public !== false) };
});
app.post('/api/portal/hotspot/pay', async req => {
  const site = siteOr404(req.body.siteId);
  const pkg = db.get('packages', req.body.packageId);
  if (!pkg || pkg.type !== 'hotspot') throw new HttpError(400, 'Choose a package');
  return startPayment({ phone: req.body.phone, amount: pkg.price, purpose: 'hotspot', payload: { siteId: site.id, packageId: pkg.id, mac: req.body.mac, ip: req.body.ip }, reference: 'WIFI', description: pkg.name });
});
app.get('/api/portal/txn/:id', req => { const t = db.findOne('mpesa', r => r.token === req.params.id); if (!t) throw new HttpError(404, 'Unknown transaction'); return publicTxn(t); });
// One box on the portal accepts both printed vouchers and codes bought with M-Pesa.
app.post('/api/portal/voucher', async req => {
  const code = String(need(req.body.code, 'Enter your code')).trim().toUpperCase();
  const v = db.findOne('vouchers', x => x.code.toUpperCase() === code);
  if (v) {
    if (v.status === 'expired' || (v.expiresAt && new Date(v.expiresAt) < now())) throw new HttpError(400, 'Voucher expired');
    if (v.status === 'unused') await useVoucher(v, req.body.mac);
    return { username: v.code, password: v.code, expiresAt: v.expiresAt };
  }
  const c = db.findOne('customers', x => x.connectionType === 'hotspot' && x.username.toUpperCase() === code);
  if (!c) throw new HttpError(400, 'Invalid code');
  if (computeStatus(c) !== 'active') throw new HttpError(400, `Code ${code} has expired - buy a new package`);
  return { username: c.username, password: c.password, expiresAt: c.expiresAt };
});
app.post('/api/portal/hotspot/resend', req => {
  let phone;
  try { phone = normalizePhone(need(req.body.phone, 'Enter the phone number you paid with')); } catch (e) { throw new HttpError(400, e.message); }
  const c = db.findOne('customers', x => x.connectionType === 'hotspot' && x.siteId === Number(req.body.siteId) && x.phone === phone && computeStatus(x) === 'active');
  if (!c) throw new HttpError(404, 'No active WiFi package for that number');
  const site = siteOf(c);
  sendSms(numbersOf(c), render(settings().smsTemplates.hotspotCode, c, { code: c.username, site: site?.name, receipt: '-' }), c.id, 'hotspot-code', settings().messaging.hotspotChannel);
  return { message: `Code re-sent to ${phone} by ${settings().messaging.hotspotChannel}` };
});
function findAccount(key) {
  key = String(need(key, 'Enter account number')).trim().toLowerCase();
  let p = null; try { p = normalizePhone(key); } catch { /* not a phone */ }
  return db.findOne('customers', x => x.accountNo.toLowerCase() === key || x.username.toLowerCase() === key || (p && (() => { try { return normalizePhone(x.phone) === p; } catch { return false; } })()));
}
app.post('/api/portal/account', req => {
  const c = findAccount(req.body.account);
  if (!c) throw new HttpError(404, 'Account not found');
  const d = decorate(c);
  return { accountNo: d.accountNo, name: d.name, packageName: d.packageName, price: d.price, status: d.status, expiresAt: d.expiresAt, balance: d.balance, currency: settings().currency, paybill: settings().paybill, phone: d.phone, mpesaMode: settings().mpesa.mode,
    payments: db.find('payments', p => p.customerId === c.id).slice(-5).reverse().map(p => ({ date: p.createdAt, amount: p.amount, reference: p.reference })) };
});
app.post('/api/portal/account/pay', async req => {
  const c = findAccount(req.body.account);
  if (!c) throw new HttpError(404, 'Account not found');
  return startPayment({ phone: req.body.phone || c.phone, amount: Number(req.body.amount || pkgOf(c)?.price), purpose: 'account', payload: { customerId: c.id, by: 'customer-portal' }, reference: c.accountNo, description: 'Internet' });
});

// ---------------------------------------------------------------- public API v1 (used by SmartOLT)
const apiCustomer = c => { const d = decorate(c); return { id: d.id, account_no: d.accountNo, name: d.name, phone: d.phone, address: d.address, location: d.location, connection_type: d.connectionType, username: d.username, password: d.password, package: d.packageName, status: d.status, expires_at: d.expiresAt, onu_sn: d.onuSn || null, site: d.siteName }; };
app.get('/api/v1/customers', req => {
  const s = (req.query.search || '').toLowerCase();
  return { status: true, response: db.col('customers').filter(c => !s || [c.name, c.accountNo, c.username, c.phone].some(v => String(v || '').toLowerCase().includes(s))).map(apiCustomer) };
});
app.get('/api/v1/customers/:id', req => { const c = db.get('customers', req.params.id); if (!c) throw new HttpError(404, 'Not found'); return { status: true, response: apiCustomer(c) }; });
app.post('/api/v1/customers/:id/onu', req => {
  const c = db.get('customers', req.params.id);
  if (!c) throw new HttpError(404, 'Not found');
  c.onuSn = req.body.sn || null;
  db.save();
  return { status: true, response: apiCustomer(c) };
});

// ---------------------------------------------------------------- background jobs
// Simulated routers: pretend most active customers are connected so /ppp active etc. look real.
function simulateSessions(site) {
  const st = routerFor(site).state;
  const slot = Math.floor(Date.now() / 6e5);
  const keep = { '/ppp/active': [], '/ip/hotspot/active': [] };
  const prev = { '/ppp/active': st['/ppp/active'] || [], '/ip/hotspot/active': st['/ip/hotspot/active'] || [] };
  for (const c of db.find('customers', c => c.siteId === site.id && computeStatus(c) === 'active')) {
    const h = crypto.createHash('md5').update(`${c.id}:${slot}`).digest()[0];
    if (h % 10 >= 8) continue; // ~20% offline at any time
    const ip = c.ipAddress || `10.10.${(c.id >> 8) & 255}.${(c.id % 250) + 2}`;
    if (c.connectionType === 'pppoe') {
      const old = prev['/ppp/active'].find(r => r.name === c.username);
      keep['/ppp/active'].push(old || { '.id': `*${(c.id + 0x100).toString(16).toUpperCase()}`, name: c.username, service: 'pppoe', 'caller-id': c.macAddress || 'AA:BB:CC:' + c.accountNo.slice(-4).replace(/(..)(..)/, '$1:$2') + ':01', address: ip, 'login-at': Date.now() });
    } else if (c.connectionType === 'hotspot') {
      const old = prev['/ip/hotspot/active'].find(r => r.user === c.username);
      keep['/ip/hotspot/active'].push(old || { '.id': `*${(c.id + 0x200).toString(16).toUpperCase()}`, user: c.username, server: site.hotspotServer, address: `${site.hotspotGateway.split('.').slice(0, 3).join('.')}.${(c.id % 200) + 20}`, 'mac-address': c.macAddress || '', 'login-at': Date.now() });
    }
  }
  for (const k of Object.keys(keep)) {
    keep[k].forEach(r => { const s = Math.floor((Date.now() - r['login-at']) / 1000); r.uptime = `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`; });
    st[k] = keep[k];
  }
}

async function syncSite(site) {
  if (site.mode !== 'live') simulateSessions(site);
  const r = routerFor(site);
  let ppp = [], hs = [], arp = [];
  try {
    [ppp, hs, arp] = await Promise.all([r.list('/ppp/active'), r.list('/ip/hotspot/active').catch(() => []), site.mode === 'live' ? r.list('/ip/arp').catch(() => []) : []]);
    if (site.mode === 'live') db.update('sites', site.id, { status: 'online', lastContact: iso(now()), lastError: null });
  } catch (e) {
    db.update('sites', site.id, { status: 'error', lastError: e.message });
    return { ok: false, error: e.message };
  }
  const pppBy = new Map(ppp.map(a => [a.name, a])), hsBy = new Map(hs.map(a => [a.user, a]));
  let online = 0;
  for (const c of db.find('customers', c => c.siteId === site.id)) {
    let sess = null;
    if (c.connectionType === 'pppoe') sess = pppBy.get(c.username);
    else if (c.connectionType === 'hotspot') sess = hsBy.get(c.username);
    else if (site.mode === 'live') {
      const a = arp.find(x => x.address === c.ipAddress && x.complete !== 'false' && x.status !== 'failed');
      sess = a ? { address: c.ipAddress, uptime: '-', 'mac-address': a['mac-address'] } : null;
    } else sess = computeStatus(c) === 'active' && c.id % 5 !== 0 ? { address: c.ipAddress, uptime: '-', 'mac-address': c.macAddress } : null;
    c.online = !!sess;
    if (sess) { online++; c.lastSeen = iso(now()); c.sessionIp = sess.address; c.sessionUptime = sess.uptime; c.sessionMac = sess['caller-id'] || sess['mac-address']; }
  }
  // vouchers seen on the hotspot get marked as used
  for (const v of db.find('vouchers', v => v.siteId === site.id && v.status === 'unused')) if (hsBy.has(v.code)) await useVoucher(v, hsBy.get(v.code)['mac-address']);
  db.save();
  return { ok: true, pppActive: ppp.length, hotspotActive: hs.length, customersOnline: online };
}

async function expiryJob() {
  const s = settings();
  for (const c of db.col('customers').slice()) {
    const st = computeStatus(c);
    if (st !== c.status) {
      const prev = c.status;
      c.status = st;
      db.save();
      if (st === 'expired' && prev === 'active') {
        if (c.connectionType !== 'hotspot') smsTemplate(c, 'expired');
        await provision(c, `Auto-expire ${c.accountNo}`);
      }
    }
    if (st === 'active' && c.connectionType !== 'hotspot' && s.reminderDays > 0 && c.reminderSentFor !== c.expiresAt && new Date(c.expiresAt) - now() < s.reminderDays * 864e5) {
      c.reminderSentFor = c.expiresAt;
      smsTemplate(c, 'reminder');
      db.save();
    }
  }
  for (const v of db.find('vouchers', v => v.status === 'used' && v.expiresAt && new Date(v.expiresAt) < now())) {
    v.status = 'expired';
    const site = db.get('sites', v.siteId), pkg = db.get('packages', v.packageId);
    if (site && pkg) await applyOps(site, P.voucherOps(v, pkg, null, site, 'delete'), `Voucher ${v.code} expired`);
    db.save();
  }
}

let busy = false;
async function tick(full) {
  if (busy) return;
  busy = true;
  try {
    await expiryJob();
    if (full) for (const s of db.col('sites')) await syncSite(s).catch(() => {});
  } catch (e) { console.error('job error', e); } finally { busy = false; }
}

async function bootstrapSimRouters() {
  for (const site of db.col('sites')) {
    if (site.mode === 'live') continue;
    const st = db.obj('simRouters')[site.id];
    if (st && Object.keys(st).length) continue;
    // a freshly seeded simulated router gets the base config plus all customers
    const r = routerFor(site);
    r.state['/interface'] = ['ether1', 'ether2', 'ether3', 'ether4', 'ether5'].map((n, i) => ({ '.id': `*${i + 1}`, name: n, type: 'ether', running: 'true', disabled: 'false', comment: ['WAN', 'PPPoE', 'Hotspot', 'DHCP', 'Static'][i] }));
    r.state['/ip/pool'] = [{ '.id': '*1', name: 'oneisp-pppoe-pool', ranges: site.pppoePool }, { '.id': '*2', name: 'oneisp-hs-pool', ranges: site.hotspotPool }, { '.id': '*3', name: 'oneisp-dhcp-pool', ranges: site.dhcpPool }, { '.id': '*4', name: 'oneisp-expired-pool', ranges: site.expiredPool }];
    r.state['/ppp/profile'] = [{ '.id': '*0', name: 'default' }, { '.id': '*A', name: 'OI-EXPIRED', 'rate-limit': '256k/256k', 'address-list': 'OI-EXPIRED' }];
    r.state['/interface/pppoe-server/server'] = [{ '.id': '*1', 'service-name': 'oneisp', interface: site.pppoeInterface, 'default-profile': 'OI-DEFAULT', disabled: 'false' }];
    r.state['/ip/hotspot'] = [{ '.id': '*1', name: site.hotspotServer, interface: site.hotspotInterface, 'address-pool': 'oneisp-hs-pool', profile: 'oneisp-hsprof' }];
    r.state['/ip/dhcp-server'] = [{ '.id': '*1', name: site.dhcpServer, interface: site.dhcpInterface, 'address-pool': 'oneisp-dhcp-pool' }];
    r.state['/ip/address'] = [['10.0.2.15/24', site.wanInterface], [site.hotspotGateway + '/24', site.hotspotInterface], [site.dhcpGateway + '/24', site.dhcpInterface], [site.staticGateway + '/24', site.staticInterface]].map(([a, i], n) => ({ '.id': `*${n + 1}`, address: a, interface: i }));
    for (const c of db.find('customers', c => c.siteId === site.id)) await provision(c, `Initial sync ${c.accountNo}`);
    for (const v of db.find('vouchers', v => v.siteId === site.id && v.status !== 'expired')) {
      const pkg = db.get('packages', v.packageId);
      await applyOps(site, P.voucherOps(v, pkg, policyOf(pkg), site, 'activate'), `Initial voucher ${v.code}`);
    }
  }
  db.save();
}

bootstrapSimRouters().then(() => tick(true));
setInterval(() => tick(false), 20000);
setInterval(() => pollMpesa().catch(e => console.error('mpesa poll', e)), 4000);
setInterval(() => tick(true), 60000);
process.on('SIGINT', () => { db.flush(); process.exit(0); });
process.on('SIGTERM', () => { db.flush(); process.exit(0); });

app.listen(PORT, HOST, () => console.log(`OneISP simulator running on http://localhost:${PORT}  (login: admin / admin)`));
