// SmartOLT simulator - GPON OLT / ONU management (Huawei & ZTE), integrated with OneISP.
// Run: node smartolt/server.js   then open http://localhost:4000  (login admin / admin)
const path = require('path');
const crypto = require('crypto');
const { createApp, HttpError } = require('../lib/http');
const { Store } = require('../lib/db');
const { oltCommands, oltSetup } = require('./commands');
const { createCli } = require('./cli');
const seed = require('./seed');

const PORT = Number(process.env.SMARTOLT_PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';
const db = new Store(path.join(__dirname, '..', 'data', 'smartolt.json'), seed.seed);
const app = createApp({ publicDir: path.join(__dirname, 'public') });
const settings = () => db.obj('settings', seed.DEFAULT_SETTINGS);
const iso = d => new Date(d).toISOString();
const need = (v, msg) => { if (v === undefined || v === null || v === '') throw new HttpError(400, msg); return v; };
const rnd = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- auth (session cookie for the UI, X-Token for the API)
const sessions = new Set();
app.use(req => {
  if (!req.path.startsWith('/api/') || req.path === '/api/login') return;
  if (sessions.has(req.cookies.sosid)) return;
  const tok = req.headers['x-token'] || req.query.token;
  if (tok && tok === settings().apiToken) { req.apiClient = true; return; }
  throw new HttpError(401, 'Login required (or send X-Token header)');
});
app.post('/api/login', (req, res) => {
  const s = settings();
  if (req.body.username !== s.username || req.body.password !== s.password) throw new HttpError(401, 'Wrong username or password');
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.add(sid);
  res.cookie('sosid', sid);
  return { ok: true, company: s.companyName };
});
app.post('/api/logout', (req, res) => { sessions.delete(req.cookies.sosid); res.cookie('sosid', '', '; Max-Age=0'); return { ok: true }; });
app.get('/api/me', () => ({ user: settings().username, company: settings().companyName }));

// ---------------------------------------------------------------- helpers
function signalLevel(o) {
  if (o.status !== 'online') return 'none';
  const s = settings();
  return o.rxPower < s.signalCritical ? 'critical' : o.rxPower < s.signalWarning ? 'warning' : 'good';
}
const statusOf = o => (o.disabled ? 'disabled' : o.status);
const fmtUptime = o => {
  if (o.status !== 'online' || !o.uptimeStart) return null;
  const s = Math.floor((Date.now() - new Date(o.uptimeStart)) / 1000);
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
function decorate(o, full = false) {
  const olt = db.get('olts', o.oltId), type = db.get('onuTypes', o.onuTypeId);
  const out = {
    ...o, status: statusOf(o), signal: signalLevel(o), oltName: olt?.name, vendor: olt?.vendor, onuTypeName: type?.name || '-',
    zoneName: db.get('zones', o.zoneId)?.name || '-', odbName: db.get('odbs', o.odbId)?.name || '-', uptime: fmtUptime(o),
    downloadName: db.get('speedProfiles', o.downloadProfileId)?.name || '-', uploadName: db.get('speedProfiles', o.uploadProfileId)?.name || '-',
    portName: olt?.portNames?.[`${o.board}/${o.port}`] || '', distanceKm: (o.distance / 1000).toFixed(2),
    pon: olt?.vendor === 'ZTE' ? `gpon-onu_1/${o.board}/${o.port}:${o.onuId}` : `0/${o.board}/${o.port}:${o.onuId}`,
  };
  if (!full) delete out.history;
  return out;
}
function event(type, severity, message, extra = {}) {
  db.insert('events', { type, severity, message, ...extra });
  db.trim('events', 2000);
}
function commandsFor(o, action) {
  const olt = db.get('olts', o.oltId);
  return oltCommands(action, { olt, acs: settings().tr069Url, onu: o, type: db.get('onuTypes', o.onuTypeId), down: db.get('speedProfiles', o.downloadProfileId), up: db.get('speedProfiles', o.uploadProfileId) });
}
function logCli(o, action, commands, via = 'web') {
  const olt = db.get('olts', o.oltId);
  return db.insert('cliLog', { oltId: o.oltId, oltName: olt?.name, onuId: o.id, sn: o.sn, action, via, commands });
}
function nextServicePort(oltId, extra = []) {
  const used = new Set([...db.find('onus', o => o.oltId === oltId).flatMap(o => [o.servicePort, o.mgmtServicePort]), ...extra]);
  let i = 100; while (used.has(i)) i++; return i;
}
function nextOnuId(oltId, board, port) {
  const used = new Set(db.find('onus', o => o.oltId === oltId && o.board === board && o.port === port).map(o => o.onuId));
  let i = 1; while (used.has(i)) i++;
  if (i > 128) throw new HttpError(400, 'PON port is full (128 ONUs)');
  return i;
}
const findOnu = key => {
  const o = /^\d+$/.test(String(key)) ? db.get('onus', key) : db.findOne('onus', x => x.sn === String(key).toUpperCase());
  if (!o) throw new HttpError(404, 'ONU not found');
  return o;
};

// Fields added in later versions get sensible defaults (also used for new ONUs).
const SW = { HG8546M: ['V5R019C10S115', '10C7.A'], EG8145V5: ['V5R020C00S060', '27C7.A'], HG8010H: ['V5R019C00S050', '10D2.A'], HG8247H: ['V3R017C10S206', '3A3.A'], 'ZTE-F660': ['V8.0.10P1N2', 'V6.0'], 'ZTE-F601': ['V6.0.10P3N4', 'V6.0'], 'ZTE-F670L': ['V9.0.11P1N6', 'V9.0'] };
function ensureOnuDefaults(o) {
  const d = { tr069Profile: 'SmartOLT', mgmtMode: 'dhcp', mgmtVlan: 69, mgmtRemote: false, mgmtIp: '', configMethod: 'omci', ipProtocol: 'ipv4', pppoePlus: false, wanRemoteAccess: false, sector: '', preset: '' };
  for (const [k, v] of Object.entries(d)) if (o[k] === undefined) o[k] = v;
  if (o.mgmtServicePort === undefined) o.mgmtServicePort = nextServicePort(o.oltId, [o.servicePort]);
  const t = db.get('onuTypes', o.onuTypeId);
  if (!o.swVersion) [o.swVersion, o.hwVersion] = SW[t?.name] || ['V1.0', '1.0'];
  return o;
}
function disconnections(o) {
  const ev = db.find('events', e => e.onuSn === o.sn && ['los', 'power_fail', 'offline', 'reboot'].includes(e.type));
  const since = ms => ev.filter(e => Date.now() - new Date(e.createdAt) < ms).length;
  return { day: since(864e5), week: since(7 * 864e5) };
}

// ---------------------------------------------------------------- OneISP integration
async function oneisp(pathname, opts = {}) {
  const s = settings().oneisp || {};
  if (!s.url) throw new HttpError(400, 'OneISP is not configured (Settings > General)');
  let r;
  try {
    r = await fetch(s.url.replace(/\/$/, '') + pathname, { method: opts.method || 'GET', headers: { 'X-Token': s.token || '', 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(5000) });
  } catch (e) { throw new HttpError(502, `Cannot reach OneISP at ${s.url}: ${e.message}`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, 'OneISP: ' + (j.error || r.status));
  return j.response;
}
const notifyOneIsp = (externalId, sn) => externalId && oneisp(`/api/v1/customers/${externalId}/onu`, { method: 'POST', body: { sn } }).catch(e => console.log('OneISP notify failed:', e.message));
async function pullFromOneIsp(o) {
  if (!o.externalId) return false;
  const c = await oneisp(`/api/v1/customers/${o.externalId}`);
  const patch = { pppoeUser: c.username, pppoePass: c.password, name: c.name, phone: c.phone || o.phone, address: c.address || o.address, externalStatus: c.status, externalAccount: c.account_no };
  const changed = ['pppoeUser', 'pppoePass', 'name'].some(k => patch[k] !== o[k]);
  Object.assign(o, patch);
  db.save();
  return changed;
}
app.get('/api/oneisp/customers', req => oneisp('/api/v1/customers?search=' + encodeURIComponent(req.query.search || '')));
async function syncAllFromOneIsp() {
  let n = 0;
  for (const o of db.find('onus', o => o.externalId)) { try { if (await pullFromOneIsp(o)) n++; } catch { return n; } }
  return n;
}

// ---------------------------------------------------------------- core ONU operations (shared by web UI, API and CLI)
function authorize(input, via = 'web') {
  const olt = db.get('olts', input.oltId || input.olt?.id);
  if (!olt) throw new HttpError(400, 'Choose an OLT');
  const board = Number(need(input.board, 'Board required')), port = Number(need(input.port, 'Port required'));
  const b = olt.boards.find(x => x.slot === board && x.ports);
  if (!b) throw new HttpError(400, `Board ${board} is not a PON board on ${olt.name}`);
  if (port < 0 || port >= b.ports + (olt.vendor === 'ZTE' ? 1 : 0)) throw new HttpError(400, `Port ${port} does not exist on board ${board}`);
  const sn = String(need(input.sn, 'Serial number required')).toUpperCase();
  if (db.findOne('onus', o => o.sn === sn)) throw new HttpError(400, `${sn} is already authorized`);
  const pending = db.findOne('unconfigured', u => u.sn === sn);
  let type = db.get('onuTypes', input.onuTypeId);
  if (!type && input.srvProfileId) type = db.findOne('onuTypes', t => t.srvProfileId === Number(input.srvProfileId));
  if (!type && pending) type = db.findOne('onuTypes', t => t.name.replace('ZTE-', '') === pending.equipmentId.replace('ZTE-', ''));
  type = type || db.col('onuTypes')[0];
  const onuId = input.onuId ? Number(input.onuId) : nextOnuId(olt.id, board, port);
  if (db.findOne('onus', o => o.oltId === olt.id && o.board === board && o.port === port && o.onuId === onuId)) throw new HttpError(400, `ONU id ${onuId} already used on ${board}/${port}`);
  const mode = input.mode || (type.modes.includes('routing') ? 'routing' : 'bridging');
  if (!type.modes.includes(mode)) throw new HttpError(400, `${type.name} only supports ${type.modes}`);
  const baseRx = pending ? rnd(-27.5, -18) : rnd(-25, -19);
  const onPort = pending && pending.oltId === olt.id && pending.board === board && pending.port === port;
  const o = db.insert('onus', {
    sn, oltId: olt.id, board, port, onuId, name: input.name || sn, address: input.address || '', phone: input.phone || '',
    zoneId: input.zoneId ? Number(input.zoneId) : null, odbId: input.odbId ? Number(input.odbId) : null, odbPort: input.odbPort || '',
    onuTypeId: type.id, ponType: type.ponType, mode, vlan: Number(input.vlan || 100), wanMode: input.wanMode || 'pppoe',
    pppoeUser: input.pppoeUser || '', pppoePass: input.pppoePass || '', staticIp: input.staticIp || '',
    downloadProfileId: input.downloadProfileId ? Number(input.downloadProfileId) : db.findOne('speedProfiles', s => s.type === 'download')?.id,
    uploadProfileId: input.uploadProfileId ? Number(input.uploadProfileId) : db.findOne('speedProfiles', s => s.type === 'upload')?.id,
    catv: input.catv === true || input.catv === 'true', wifiSsid: input.wifiSsid || `LabFiber-${sn.slice(-4)}`, wifiPassword: input.wifiPassword || '12345678',
    status: onPort ? 'online' : 'offline', disabled: false, baseRx, rxPower: baseRx, txPower: rnd(1.8, 2.6), oltRxPower: baseRx - rnd(1, 2.5),
    temperature: rnd(40, 50), distance: Math.round(rnd(150, 6000)), uptimeStart: iso(Date.now()), lastDownCause: '-', lastDownAt: null,
    servicePort: nextServicePort(olt.id), externalId: input.externalId ? Number(input.externalId) : null, authorizedAt: iso(Date.now()), via,
    trafficDown: 0, trafficUp: 0, history: { sig: [], traf: [] },
    tr069Profile: input.tr069Profile || 'SmartOLT', mgmtMode: input.mgmtMode || 'dhcp', mgmtVlan: Number(input.mgmtVlan || 69), configMethod: input.configMethod || 'omci',
    ipProtocol: input.ipProtocol || 'ipv4', pppoePlus: input.pppoePlus === true || input.pppoePlus === 'true', wanRemoteAccess: input.wanRemoteAccess === true || input.wanRemoteAccess === 'true',
  });
  ensureOnuDefaults(o);
  if (pending) db.remove('unconfigured', pending.id);
  const cmds = via === 'cli' ? [`ont add ${port} ${onuId} sn-auth "${sn}" ... (typed in OLT CLI)`] : commandsFor(o, 'authorize');
  logCli(o, 'authorize', cmds, via);
  event('authorized', 'info', `ONU ${sn} (${o.name}) authorized on ${olt.name} ${board}/${port}:${onuId} via ${via}`, { oltId: olt.id, onuSn: sn });
  if (!onPort) event('offline', 'warning', `ONU ${sn} was authorized but is not physically on ${board}/${port} - stays offline`, { oltId: olt.id, onuSn: sn });
  notifyOneIsp(o.externalId, sn);
  return o;
}

function removeOnu(o, via = 'web') {
  logCli(o, 'delete', commandsFor(o, 'delete'), via);
  db.remove('onus', o.id);
  // a deleted ONU that is still plugged in shows up again in autofind
  if (o.status === 'online' || o.disabled) db.insert('unconfigured', { oltId: o.oltId, board: o.board, port: o.port, sn: o.sn, equipmentId: db.get('onuTypes', o.onuTypeId)?.name || 'unknown', ponType: o.ponType, detectedAt: iso(Date.now()) });
  event('deleted', 'warning', `ONU ${o.sn} (${o.name}) deleted via ${via}`, { oltId: o.oltId, onuSn: o.sn });
  notifyOneIsp(o.externalId, null);
}

function onuAction(o, action, via = 'web') {
  const cmds = commandsFor(o, action === 'resync_config' ? 'resync' : action);
  switch (action) {
    case 'reboot':
      if (o.status !== 'online') throw new HttpError(400, 'ONU is not online');
      Object.assign(o, { status: 'offline', lastDownCause: 'ONT reset', lastDownAt: iso(Date.now()), rebootUntil: Date.now() + 45000 });
      event('reboot', 'info', `ONU ${o.sn} (${o.name}) rebooting`, { oltId: o.oltId, onuSn: o.sn });
      break;
    case 'disable':
      Object.assign(o, { disabled: true, status: 'offline', lastDownCause: 'deactivated', lastDownAt: iso(Date.now()) });
      event('disabled', 'warning', `ONU ${o.sn} (${o.name}) disabled`, { oltId: o.oltId, onuSn: o.sn });
      break;
    case 'enable':
      Object.assign(o, { disabled: false, rebootUntil: Date.now() + 20000 });
      event('enabled', 'info', `ONU ${o.sn} (${o.name}) enabled`, { oltId: o.oltId, onuSn: o.sn });
      break;
    case 'resync_config': case 'resync':
      event('resync', 'info', `Configuration re-sent to ONU ${o.sn}`, { oltId: o.oltId, onuSn: o.sn });
      break;
    default: throw new HttpError(400, 'Unknown action');
  }
  db.save();
  return logCli(o, action, cmds, via);
}

const EDITABLE = ['name', 'address', 'phone', 'zoneId', 'odbId', 'odbPort', 'onuTypeId', 'mode', 'vlan', 'wanMode', 'pppoeUser', 'pppoePass', 'staticIp', 'staticMask', 'staticGateway', 'downloadProfileId', 'uploadProfileId', 'catv', 'wifiSsid', 'wifiPassword', 'externalId', 'servicePort', 'comment',
  'tr069Profile', 'mgmtMode', 'mgmtVlan', 'mgmtIp', 'mgmtRemote', 'configMethod', 'ipProtocol', 'pppoePlus', 'wanRemoteAccess', 'sector', 'preset'];
const BOOLS = ['catv', 'mgmtRemote', 'pppoePlus', 'wanRemoteAccess'];
function updateOnu(o, patch, via = 'web') {
  const p = Object.fromEntries(Object.entries(patch).filter(([k]) => EDITABLE.includes(k)));
  for (const k of ['zoneId', 'odbId', 'onuTypeId', 'vlan', 'downloadProfileId', 'uploadProfileId', 'externalId']) if (p[k] !== undefined) p[k] = p[k] === '' || p[k] === null ? null : Number(p[k]);
  for (const k of BOOLS) if (p[k] !== undefined) p[k] = p[k] === true || p[k] === 'true';
  if (p.mgmtVlan !== undefined) p.mgmtVlan = Number(p.mgmtVlan);
  const next = { ...o, ...p };
  if (next.mode === 'routing' && next.wanMode === 'pppoe' && next.configMethod !== 'tr069' && !next.pppoeUser) throw new HttpError(400, 'PPPoE needs a username');
  if (next.mode === 'routing' && next.wanMode === 'static' && !next.staticIp) throw new HttpError(400, 'Static WAN needs an IP address');
  if (next.mgmtMode === 'static' && !next.mgmtIp) throw new HttpError(400, 'Static Mgmt IP needs an address');
  const before = { ...o };
  if (p.mode && p.mode !== o.mode) {
    const type = db.get('onuTypes', p.onuTypeId || o.onuTypeId);
    if (type && !type.modes.includes(p.mode)) throw new HttpError(400, `${type.name} only supports ${type.modes}`);
  }
  Object.assign(o, p);
  const changed = k => p[k] !== undefined && String(p[k]) !== String(before[k]);
  const actions = [];
  if (changed('vlan')) actions.push('vlan');
  else if (['mode', 'wanMode', 'pppoeUser', 'pppoePass', 'staticIp', 'configMethod', 'ipProtocol', 'pppoePlus', 'wanRemoteAccess'].some(changed)) actions.push('mode');
  if (['tr069Profile', 'mgmtMode', 'mgmtVlan', 'mgmtIp', 'mgmtRemote'].some(changed)) { if (o.mgmtMode === 'dhcp') o.mgmtIp = ''; actions.push('mgmt'); }
  if (changed('downloadProfileId') || changed('uploadProfileId')) actions.push('speed');
  if (changed('name')) actions.push('rename');
  if (changed('wifiSsid') || changed('wifiPassword')) actions.push('wifi');
  if (changed('catv')) actions.push('catv');
  db.update('onus', o.id, {});
  const logs = actions.map(a => logCli(o, a, typeof via === 'string' && via.startsWith('CLI:') ? [via.slice(5)] : commandsFor(o, a), via.startsWith('CLI') ? 'cli' : via));
  if (changed('externalId')) { notifyOneIsp(before.externalId, null); notifyOneIsp(o.externalId, o.sn); }
  return logs;
}

const cli = createCli({
  db, ops: {
    authorize: input => authorize({ ...input, oltId: input.olt.id }, 'cli'),
    remove: o => removeOnu(o, 'cli'),
    action: (o, a) => { try { onuAction(o, a, 'cli'); } catch { /* reset of offline ONU just does nothing */ } },
    update: (o, patch, line) => updateOnu(o, patch, line),
    commands: (o, a) => commandsFor(o, a),
  },
});

// ---------------------------------------------------------------- UI API
app.get('/api/meta', () => ({
  olts: db.col('olts').map(o => ({ id: o.id, name: o.name, vendor: o.vendor, boards: o.boards })), zones: db.col('zones'), odbs: db.col('odbs'),
  onuTypes: db.col('onuTypes'), speedProfiles: db.col('speedProfiles'), vlans: db.col('vlans'), settings: { signalWarning: settings().signalWarning, signalCritical: settings().signalCritical, company: settings().companyName },
}));

app.get('/api/dashboard', () => {
  const onus = db.col('onus').map(o => decorate(o));
  const c = st => onus.filter(o => o.status === st).length;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const e = new Date(d.getTime() + 864e5);
    days.push({ label: `${d.getDate()}/${d.getMonth() + 1}`, total: onus.filter(o => new Date(o.authorizedAt) >= d && new Date(o.authorizedAt) < e).length });
  }
  return {
    waiting: db.col('unconfigured').length, online: c('online'), offline: onus.length - c('online'),
    powerFail: c('power_fail'), los: c('los'), na: c('offline') + c('disabled'), total: onus.length,
    warning: onus.filter(o => o.signal === 'warning').length, critical: onus.filter(o => o.signal === 'critical').length,
    olts: db.col('olts').map(o => ({ id: o.id, name: o.name, vendor: o.vendor, hardware: o.hardware, ip: o.ip, temperature: Math.round(o.temperature), uptime: Math.floor((Date.now() - new Date(o.bootTime)) / 864e5) + ' days', onus: onus.filter(x => x.oltId === o.id).length, online: onus.filter(x => x.oltId === o.id && x.status === 'online').length })),
    network: db.col('netHistory').slice(-120), authorizations: days,
    events: db.col('events').slice(-10).reverse(),
  };
});

app.get('/api/unconfigured', () => db.col('unconfigured').map(u => ({ ...u, oltName: db.get('olts', u.oltId)?.name, vendor: db.get('olts', u.oltId)?.vendor })).reverse());
app.post('/api/unconfigured/refresh', () => { maybeAutofind(true); return { ok: true, count: db.col('unconfigured').length }; });
app.post('/api/unconfigured/simulate', req => {
  const olt = db.get('olts', req.body.oltId) || db.col('olts')[0];
  return addAutofind(olt, req.body.board !== undefined && req.body.board !== '' ? Number(req.body.board) : undefined, req.body.port !== undefined && req.body.port !== '' ? Number(req.body.port) : undefined, req.body.sn);
});
app.delete('/api/unconfigured/:id', req => { db.remove('unconfigured', req.params.id); return { ok: true }; });

app.get('/api/onus', req => {
  const q = req.query;
  const s = (q.search || '').toLowerCase();
  const rows = db.col('onus').map(o => decorate(o)).filter(o =>
    (!q.oltId || o.oltId === Number(q.oltId)) && (q.board === undefined || q.board === '' || o.board === Number(q.board)) && (q.port === undefined || q.port === '' || o.port === Number(q.port)) &&
    (!q.zoneId || o.zoneId === Number(q.zoneId)) && (!q.odbId || o.odbId === Number(q.odbId)) && (!q.vlan || o.vlan === Number(q.vlan)) &&
    (!q.onuTypeId || o.onuTypeId === Number(q.onuTypeId)) && (!q.profileId || o.downloadProfileId === Number(q.profileId) || o.uploadProfileId === Number(q.profileId)) &&
    (!q.ponType || o.ponType === q.ponType) && (!q.status || o.status === q.status) && (!q.signal || o.signal === q.signal) && (!q.mode || o.mode === q.mode) &&
    (!s || [o.sn, o.name, o.address, o.phone, o.pppoeUser, o.wanIp, o.pon].some(v => String(v || '').toLowerCase().includes(s))));
  return rows;
});
app.get('/api/onus/:id', req => {
  const o = findOnu(req.params.id);
  return { onu: decorate(o, true), disconnections: disconnections(o), events: db.find('events', e => e.onuSn === o.sn).slice(-30).reverse(), cli: db.find('cliLog', l => l.sn === o.sn).slice(-20).reverse(), running: commandsFor(o, 'authorize') };
});
app.post('/api/onus/authorize', req => decorate(authorize(req.body, req.apiClient ? 'api' : 'web')));
app.put('/api/onus/:id', req => { const o = findOnu(req.params.id); const logs = updateOnu(o, req.body, req.apiClient ? 'api' : 'web'); return { onu: decorate(o), cli: logs }; });
app.post('/api/onus/:id/pull-oneisp', async req => { const o = findOnu(req.params.id); await pullFromOneIsp(o); const logs = updateOnu(o, { pppoeUser: o.pppoeUser }); return { onu: decorate(o), cli: logs, running: commandsFor(o, 'mode') }; });
// Simulated TR-069 ACS view of the ONU (what SmartOLT reads/writes via CWMP)
app.get('/api/onus/:id/tr069', req => {
  const o = findOnu(req.params.id);
  const t = db.get('onuTypes', o.onuTypeId);
  if (o.tr069Profile === 'Disabled' || o.mgmtMode === 'inactive') throw new HttpError(400, 'TR-069 is disabled for this ONU (set a TR069 profile and Mgmt IP)');
  if (o.status !== 'online') throw new HttpError(400, 'ONU is offline - the ACS cannot reach it');
  const P = 'InternetGatewayDevice.';
  return { lastInform: o.tr069LastInform, params: {
    [P + 'DeviceInfo.Manufacturer']: t?.vendor === 'ZTE' ? 'ZTE' : 'Huawei Technologies Co., Ltd', [P + 'DeviceInfo.ModelName']: t?.name, [P + 'DeviceInfo.SerialNumber']: o.sn,
    [P + 'DeviceInfo.SoftwareVersion']: o.swVersion, [P + 'DeviceInfo.HardwareVersion']: o.hwVersion, [P + 'DeviceInfo.UpTime']: Math.floor((Date.now() - new Date(o.uptimeStart)) / 1000),
    [P + 'ManagementServer.URL']: settings().tr069Url, [P + 'ManagementServer.PeriodicInformInterval']: 300, [P + 'ManagementServer.ConnectionRequestURL']: `http://${o.mgmtIp}:7547/`,
    [P + `WANDevice.1.WANConnectionDevice.1.${o.wanMode === 'pppoe' ? 'WANPPPConnection' : 'WANIPConnection'}.1.ConnectionStatus`]: o.mode === 'routing' ? 'Connected' : 'Bridged',
    [P + 'WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username']: o.mode === 'routing' && o.wanMode === 'pppoe' ? o.pppoeUser : '',
    [P + 'WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress']: o.wanIp || '',
    [P + 'LANDevice.1.WLANConfiguration.1.SSID']: t?.wifi ? o.wifiSsid : 'n/a', [P + 'LANDevice.1.WLANConfiguration.1.TotalAssociations']: o.wifiClients ?? 0,
    [P + 'LANDevice.1.LANHostConfigManagement.IPInterface.1.IPInterfaceIPAddress']: '192.168.100.1',
  } };
});
app.post('/api/onus/:id/tr069', req => {
  const o = findOnu(req.params.id);
  const a = req.body.action;
  if (a === 'factory_reset') { Object.assign(o, { status: 'offline', lastDownCause: 'factory reset (TR-069)', lastDownAt: iso(Date.now()), rebootUntil: Date.now() + 60000 }); event('reboot', 'warning', `ONU ${o.sn} factory reset via TR-069 - config will be re-pushed when it informs`, { oltId: o.oltId, onuSn: o.sn }); }
  else if (a === 'reboot') { if (o.status !== 'online') throw new HttpError(400, 'ONU offline'); Object.assign(o, { status: 'offline', lastDownCause: 'reboot (TR-069)', lastDownAt: iso(Date.now()), rebootUntil: Date.now() + 45000 }); event('reboot', 'info', `ONU ${o.sn} rebooted via TR-069`, { oltId: o.oltId, onuSn: o.sn }); }
  else if (a === 'refresh') o.tr069LastInform = iso(Date.now());
  else throw new HttpError(400, 'Unknown TR-069 action');
  db.save();
  return { ok: true, cli: logCli(o, `tr069-${a}`, [`# CWMP ${a === 'refresh' ? 'GetParameterValues' : a === 'reboot' ? 'Reboot' : 'FactoryReset'} RPC sent by ACS ${settings().tr069Url} to ${o.mgmtIp || 'ONU'}`]) };
});
app.put('/api/olts/:id/ports/:board/:port', req => {
  const olt = db.get('olts', req.params.id);
  if (!olt) throw new HttpError(404, 'OLT not found');
  olt.portNames = olt.portNames || {};
  olt.portNames[`${req.params.board}/${req.params.port}`] = String(req.body.name || '').slice(0, 60);
  db.save();
  return { ok: true, cli: [`interface gpon 0/${req.params.board}`, `port desc ${req.params.port} description "${req.body.name}"`, 'quit'] };
});
app.post('/api/onus/:id/move', req => {
  const o = findOnu(req.params.id);
  const board = Number(req.body.board), port = Number(req.body.port);
  const old = { ...o };
  const del = commandsFor(o, 'delete');
  Object.assign(o, { board, port, onuId: nextOnuId(o.oltId, board, port) });
  logCli(o, 'move', [...del, ...commandsFor(o, 'authorize')]);
  event('moved', 'info', `ONU ${o.sn} moved ${old.board}/${old.port}:${old.onuId} -> ${board}/${port}:${o.onuId}`, { oltId: o.oltId, onuSn: o.sn });
  db.save();
  return decorate(o);
});
app.post('/api/onus/:id/:action', req => ({ ok: true, cli: onuAction(findOnu(req.params.id), req.params.action, req.apiClient ? 'api' : 'web') }));
app.delete('/api/onus/:id', req => { removeOnu(findOnu(req.params.id), req.apiClient ? 'api' : 'web'); return { ok: true }; });

app.get('/api/graphs', req => {
  const oltId = Number(req.query.oltId || 0);
  const onus = db.col('onus').filter(o => !oltId || o.oltId === oltId);
  // aggregate traffic across ONUs per sample index
  const len = Math.max(0, ...onus.map(o => o.history?.traf?.length || 0));
  const traffic = [];
  for (let i = 0; i < len; i++) {
    let t = 0, d = 0, u = 0;
    for (const o of onus) { const h = o.history.traf; const s = h[h.length - len + i]; if (s) { t = s[0]; d += s[1]; u += s[2]; } }
    if (t) traffic.push([t, d, u]);
  }
  return { network: db.col('netHistory').slice(-240).map(n => (oltId ? [n[0], n[3]?.[oltId]?.[0] ?? 0, n[3]?.[oltId]?.[1] ?? 0] : n.slice(0, 3))), traffic,
    top: onus.filter(o => o.status === 'online').map(o => ({ id: o.id, sn: o.sn, name: o.name, down: o.history.traf.at(-1)?.[1] || 0, up: o.history.traf.at(-1)?.[2] || 0 })).sort((a, b) => b.down - a.down).slice(0, 10) };
});

app.get('/api/events', req => db.col('events').filter(e => (!req.query.type || e.type === req.query.type) && (!req.query.oltId || e.oltId === Number(req.query.oltId)) && (!req.query.severity || e.severity === req.query.severity)).slice(-500).reverse());
app.delete('/api/events', () => { db.data.events = []; db.save(); return { ok: true }; });
app.get('/api/cli-log', () => db.col('cliLog').slice(-200).reverse());

app.get('/api/diagnostics', () => {
  const onus = db.col('onus').map(o => decorate(o));
  const s = settings();
  return {
    los: onus.filter(o => o.status === 'los'), powerFail: onus.filter(o => o.status === 'power_fail'),
    critical: onus.filter(o => o.signal === 'critical'), warning: onus.filter(o => o.signal === 'warning'),
    hot: onus.filter(o => o.status === 'online' && o.temperature > 60), offlineLong: onus.filter(o => o.status === 'offline' && !o.disabled && o.lastDownAt && Date.now() - new Date(o.lastDownAt) > 864e5),
    noOneIsp: onus.filter(o => !o.externalId), thresholds: { warning: s.signalWarning, critical: s.signalCritical },
    portsLos: (() => {
      // several ONUs in LOS on the same PON port = feeder fiber / splitter problem, not the customer
      const m = {};
      onus.filter(o => o.status === 'los').forEach(o => { const k = `${o.oltName} ${o.board}/${o.port}`; m[k] = (m[k] || 0) + 1; });
      return Object.entries(m).map(([port, count]) => ({ port, count, total: onus.filter(o => `${o.oltName} ${o.board}/${o.port}` === port).length }));
    })(),
  };
});
app.post('/api/diagnostics/ping', req => {
  const o = req.body.onuId ? findOnu(req.body.onuId) : null;
  const target = req.body.target || o?.wanIp || '8.8.8.8';
  const up = !o || o.status === 'online';
  const lines = [`PING ${target} 56(84) bytes of data.`];
  for (let i = 0; i < 4; i++) lines.push(up ? `64 bytes from ${target}: icmp_seq=${i + 1} ttl=${o ? 63 : 117} time=${rnd(o ? 1 : 18, o ? 4 : 35).toFixed(1)} ms` : `From ${target} icmp_seq=${i + 1} Destination Host Unreachable`);
  lines.push('', `--- ${target} ping statistics ---`, up ? '4 packets transmitted, 4 received, 0% packet loss' : '4 packets transmitted, 0 received, 100% packet loss');
  return { output: lines.join('\n') };
});

app.get('/api/reports', () => {
  const onus = db.col('onus').map(o => decorate(o));
  const group = (fn, label) => { const m = {}; onus.forEach(o => { const k = fn(o) ?? '-'; m[k] = m[k] || { key: k, total: 0, online: 0 }; m[k].total++; if (o.status === 'online') m[k].online++; }); return Object.values(m).map(x => ({ ...x, label })); };
  const bands = [['> -20 dBm', o => o.rxPower > -20], ['-20 to -23', o => o.rxPower <= -20 && o.rxPower > -23], ['-23 to -25', o => o.rxPower <= -23 && o.rxPower > -25], ['-25 to -27', o => o.rxPower <= -25 && o.rxPower > -27], ['< -27 dBm', o => o.rxPower <= -27]];
  return {
    byStatus: group(o => o.status), byOlt: group(o => o.oltName), byZone: group(o => o.zoneName), byType: group(o => o.onuTypeName), byMode: group(o => o.mode), byVlan: group(o => o.vlan),
    bySpeed: group(o => o.downloadName), signal: bands.map(([key, f]) => ({ key, total: onus.filter(o => o.status === 'online' && f(o)).length })),
    odbUsage: db.col('odbs').map(d => ({ key: d.name, used: onus.filter(o => o.odbId === d.id).length, ports: d.ports })),
  };
});
app.get('/api/reports/onus.csv', (req, res) => {
  const cols = ['sn', 'name', 'oltName', 'pon', 'onuTypeName', 'status', 'signal', 'rxPower', 'oltRxPower', 'mode', 'vlan', 'pppoeUser', 'zoneName', 'odbName', 'downloadName', 'uploadName', 'address', 'phone', 'externalId', 'authorizedAt'];
  const csv = [cols.join(','), ...db.col('onus').map(o => decorate(o)).map(o => cols.map(c => `"${String(o[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  res.send(csv, 'text/csv', 200, { 'Content-Disposition': 'attachment; filename="onus.csv"' });
});

// --- OLTs and settings collections
app.get('/api/olts/:id', req => {
  const olt = db.get('olts', req.params.id);
  if (!olt) throw new HttpError(404, 'OLT not found');
  const onus = db.find('onus', o => o.oltId === olt.id).map(o => decorate(o));
  const ports = [];
  olt.boards.filter(b => b.ports).forEach(b => { for (let p = olt.vendor === 'ZTE' ? 1 : 0; p < b.ports + (olt.vendor === 'ZTE' ? 1 : 0); p++) { const l = onus.filter(o => o.board === b.slot && o.port === p); ports.push({ board: b.slot, port: p, total: l.length, online: l.filter(o => o.status === 'online').length, los: l.filter(o => o.status === 'los').length, waiting: db.find('unconfigured', u => u.oltId === olt.id && u.board === b.slot && u.port === p).length, avgRx: l.filter(o => o.status === 'online').length ? (l.filter(o => o.status === 'online').reduce((a, o) => a + o.rxPower, 0) / l.filter(o => o.status === 'online').length).toFixed(2) : '-' }); } });
  return { olt, ports, setup: oltSetup(olt, { vlans: db.find('vlans', v => !v.oltId || v.oltId === olt.id), speedProfiles: db.col('speedProfiles'), onuTypes: db.col('onuTypes').filter(t => t.vendor === olt.vendor) }) };
});
app.post('/api/olts/:id/cli', req => {
  const olt = db.get('olts', req.params.id);
  if (!olt) throw new HttpError(404, 'OLT not found');
  const sid = req.body.session || 'default';
  const lines = String(req.body.command || '').split('\n');
  let output = '', prompt;
  for (const l of lines) { const r = cli(olt, `${olt.id}:${sid}`, l); output += (output ? '\n' : '') + r.output; prompt = r.prompt; }
  return { output, prompt };
});

const COLLECTIONS = {
  olts: ['name', 'vendor', 'hardware', 'software', 'hostname', 'ip', 'telnetPort', 'snmpPort', 'snmpCommunity', 'uplinkSlot', 'uplinkPort', 'uplink', 'boards'],
  zones: ['name'], odbs: ['name', 'zoneId', 'ports', 'splitter', 'latitude', 'longitude'],
  onuTypes: ['name', 'ponType', 'ethPorts', 'wifi', 'voip', 'catv', 'srvProfileId', 'vendor', 'modes'],
  speedProfiles: ['name', 'type', 'speed', 'index'], vlans: ['vlan', 'description', 'oltId'],
};
const NUMERIC = ['zoneId', 'ports', 'ethPorts', 'voip', 'srvProfileId', 'speed', 'index', 'vlan', 'oltId', 'telnetPort', 'snmpPort', 'uplinkSlot', 'uplinkPort'];
function cleanCol(name, body) {
  const out = {};
  for (const k of COLLECTIONS[name]) if (body[k] !== undefined) out[k] = NUMERIC.includes(k) ? (body[k] === '' ? null : Number(body[k])) : body[k];
  for (const k of ['wifi', 'catv']) if (out[k] !== undefined) out[k] = out[k] === true || out[k] === 'true';
  if (typeof out.boards === 'string') {
    // "0:GPFD:16, 1:GPFD:16, 2:MCUD:0"
    out.boards = out.boards.split(',').map(x => x.trim()).filter(Boolean).map(x => { const [slot, type, ports] = x.split(':'); return { slot: Number(slot), type: type || 'GPFD', ports: Number(ports || 0) }; });
  }
  return out;
}
const DEPENDENTS = { olts: o => db.find('onus', x => x.oltId === o), zones: z => db.find('onus', x => x.zoneId === z), odbs: d => db.find('onus', x => x.odbId === d), onuTypes: t => db.find('onus', x => x.onuTypeId === t), speedProfiles: s => db.find('onus', x => x.downloadProfileId === s || x.uploadProfileId === s), vlans: () => [] };
for (const name of Object.keys(COLLECTIONS)) {
  app.get(`/api/settings/${name}`, () => db.col(name).map(r => ({ ...r, used: DEPENDENTS[name](r.id).length })));
  app.post(`/api/settings/${name}`, req => {
    const rec = cleanCol(name, req.body);
    need(rec[COLLECTIONS[name][0]], `${COLLECTIONS[name][0]} is required`);
    if (name === 'olts') Object.assign(rec, { bootTime: iso(Date.now()), temperature: 40, boards: rec.boards || [{ slot: 0, type: 'GPFD', ports: 16 }], hostname: rec.hostname || rec.hardware || 'OLT' });
    return db.insert(name, rec);
  });
  app.put(`/api/settings/${name}/:id`, req => db.update(name, req.params.id, cleanCol(name, req.body)));
  app.delete(`/api/settings/${name}/:id`, req => {
    if (DEPENDENTS[name](Number(req.params.id)).length) throw new HttpError(400, 'Still used by ONUs');
    db.remove(name, req.params.id);
    return { ok: true };
  });
}
app.get('/api/settings', () => settings());
app.put('/api/settings', req => {
  const s = settings(), b = req.body;
  for (const k of ['companyName', 'apiToken', 'tr069Url', 'username']) if (b[k] !== undefined && b[k] !== '') s[k] = b[k];
  if (b.password) s.password = b.password;
  for (const k of ['signalWarning', 'signalCritical']) if (b[k] !== undefined) s[k] = Number(b[k]);
  if (b.oneisp) s.oneisp = { ...s.oneisp, ...b.oneisp };
  if (b.simulation) s.simulation = { ...s.simulation, ...Object.fromEntries(Object.entries(b.simulation).map(([k, v]) => [k, k === 'speed' ? Number(v) : v === true || v === 'true'])) };
  db.save();
  return s;
});
app.post('/api/settings/oneisp/test', async () => ({ ok: true, customers: (await oneisp('/api/v1/customers')).length }));
app.post('/api/settings/oneisp/sync', async () => ({ ok: true, updated: await syncAllFromOneIsp() }));
app.post('/api/settings/reset', () => { const fresh = new Store(db.file + '.reset', seed.seed); db.data = fresh.data; db.flush(); require('fs').unlinkSync(fresh.file); return { ok: true }; });

// ---------------------------------------------------------------- SmartOLT-compatible public API (X-Token)
const apiOnu = o => {
  const d = decorate(o);
  return { unique_external_id: d.externalId, sn: d.sn, olt_id: d.oltId, olt_name: d.oltName, board: d.board, port: d.port, onu: d.onuId, onu_type: d.onuTypeName, name: d.name, mode: d.mode, vlan: d.vlan,
    zone: d.zoneName, odb: d.odbName, address: d.address, status: { online: 'Online', los: 'LOS', power_fail: 'Power fail', offline: 'Offline', disabled: 'Disabled' }[d.status] || d.status,
    signal: d.signal, rx_power: Number(d.rxPower.toFixed(2)), tx_power: Number(d.txPower.toFixed(2)), olt_rx_power: Number(d.oltRxPower.toFixed(2)), distance: d.distance, uptime: d.uptime,
    last_down_cause: d.lastDownCause, pppoe_username: d.pppoeUser, download_speed: d.downloadName, upload_speed: d.uploadName, authorization_date: d.authorizedAt,
    url: `http://localhost:${PORT}/#/onu/${d.id}` };
};
app.get('/api/system/get_olts', () => ({ status: true, response: db.col('olts').map(o => ({ id: o.id, name: o.name, olt_hardware_version: o.hardware, ip: o.ip, telnet_port: o.telnetPort, snmp_port: o.snmpPort })) }));
app.get('/api/system/get_zones', () => ({ status: true, response: db.col('zones') }));
app.get('/api/system/get_onu_types', () => ({ status: true, response: db.col('onuTypes') }));
app.get('/api/onu/unconfigured_onus', () => ({ status: true, response: db.col('unconfigured').map(u => ({ olt_id: u.oltId, board: u.board, port: u.port, sn: u.sn, onu_type_name: u.equipmentId, pon_type: u.ponType.toLowerCase() })) }));
app.get('/api/onu/get_all_onus_details', () => ({ status: true, onus: db.col('onus').map(apiOnu) }));
app.get('/api/onu/get_onus_statuses', () => ({ status: true, response: db.col('onus').map(o => ({ sn: o.sn, status: apiOnu(o).status })) }));
app.get('/api/onu/get_onu_details/:sn', req => ({ status: true, onu_details: apiOnu(findOnu(req.params.sn)) }));
app.get('/api/onu/get_onu_signal/:sn', req => { const o = apiOnu(findOnu(req.params.sn)); return { status: true, onu_signal: o.signal, onu_signal_value: `${o.rx_power} dBm`, onu_signal_1310: `${o.olt_rx_power} dBm` }; });
app.get('/api/onu/get_onu_status/:sn', req => ({ status: true, onu_status: apiOnu(findOnu(req.params.sn)).status }));
app.post('/api/onu/authorize_onu', req => {
  const b = req.body;
  const type = db.findOne('onuTypes', t => t.name === b.onu_type) || db.get('onuTypes', b.onu_type_id);
  const zone = db.findOne('zones', z => z.name === b.zone) || db.get('zones', b.zone_id);
  const o = authorize({ oltId: b.olt_id, board: b.board, port: b.port, sn: b.sn, onuTypeId: type?.id, mode: b.onu_mode === 'Bridging' ? 'bridging' : b.onu_mode === 'Routing' ? 'routing' : b.onu_mode, vlan: b.vlan, zoneId: zone?.id, name: b.name, address: b.address_or_comment, externalId: b.onu_external_id, pppoeUser: b.pppoe_username, pppoePass: b.pppoe_password }, 'api');
  return { status: true, response: apiOnu(o) };
});
for (const [name, action] of [['reboot', 'reboot'], ['resync_config', 'resync_config'], ['disable', 'disable'], ['enable', 'enable']]) {
  app.post(`/api/onu/${name}/:sn`, req => { onuAction(findOnu(req.params.sn), action, 'api'); return { status: true, response: `${name} sent` }; });
}
app.post('/api/onu/delete/:sn', req => { removeOnu(findOnu(req.params.sn), 'api'); return { status: true, response: 'deleted' }; });

// ---------------------------------------------------------------- simulation engine
const PREFIX = { Huawei: ['HWTC', 'HWTC', 'HWTC'], ZTE: ['ZTEG', 'ZTEG'] };
const EQUIP = { Huawei: ['HG8546M', 'EG8145V5', 'HG8010H', 'HG8247H'], ZTE: ['F660', 'F670L', 'F601'] };
function addAutofind(olt, board, port, sn) {
  const pon = olt.boards.filter(b => b.ports);
  const b = board !== undefined ? pon.find(x => x.slot === board) || pon[0] : pon[Math.floor(Math.random() * pon.length)];
  const p = port !== undefined ? port : Math.floor(Math.random() * b.ports) + (olt.vendor === 'ZTE' ? 1 : 0);
  const prefix = PREFIX[olt.vendor][0];
  sn = (sn || prefix + crypto.randomBytes(4).toString('hex')).toUpperCase();
  if (db.findOne('unconfigured', u => u.sn === sn) || db.findOne('onus', o => o.sn === sn)) throw new HttpError(400, 'SN already known');
  const list = EQUIP[olt.vendor];
  const u = db.insert('unconfigured', { oltId: olt.id, board: b.slot, port: p, sn, equipmentId: list[Math.floor(Math.random() * list.length)], ponType: 'GPON', detectedAt: iso(Date.now()) });
  event('autofind', 'info', `New ONU ${sn} (${u.equipmentId}) found on ${olt.name} ${b.slot}/${p}`, { oltId: olt.id, onuSn: sn });
  return u;
}
function maybeAutofind(force) {
  if (!settings().simulation.autofind && !force) return;
  for (const olt of db.col('olts')) {
    if (!olt.boards.some(b => b.ports)) continue;
    if (db.find('unconfigured', u => u.oltId === olt.id).length >= 4) continue;
    if (force || Math.random() < 0.01) addAutofind(olt);
  }
}

let tickN = 0;
function tick() {
  const s = settings();
  const speed = s.simulation.speed || 1;
  const now = Date.now();
  tickN++;
  for (const o of db.col('onus')) {
    if (o.disabled) continue;
    if (o.rebootUntil) {
      if (now > o.rebootUntil) { delete o.rebootUntil; o.status = 'online'; o.uptimeStart = iso(now); event('online', 'info', `ONU ${o.sn} (${o.name}) back online`, { oltId: o.oltId, onuSn: o.sn }); }
      continue;
    }
    if (s.simulation.faults) {
      if (o.status === 'online') {
        const r = Math.random();
        if (r < 0.0008 * speed) { Object.assign(o, { status: 'power_fail', lastDownCause: 'dying-gasp', lastDownAt: iso(now) }); event('power_fail', 'warning', `ONU ${o.sn} (${o.name}) power fail (dying-gasp)`, { oltId: o.oltId, onuSn: o.sn }); }
        else if (r < 0.0012 * speed) { Object.assign(o, { status: 'los', lastDownCause: 'LOS', lastDownAt: iso(now) }); event('los', 'critical', `ONU ${o.sn} (${o.name}) LOS - loss of signal`, { oltId: o.oltId, onuSn: o.sn }); }
      } else if (o.status !== 'offline' || o.lastDownCause !== 'unknown') {
        if (Math.random() < 0.01 * speed) { o.status = 'online'; o.uptimeStart = iso(now); event('online', 'info', `ONU ${o.sn} (${o.name}) is online`, { oltId: o.oltId, onuSn: o.sn }); }
      }
    }
    if (o.status === 'online') {
      o.baseRx += (Math.random() - 0.5) * 0.02;
      o.rxPower = o.baseRx + (Math.random() - 0.5) * 0.4;
      o.oltRxPower = o.baseRx - 1.6 + (Math.random() - 0.5) * 0.4;
      o.txPower = 2.2 + (Math.random() - 0.5) * 0.2;
      o.temperature = Math.min(75, Math.max(30, o.temperature + (Math.random() - 0.5)));
      if (!o.wanIp && o.mode === 'routing') o.wanIp = `10.10.${(o.id >> 8) & 255}.${(o.id % 250) + 2}`;
      if (o.mgmtMode === 'dhcp' && o.tr069Profile !== 'Disabled' && !o.mgmtIp) o.mgmtIp = `10.67.${31 + o.oltId}.${(o.id % 250) + 2}`;
      if (o.tr069Profile !== 'Disabled' && o.mgmtMode !== 'inactive' && (!o.tr069LastInform || now - new Date(o.tr069LastInform) > 300000)) o.tr069LastInform = iso(now);
      if (db.get('onuTypes', o.onuTypeId)?.wifi) { o.wifiClients = Math.max(0, Math.min(12, (o.wifiClients ?? 2) + Math.round((Math.random() - 0.5) * 1.2))); o.wifiAvg = Math.round(-45 - Math.random() * 20); }
      const maxDown = (db.get('speedProfiles', o.downloadProfileId)?.speed || 10240), maxUp = (db.get('speedProfiles', o.uploadProfileId)?.speed || 5120);
      const hour = new Date().getHours();
      const load = hour >= 19 && hour <= 23 ? 0.65 : hour >= 1 && hour <= 6 ? 0.08 : 0.3;
      const d = Math.round(maxDown * Math.min(1, Math.max(0, load + (Math.random() - 0.4) * 0.5))), u = Math.round(maxUp * Math.min(1, Math.max(0, load * 0.4 + (Math.random() - 0.4) * 0.3)));
      o._d = d; o._u = u;
    } else { o._d = 0; o._u = 0; }
    if (tickN % 3 === 0) {
      o.history = o.history || { sig: [], traf: [] };
      o.history.sig.push([now, o.status === 'online' ? Number(o.rxPower.toFixed(2)) : null, o.status === 'online' ? Number(o.oltRxPower.toFixed(2)) : null]);
      o.history.traf.push([now, o._d, o._u]);
      if (o.history.sig.length > 480) o.history.sig.shift();
      if (o.history.traf.length > 480) o.history.traf.shift();
    }
    delete o._d; delete o._u;
  }
  for (const olt of db.col('olts')) olt.temperature = Math.min(65, Math.max(30, (olt.temperature || 40) + (Math.random() - 0.5) * 0.3));
  if (tickN % 3 === 0) {
    const onus = db.col('onus');
    const perOlt = {};
    db.col('olts').forEach(o => { const l = onus.filter(x => x.oltId === o.id); perOlt[o.id] = [l.filter(x => x.status === 'online' && !x.disabled).length, l.length - l.filter(x => x.status === 'online' && !x.disabled).length]; });
    const on = onus.filter(x => x.status === 'online' && !x.disabled).length;
    db.col('netHistory').push([now, on, onus.length - on, perOlt]);
    db.trim('netHistory', 2880);
  }
  maybeAutofind(false);
  db.save();
}

// Backfill history so graphs are not empty on first start.
function backfill() {
  if (db.col('netHistory').length) return;
  const now = Date.now();
  for (let i = 240; i > 0; i--) {
    const t = now - i * 30000;
    const onus = db.col('onus');
    let on = 0;
    for (const o of onus) {
      o.history = o.history || { sig: [], traf: [] };
      const online = o.status === 'online' || Math.random() < 0.05;
      if (online) on++;
      const maxDown = db.get('speedProfiles', o.downloadProfileId)?.speed || 10240;
      o.history.sig.push([t, online ? Number((o.baseRx + (Math.random() - 0.5) * 0.4).toFixed(2)) : null, online ? Number((o.baseRx - 1.6).toFixed(2)) : null]);
      o.history.traf.push([t, online ? Math.round(maxDown * (0.2 + Math.random() * 0.4)) : 0, online ? Math.round(maxDown * 0.1 * Math.random()) : 0]);
    }
    db.col('netHistory').push([t, on, onus.length - on, {}]);
  }
  db.save();
}

// data created before OneISP moved from port 3000 to 8080
if (settings().oneisp?.url === 'http://localhost:3000') { settings().oneisp.url = 'http://localhost:8080'; db.save(); }
db.col('onus').forEach(ensureOnuDefaults);
db.save();
backfill();
setInterval(tick, 10000);
setTimeout(() => syncAllFromOneIsp().then(n => n && console.log(`Pulled ${n} PPPoE credential(s) from OneISP`)), 3000);
setInterval(() => syncAllFromOneIsp(), 300000);
process.on('SIGINT', () => { db.flush(); process.exit(0); });
process.on('SIGTERM', () => { db.flush(); process.exit(0); });

app.listen(PORT, HOST, () => console.log(`SmartOLT simulator running on http://localhost:${PORT}  (login: admin / admin, API X-Token: ${settings().apiToken})`));
