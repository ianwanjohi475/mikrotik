// OneISP simulator front-end (vanilla JS single page app, hash routing).
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let ME = null, CUR = 'KES';
const money = n => `${CUR} ${Number(n || 0).toLocaleString()}`;
const dt = d => (d ? new Date(d).toLocaleString() : '-');
const dshort = d => (d ? new Date(d).toLocaleDateString() : '-');
const pill = s => `<span class="pill p-${esc(String(s).replace(/\s/g, '_'))}">${esc(String(s).replace('_', ' '))}</span>`;
const TYPES = { pppoe: 'PPPoE', static: 'Static', dhcp: 'DHCP', hotspot: 'Hotspot' };

function timeLeft(d) {
  if (!d) return '-';
  const ms = new Date(d) - Date.now();
  const a = Math.abs(ms), days = Math.floor(a / 864e5), h = Math.floor((a % 864e5) / 36e5), m = Math.floor((a % 36e5) / 6e4);
  const s = days ? `${days}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return ms >= 0 ? `in ${s}` : `${s} ago`;
}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && !url.includes('/auth/')) { showLogin(); throw new Error('Login required'); }
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const GET = u => api('GET', u), POST = (u, b) => api('POST', u, b || {}), PUT = (u, b) => api('PUT', u, b), DEL = u => api('DELETE', u);

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), type === 'bad' ? 7000 : 3500);
}
const fail = e => toast(esc(e.message), 'bad');

// Shows the RouterOS commands that an action produced - the core learning tool.
function showRouter(results, title = 'Router commands') {
  const list = (Array.isArray(results) ? results : [results]).filter(Boolean);
  const ops = list.flatMap(r => r.ops || []);
  if (!ops.length) return;
  const mode = list[0].mode;
  const ok = list.every(r => r.ok);
  const p = $('#cmdPanel');
  p.innerHTML = `<div class="h"><b>${esc(title)} <span class="pill p-${mode === 'live' ? 'live' : 'simulate'}">${mode === 'live' ? 'LIVE router' : 'simulated router'}</span> ${ok ? '<span class="pill p-ok">OK</span>' : '<span class="pill p-error">ERROR</span>'}</b>
    <span><button class="btn sm ghost" id="cmdCopy">Copy</button> <button class="btn sm ghost" id="cmdClose">&times;</button></span></div>
    <div class="b"><div class="small muted">Equivalent WinBox terminal commands (paste them in New Terminal to practice):</div>
    ${ops.map(o => `<div class="cmd ${o.ok ? 'ok' : 'bad'}">${esc(o.cli)}${o.note ? `<div class="n"># ${esc(o.note)}</div>` : ''}${o.error ? `<div class="e">${esc(o.error)}</div>` : ''}</div>`).join('')}</div>`;
  p.classList.remove('hidden');
  $('#cmdClose').onclick = () => p.classList.add('hidden');
  $('#cmdCopy').onclick = () => { navigator.clipboard.writeText(ops.map(o => o.cli).join('\n')); toast('Copied'); };
  if (!ok) toast('Router reported an error - see command panel', 'bad');
}

// ---------- modal & forms
function modal(title, body, { wide = false, submit = 'Save', onSubmit, foot = true } = {}) {
  const root = $('#modalRoot');
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal ${wide ? 'wide' : ''}"><div class="modal-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn x">&times;</button></div>
    <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot"><button type="button" class="btn ghost x">Cancel</button>${onSubmit ? `<button class="btn primary">${esc(submit)}</button>` : ''}</div>` : ''}</form>`;
  root.appendChild(bg);
  const close = () => bg.remove();
  $$('.x', bg).forEach(b => (b.onclick = close));
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  const f = $('form', bg);
  f.onsubmit = async e => {
    e.preventDefault();
    if (!onSubmit) return close();
    const btn = $('.modal-foot .primary', bg);
    if (btn) btn.disabled = true;
    try { if ((await onSubmit(formData(f), f)) !== false) close(); } catch (err) { fail(err); } finally { if (btn) btn.disabled = false; }
  };
  return { el: f, close };
}
function formData(f) {
  const o = {};
  $$('[name]', f).forEach(i => { if (i.type === 'radio') { if (i.checked) o[i.name] = i.value; return; } o[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
  return o;
}
function field(f, v = {}) {
  const val = v[f.name] ?? f.value ?? '';
  const cls = f.full ? 'full' : '';
  if (f.type === 'select') {
    const opts = f.options.map(o => (typeof o === 'object' ? o : { value: o, label: o }));
    return `<label class="${cls}">${esc(f.label)}<select name="${f.name}" ${f.required ? 'required' : ''}>${f.blank !== undefined ? `<option value="">${esc(f.blank)}</option>` : ''}${opts.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(val) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${f.help ? `<span class="small muted">${f.help}</span>` : ''}</label>`;
  }
  if (f.type === 'textarea') return `<label class="${cls}">${esc(f.label)}<textarea name="${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>${f.help ? `<span class="small muted">${f.help}</span>` : ''}</label>`;
  if (f.type === 'checkbox') return `<label class="${cls}"><input type="checkbox" name="${f.name}" ${val === true || val === 'true' ? 'checked' : ''}> ${esc(f.label)}</label>`;
  return `<label class="${cls}">${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} ${f.step ? `step="${f.step}"` : ''}>${f.help ? `<span class="small muted">${f.help}</span>` : ''}</label>`;
}
const fields = (list, v) => `<div class="fgrid">${list.map(f => field(f, v)).join('')}</div>`;
function confirmBox(msg) { return new Promise(res => { const m = modal('Please confirm', `<p>${msg}</p>`, { submit: 'Yes, continue', onSubmit: () => res(true) }); $$('.x', m.el).forEach(b => b.addEventListener('click', () => res(false))); }); }

function table(cols, rows, { empty = 'Nothing here yet', onRow } = {}) {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  const id = 't' + Math.random().toString(36).slice(2);
  setTimeout(() => {
    if (!onRow) return;
    $$(`#${id} tbody tr`).forEach((tr, i) => tr.addEventListener('click', e => { if (!e.target.closest('button,input,a,select')) onRow(rows[i]); }));
  });
  return `<div class="table-wrap"><table id="${id}"><thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${c.label}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(r => `<tr style="${onRow ? 'cursor:pointer' : ''}">${cols.map(c => `<td class="${c.cls || ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function barChart(data, { height = 220, color = '#7367f0', fmt = v => v } = {}) {
  const w = 700, pad = 30, max = Math.max(1, ...data.map(d => d.total));
  const bw = (w - pad * 2) / data.length;
  return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none">
    ${[0, .5, 1].map(f => `<line x1="${pad}" x2="${w - pad}" y1="${height - 25 - f * (height - 50)}" y2="${height - 25 - f * (height - 50)}" stroke="rgba(140,140,170,.2)"/><text x="0" y="${height - 22 - f * (height - 50)}">${f ? fmt(Math.round(max * f)) : 0}</text>`).join('')}
    ${data.map((d, i) => { const h = (d.total / max) * (height - 50); return `<rect x="${pad + i * bw + bw * .2}" y="${height - 25 - h}" width="${bw * .6}" height="${h}" rx="3" fill="${color}"><title>${esc(d.label)}: ${fmt(d.total)}</title></rect><text x="${pad + i * bw + bw / 2}" y="${height - 8}" text-anchor="middle">${esc(d.label)}</text>`; }).join('')}
  </svg>`;
}

// ---------- caches
const cache = {};
async function load(key, url, force) { if (force || !cache[key]) cache[key] = await GET(url); return cache[key]; }
const sites = f => load('sites', '/api/sites', f);
const packages = f => load('packages', '/api/packages', f);

// ---------- layout
const NAV = [
  ['', [['dashboard', '&#8962;', 'Dashboards']]],
  ['Management', [['sites', '&#127760;', 'Sites'], ['packages', '&#9707;', 'Packages'], ['policies', '&#8644;', 'Bandwidth Policy'], ['vouchers', '&#9636;', 'Vouchers']]],
  ['CRM', [['customers', '&#9786;', 'Customers'], ['leads', '&#9734;', 'Leads'], ['tickets', '&#9873;', 'Tickets']]],
  ['Revenue', [['payments', '&#36;', 'Payments'], ['mpesa', '&#9742;', 'M-Pesa'], ['expenses', '&#8595;', 'Expenses']]],
  ['Communication', [['sms', '&#9993;', 'SMS & WhatsApp']]],
  ['System', [['logs', '&#9000;', 'Router Logs'], ['users', '&#9787;', 'Users'], ['settings', '&#9881;', 'Settings'], ['learn', '&#9733;', 'Learn / Lab guide']]],
  ['Portals', [['portal-hotspot', '&#8599;', 'Hotspot portal'], ['portal-account', '&#8599;', 'Customer portal']]],
];
function renderNav(active) {
  $('#nav').innerHTML = NAV.map(([g, items]) => `${g ? `<div class="nav-group">${g}</div>` : ''}${items.map(([k, ic, l]) => {
    const href = k === 'portal-hotspot' ? '/portal/hotspot.html?site=1' : k === 'portal-account' ? '/portal/account.html' : `#/${k}`;
    return `<a class="nav-item ${active === k ? 'active' : ''}" href="${href}" ${k.startsWith('portal') ? 'target="_blank"' : ''}><span class="ic">${ic}</span>${l}</a>`;
  }).join('')}`).join('');
}

const routes = {};
async function router() {
  clearInterval(timer);
  const parts = (location.hash.slice(2).split('?')[0] || 'dashboard').split('/');
  const [name, id] = parts;
  renderNav(name);
  $('#sidebar').classList.remove('open');
  $('#crumb').textContent = (NAV.flatMap(g => g[1]).find(i => i[0] === name) || [0, 0, ''])[2];
  const page = $('#page');
  const fn = routes[id ? name + '/:id' : name] || routes.dashboard;
  page.innerHTML = '<div class="empty">Loading...</div>';
  try { await fn(page, id, parts); } catch (e) { page.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', router);

function showLogin() { $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  try { await POST('/api/auth/login', formData(e.target)); await boot(); } catch (err) { fail(err); }
};
$('#logoutBtn').onclick = async () => { await POST('/api/auth/logout'); showLogin(); };
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
$('#themeBtn').onclick = () => { document.documentElement.classList.toggle('light'); localStorage.theme = document.documentElement.classList.contains('light') ? 'light' : 'dark'; };
if (localStorage.theme === 'light') document.documentElement.classList.add('light');

async function boot() {
  try {
    const me = await api('GET', '/api/auth/me');
    ME = me.user; CUR = me.currency;
    $('#userName').textContent = ME.name || ME.username;
    $('#login').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    router();
  } catch { showLogin(); }
}

// ============================================================ DASHBOARD
routes.dashboard = async page => {
  const d = await GET('/api/dashboard');
  const s = d.stats;
  const stat = (v, l, ic, cls, href) => `<a class="card stat" href="${href || '#/customers'}"><div><div class="v">${v}</div><div class="l">${l}</div></div><div class="bub ${cls}">${ic}</div></a>`;
  page.innerHTML = `
  <div class="grid g4">${stat(s.total, 'Total Users', '&#9786;', 'b-acc')}${stat(s.active, 'Active Users', '&#10003;', 'b-ok')}${stat(s.expired, 'Expired Users', '&#8722;', 'b-bad')}${stat(s.disabled, 'Disabled Users', '&#10005;', 'b-dark')}</div>
  <div class="grid g4">${stat(s.online, 'Online now', '&#9679;', 'b-ok')}${stat(money(s.revenueToday), 'Revenue today', '&#36;', 'b-info', '#/payments')}${stat(money(s.revenueMonth), 'Revenue this month', '&#36;', 'b-acc', '#/payments')}${stat(money(s.revenueMonth - s.expensesMonth), 'Profit this month', '&#8593;', s.revenueMonth - s.expensesMonth >= 0 ? 'b-ok' : 'b-bad', '#/expenses')}</div>
  <div class="grid g2">
    <div class="card"><h3>Revenue - last 12 months</h3>${barChart(d.revenueByMonth, { fmt: v => v >= 1000 ? Math.round(v / 1000) + 'k' : v })}</div>
    <div class="card"><h3>Sites</h3>${table([{ label: 'Site', render: r => `<a href="#/sites/${r.id}">${esc(r.name)}</a>` }, { label: 'Router', render: r => pill(r.status) }, { label: 'Customers', key: 'customers' }, { label: 'Online', key: 'online' }], d.sites)}
      <h3 style="margin-top:18px">Connection types</h3><div class="row">${Object.entries(s.byType).map(([k, v]) => `<a class="pill p-new" href="#/customers?type=${k}">${TYPES[k]}: ${v}</a>`).join('')}</div>
      <div class="row" style="margin-top:14px"><a href="#/tickets" class="pill p-pending">Open tickets: ${s.openTickets}</a><a href="#/leads" class="pill p-new">New leads: ${s.newLeads}</a><a href="#/vouchers" class="pill p-unused">Unused vouchers: ${s.vouchersUnused}</a></div></div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>Expiring in the next 3 days</h3>${table([{ label: 'Customer', render: r => `<a href="#/customers/${r.id}">${esc(r.name)}</a><div class="small muted">${esc(r.accountNo)}</div>` }, { label: 'Package', key: 'packageName' }, { label: 'Expires', render: r => `${dt(r.expiresAt)}<div class="small muted">${timeLeft(r.expiresAt)}</div>` }], d.expiringSoon, { empty: 'No one expiring soon' })}</div>
    <div class="card"><h3>Recent payments</h3>${table([{ label: 'Customer', key: 'customerName' }, { label: 'Amount', render: r => money(r.amount) }, { label: 'Method', render: r => pill(r.method) }, { label: 'Date', render: r => dt(r.createdAt) }], d.recentPayments)}</div>
  </div>`;
};

// ============================================================ SITES
const SITE_FORM = [
  { name: 'name', label: 'Site name', required: true }, { name: 'location', label: 'Location' },
  { name: 'mode', label: 'Router mode', type: 'select', options: [{ value: 'simulate', label: 'Simulate (virtual router, no MikroTik needed)' }, { value: 'live', label: 'Live (real MikroTik via REST API)' }], full: true, help: 'Live mode talks to RouterOS v7 at http(s)://host/rest. Enable it with <span class="mono">/ip service set www disabled=no</span>' },
  { name: 'host', label: 'Router IP / host', placeholder: '192.168.56.101' }, { name: 'port', label: 'Port', type: 'number', value: 80 },
  { name: 'useHttps', label: 'Use HTTPS (www-ssl service, self-signed OK)', type: 'checkbox' }, { name: 'username', label: 'API username' }, { name: 'password', label: 'API password', type: 'password' },
  { name: 'wanInterface', label: 'WAN interface' }, { name: 'pppoeInterface', label: 'PPPoE server interface' }, { name: 'hotspotInterface', label: 'Hotspot interface' },
  { name: 'dhcpInterface', label: 'DHCP customers interface' }, { name: 'staticInterface', label: 'Static customers interface' },
  { name: 'pppoeGateway', label: 'PPPoE gateway (local-address)' }, { name: 'pppoePool', label: 'PPPoE pool range' }, { name: 'expiredPool', label: 'Expired users pool' },
  { name: 'hotspotGateway', label: 'Hotspot gateway IP' }, { name: 'hotspotPool', label: 'Hotspot pool range' }, { name: 'hotspotServer', label: 'Hotspot server name' }, { name: 'hotspotDns', label: 'Hotspot DNS name' },
  { name: 'dhcpGateway', label: 'DHCP gateway IP' }, { name: 'dhcpPool', label: 'DHCP dynamic pool' }, { name: 'dhcpServer', label: 'DHCP server name' },
  { name: 'staticGateway', label: 'Static gateway IP' }, { name: 'dns', label: 'DNS servers' },
];
function siteForm(site) {
  modal(site ? 'Edit site' : 'New site (MikroTik router)', fields(SITE_FORM, site || { mode: 'simulate', port: 80, wanInterface: 'ether1', pppoeInterface: 'ether2', hotspotInterface: 'ether3', dhcpInterface: 'ether4', staticInterface: 'ether5', pppoeGateway: '10.10.0.1', pppoePool: '10.10.0.2-10.10.255.254', expiredPool: '172.30.0.2-172.30.255.254', hotspotGateway: '192.168.88.1', hotspotPool: '192.168.88.20-192.168.88.254', hotspotServer: 'oneisp-hotspot', hotspotDns: 'wifi.lab', dhcpGateway: '192.168.100.1', dhcpPool: '192.168.100.10-192.168.100.199', dhcpServer: 'oneisp-dhcp', staticGateway: '10.20.0.1', dns: '8.8.8.8,1.1.1.1', username: 'oneisp' }), {
    wide: true, onSubmit: async v => { const s = site ? await PUT(`/api/sites/${site.id}`, v) : await POST('/api/sites', v); toast('Site saved', 'ok'); await sites(true); location.hash = `#/sites/${s.id}`; router(); },
  });
}
routes.sites = async page => {
  const list = await sites(true);
  page.innerHTML = `<div class="card"><div class="toolbar"><h2>Sites (MikroTik routers)</h2><button class="btn primary" id="newSite">+ New Site</button></div>
  <div class="lesson">A <b>site</b> is one MikroTik router (a tower, an estate, a POP). OneISP pushes PPPoE secrets, hotspot users, DHCP leases and queues to it.
  Start in <b>simulate</b> mode, then switch to <b>live</b> and point it at your VirtualBox CHR.</div>
  ${table([{ label: 'Name', render: r => `<b>${esc(r.name)}</b><div class="small muted">${esc(r.location || '')}</div>` }, { label: 'Mode', render: r => pill(r.mode) }, { label: 'Router', render: r => r.mode === 'live' ? `${esc(r.host)}:${r.port} ${pill(r.status || 'unknown')}` : '<span class="muted">virtual</span>' }, { label: 'Identity', render: r => esc(r.identity || '-') }, { label: 'Customers', key: 'customers' }], list, { onRow: r => (location.hash = `#/sites/${r.id}`) })}</div>`;
  $('#newSite').onclick = () => siteForm();
};
routes['sites/:id'] = async (page, id) => {
  const s = await GET(`/api/sites/${id}`);
  const tables = [['ppp-secret', 'PPP Secrets'], ['ppp-active', 'PPP Active'], ['ppp-profile', 'PPP Profiles'], ['hotspot-user', 'Hotspot Users'], ['hotspot-active', 'Hotspot Active'], ['hotspot-profile', 'Hotspot Profiles'], ['queue', 'Simple Queues'], ['lease', 'DHCP Leases'], ['address-list', 'Address Lists'], ['arp', 'ARP'], ['interface', 'Interfaces'], ['address', 'IP Addresses'], ['pool', 'IP Pools'], ['pppoe-server', 'PPPoE Servers'], ['hotspot', 'Hotspot Servers'], ['dhcp-server', 'DHCP Servers'], ['firewall-filter', 'Firewall Filter'], ['nat', 'NAT']];
  page.innerHTML = `<div class="card"><div class="toolbar"><div><h2>${esc(s.name)} ${pill(s.mode)} ${s.mode === 'live' ? pill(s.status || 'unknown') : ''}</h2><div class="muted">${s.mode === 'live' ? `REST API: ${s.useHttps ? 'https' : 'http'}://${esc(s.host)}:${s.port}/rest  user ${esc(s.username)}` : 'Virtual router kept inside the simulator'}${s.lastError ? `<div style="color:var(--bad)">Last error: ${esc(s.lastError)}</div>` : ''}</div></div>
    <div class="actions"><button class="btn" id="test">Test connection</button><button class="btn" id="sync">Sync sessions</button><button class="btn" id="reprov">Re-provision all</button><button class="btn" id="import">Import from MikroTik</button><button class="btn primary" id="edit">Edit</button><button class="btn bad" id="del">Delete</button></div></div>
    <div class="subtabs">${['Router tables', 'Provisioning script', 'Hotspot portal', 'Terminal', 'Settings'].map((t, i) => `<div class="subtab ${i ? '' : 'active'}" data-t="${i}">${t}</div>`).join('')}</div><div id="tabBody"></div></div>`;
  const body = $('#tabBody');
  const tabs = [
    async () => {
      body.innerHTML = `<div class="row"><select id="tbl" style="max-width:260px">${tables.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><button class="btn" id="refresh">Refresh</button><span class="muted small">What WinBox would show for this menu</span></div><div id="tblOut" style="margin-top:14px"></div>`;
      const show = async () => {
        $('#tblOut').innerHTML = 'Loading...';
        try {
          const r = await GET(`/api/sites/${id}/router/${$('#tbl').value}`);
          const keys = [...new Set(r.rows.flatMap(Object.keys))].filter(k => !['login-at'].includes(k)).slice(0, 12);
          $('#tblOut').innerHTML = `<div class="code" style="margin-bottom:10px">[admin@${esc(s.identity || 'MikroTik')}] &gt; ${esc(r.cli)}</div>` + table(keys.map(k => ({ label: k, render: row => esc(row[k] ?? '') })), r.rows, { empty: 'Empty on the router' });
        } catch (e) { $('#tblOut').innerHTML = `<div class="empty" style="color:var(--bad)">${esc(e.message)}</div>`; }
      };
      $('#tbl').onchange = show; $('#refresh').onclick = show; show();
    },
    async () => {
      const script = await GET(`/api/sites/${id}/script`);
      body.innerHTML = `<div class="lesson">This is the base configuration OneISP expects on the router: PPPoE server, hotspot, DHCP, pools, the <span class="mono">OI-EXPIRED</span> profile and firewall rules.
      Paste it into <b>WinBox &rarr; New Terminal</b> (check interface names first!). Set your PC's IP under Settings &rarr; "Server IP" so the walled-garden/redirect rules point at this simulator.</div>
      <div class="row" style="margin-bottom:10px"><button class="btn primary" id="copy">Copy script</button><a class="btn" href="/api/sites/${id}/script" download="oneisp-${id}.rsc">Download .rsc</a>${s.mode === 'live' ? '<button class="btn warn" id="push">Push to router via /rest/execute</button>' : ''}</div><pre>${esc(script)}</pre>`;
      $('#copy').onclick = () => { navigator.clipboard.writeText(script); toast('Copied - paste into WinBox terminal'); };
      if ($('#push')) $('#push').onclick = async () => { if (await confirmBox('Run the whole script on the live router? Duplicate entries will error harmlessly.')) showRouter(await POST(`/api/sites/${id}/script/push`), 'Provisioning script'); };
    },
    async () => {
      body.innerHTML = `<div class="lesson"><b>How a OneISP hotspot works:</b> a phone joins the WiFi &rarr; MikroTik hotspot intercepts the browser and shows <span class="mono">hotspot/login.html</span> &rarr;
      our login.html redirects to the OneISP portal (allowed via walled-garden) &rarr; the customer buys a package with M-Pesa (simulated STK push) or enters a voucher &rarr;
      OneISP creates a hotspot user on the router &rarr; the portal posts username/password back to the router's <span class="mono">$(link-login-only)</span> and they are online.</div>
      <div class="row"><a class="btn primary" href="/portal/hotspot.html?site=${id}" target="_blank">Open portal preview</a><a class="btn" href="/api/sites/${id}/hotspot-login.html">Download login.html for the router</a></div>
      <p class="muted">Upload the downloaded login.html in WinBox &rarr; Files into the <span class="mono">hotspot</span> folder (replace the existing file).</p>`;
    },
    async () => {
      body.innerHTML = `<div class="lesson">Runs a command on the live router through <span class="mono">POST /rest/execute</span>. Try <span class="mono">/ppp active print</span> or <span class="mono">/system resource print</span>.</div>
      <div class="row"><input id="cmd" placeholder="/interface print" style="flex:1"><button class="btn primary" id="run">Run</button></div><pre id="out" style="margin-top:12px;min-height:120px"></pre>`;
      const run = async () => { $('#out').textContent = 'Running...'; try { $('#out').textContent = (await POST(`/api/sites/${id}/terminal`, { command: $('#cmd').value })).output || '(no output)'; } catch (e) { $('#out').textContent = e.message; } };
      $('#run').onclick = run; $('#cmd').onkeydown = e => { if (e.key === 'Enter') run(); };
    },
    async () => { body.innerHTML = `<div class="kv">${SITE_FORM.map(f => `<div>${esc(f.label)}</div><div class="mono">${esc(s[f.name] ?? '')}</div>`).join('')}</div>`; },
  ];
  $$('.subtab').forEach(t => (t.onclick = () => { $$('.subtab').forEach(x => x.classList.remove('active')); t.classList.add('active'); tabs[t.dataset.t](); }));
  tabs[0]();
  $('#edit').onclick = () => siteForm(s);
  $('#del').onclick = async () => { if (await confirmBox('Delete this site?')) { try { await DEL(`/api/sites/${id}`); await sites(true); location.hash = '#/sites'; } catch (e) { fail(e); } } };
  $('#test').onclick = async () => { const r = await POST(`/api/sites/${id}/test`); r.ok ? toast(`Connected: ${esc(r.identity || '')} ${esc(r.resource?.['board-name'] || '')} RouterOS ${esc(r.resource?.version || '')} uptime ${esc(r.resource?.uptime || '')}`, 'ok') : toast(esc(r.error), 'bad'); };
  $('#sync').onclick = async () => { const r = await POST(`/api/sites/${id}/sync`); r.ok ? toast(`PPP active: ${r.pppActive}, hotspot active: ${r.hotspotActive}, customers online: ${r.customersOnline}`, 'ok') : toast(esc(r.error), 'bad'); };
  $('#reprov').onclick = async () => { if (!(await confirmBox('Push every package, customer and voucher of this site to the router? (use after resetting the router or switching to live)'))) return; const r = await POST(`/api/sites/${id}/reprovision`); toast(`${r.count} pushes, ${r.failed} failed. See Router Logs.`, r.failed ? 'bad' : 'ok'); };
  $('#import').onclick = async () => { try { const r = await POST(`/api/sites/${id}/import`); toast(`Imported ${r.created} customers from router`, 'ok'); } catch (e) { fail(e); } };
};

// ============================================================ PACKAGES & POLICIES
async function packageForm(p) {
  const pols = await GET('/api/policies');
  modal(p ? 'Edit package' : 'New package', fields([
    { name: 'name', label: 'Package name', required: true }, { name: 'type', label: 'Connection type', type: 'select', options: Object.entries(TYPES).map(([value, label]) => ({ value, label })) },
    { name: 'price', label: `Price (${CUR})`, type: 'number', required: true }, { name: 'validityValue', label: 'Validity', type: 'number', value: 1 },
    { name: 'validityUnit', label: 'Validity unit', type: 'select', options: ['minutes', 'hours', 'days', 'months'], value: 'months' },
    { name: 'policyId', label: 'Bandwidth policy', type: 'select', blank: '- none -', options: pols.map(x => ({ value: x.id, label: x.name })) },
    { name: 'download', label: 'Download speed', placeholder: '10M', required: true, help: 'k / M / G e.g. 512k, 10M' }, { name: 'upload', label: 'Upload speed', placeholder: '5M', required: true },
    { name: 'sharedUsers', label: 'Shared users (hotspot devices per login)', type: 'number', value: 1 }, { name: 'public', label: 'Show on hotspot portal', type: 'checkbox', value: true },
    { name: 'description', label: 'Description', type: 'textarea', full: true },
  ], p || {}), {
    onSubmit: async v => { const r = p ? await PUT(`/api/packages/${p.id}`, v) : await POST('/api/packages', v); showRouter(r.router, 'Package pushed to routers'); toast('Package saved', 'ok'); await packages(true); router(); },
  });
}
routes.packages = async page => {
  const list = await packages(true);
  page.innerHTML = `<div class="card"><div class="toolbar"><h2>Packages</h2><button class="btn primary" id="new">+ New Package</button></div>
  <div class="lesson">PPPoE packages become <span class="mono">/ppp profile</span> entries and Hotspot packages become <span class="mono">/ip hotspot user profile</span> entries with a <span class="mono">rate-limit</span>.
  Static/DHCP packages are enforced per customer with <span class="mono">/queue simple</span>. MikroTik writes speed as <b>upload/download</b> (rx/tx from the router's view).</div>
  ${table([{ label: 'Name', render: r => `<b>${esc(r.name)}</b>` }, { label: 'Type', render: r => pill(TYPES[r.type]) }, { label: 'Price', render: r => money(r.price) }, { label: 'Validity', render: r => `${r.validityValue} ${r.validityUnit}` },
    { label: 'Speed (down/up)', render: r => `${esc(r.download)} / ${esc(r.upload)}` }, { label: 'MikroTik profile', render: r => ['pppoe', 'hotspot'].includes(r.type) ? `<span class="mono">${esc(r.profile)}</span>` : '<span class="muted">simple queue</span>' }, { label: 'rate-limit', render: r => `<span class="mono small">${esc(r.rateLimit)}</span>` },
    { label: 'Policy', key: 'policyName' }, { label: 'Users', key: 'customers' }, { label: '', render: r => `<button class="btn sm bad" data-del="${r.id}">Delete</button>` }], list, { onRow: r => packageForm(r) })}</div>`;
  $('#new').onclick = () => packageForm();
  $$('[data-del]').forEach(b => (b.onclick = async () => { if (await confirmBox('Delete package?')) { try { await DEL(`/api/packages/${b.dataset.del}`); router(); } catch (e) { fail(e); } } }));
};
function policyForm(p) {
  modal(p ? 'Edit bandwidth policy' : 'New bandwidth policy', `<div class="lesson small">MikroTik burst: the user may exceed max-limit up to <b>burst-limit</b> while their average rate (over <b>burst-time</b>) stays below <b>burst-threshold</b>. Priority 1 is highest, 8 lowest.</div>` + fields([
    { name: 'name', label: 'Name', required: true }, { name: 'priority', label: 'Queue priority (1-8)', type: 'number', value: 8 },
    { name: 'burstEnabled', label: 'Enable burst', type: 'checkbox' }, { name: 'burstTime', label: 'Burst time', placeholder: '16s' },
    { name: 'burstDownload', label: 'Burst limit download', placeholder: '20M' }, { name: 'burstUpload', label: 'Burst limit upload', placeholder: '10M' },
    { name: 'thresholdDownload', label: 'Burst threshold download', placeholder: '8M' }, { name: 'thresholdUpload', label: 'Burst threshold upload', placeholder: '4M' },
    { name: 'description', label: 'Description', type: 'textarea', full: true },
  ], p || {}), { onSubmit: async v => { p ? await PUT(`/api/policies/${p.id}`, v) : await POST('/api/policies', v); toast('Saved (packages using it were re-pushed)', 'ok'); router(); } });
}
routes.policies = async page => {
  const list = await GET('/api/policies');
  page.innerHTML = `<div class="card"><div class="toolbar"><h2>Bandwidth Policy</h2><button class="btn primary" id="new">+ New Policy</button></div>
  ${table([{ label: 'Name', render: r => `<b>${esc(r.name)}</b><div class="small muted">${esc(r.description || '')}</div>` }, { label: 'Burst', render: r => r.burstEnabled ? pill('ok') : pill('disabled') }, { label: 'Burst limit (down/up)', render: r => r.burstEnabled ? `${esc(r.burstDownload)} / ${esc(r.burstUpload)}` : '-' }, { label: 'Threshold', render: r => r.burstEnabled ? `${esc(r.thresholdDownload)} / ${esc(r.thresholdUpload)}` : '-' }, { label: 'Burst time', render: r => esc(r.burstTime || '-') }, { label: 'Priority', key: 'priority' }, { label: 'Packages', key: 'packages' }, { label: '', render: r => `<button class="btn sm bad" data-del="${r.id}">Delete</button>` }], list, { onRow: policyForm })}</div>`;
  $('#new').onclick = () => policyForm();
  $$('[data-del]').forEach(b => (b.onclick = async () => { if (await confirmBox('Delete policy?')) { await DEL(`/api/policies/${b.dataset.del}`); router(); } }));
};

// ============================================================ VOUCHERS
routes.vouchers = async page => {
  const [list, pk, st] = await Promise.all([GET('/api/vouchers'), packages(true), sites()]);
  const batches = [...new Set(list.map(v => v.batch))];
  page.innerHTML = `<div class="card"><div class="toolbar"><h2>Vouchers</h2><div class="actions"><select id="fStatus"><option value="">All statuses</option><option>unused</option><option>used</option><option>expired</option></select><select id="fBatch"><option value="">All batches</option>${batches.map(b => `<option>${b}</option>`).join('')}</select><button class="btn" id="print">Print</button><button class="btn primary" id="gen">Generate vouchers</button></div></div>
  <div class="lesson">Each voucher is a hotspot user on the router whose username = password = code, with <span class="mono">limit-uptime</span> set to the package time. Sell them printed, or let customers type them on the hotspot portal.</div><div id="vt"></div></div>`;
  const draw = () => {
    const rows = list.filter(v => (!$('#fStatus').value || v.status === $('#fStatus').value) && (!$('#fBatch').value || v.batch === $('#fBatch').value));
    $('#vt').innerHTML = table([{ label: 'Code', render: r => `<b class="mono">${esc(r.code)}</b>` }, { label: 'Package', key: 'packageName' }, { label: 'Price', render: r => money(r.price) }, { label: 'Site', key: 'siteName' }, { label: 'Batch', key: 'batch' }, { label: 'Status', render: r => pill(r.status) }, { label: 'Used', render: r => r.usedAt ? `${dt(r.usedAt)}<div class="small muted">${esc(r.usedBy)}</div>` : '-' }, { label: 'Expires', render: r => dt(r.expiresAt) },
      { label: '', render: r => `${r.status === 'unused' ? `<button class="btn sm" data-use="${r.id}">Simulate use</button> ` : ''}<button class="btn sm bad" data-del="${r.id}">Delete</button>` }], rows);
    $$('[data-use]').forEach(b => (b.onclick = async () => { await POST(`/api/vouchers/${b.dataset.use}/use`, {}); toast('Voucher marked used', 'ok'); router(); }));
    $$('[data-del]').forEach(b => (b.onclick = async () => { await DEL(`/api/vouchers/${b.dataset.del}`); router(); }));
    return rows;
  };
  $('#fStatus').onchange = draw; $('#fBatch').onchange = draw;
  const rows = draw();
  $('#print').onclick = () => {
    const vs = list.filter(v => (!$('#fStatus').value || v.status === $('#fStatus').value) && (!$('#fBatch').value || v.batch === $('#fBatch').value) && v.status === 'unused');
    const w = window.open('', '_blank');
    w.document.write(`<title>Vouchers</title><style>body{font-family:sans-serif}.g{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.v{border:1px dashed #555;padding:10px;text-align:center}b{font:700 20px monospace;letter-spacing:2px}</style><div class="g">${vs.map(v => `<div class="v"><div>WiFi: ${esc(v.siteName)}</div><b>${esc(v.code)}</b><div>${esc(v.packageName)} - ${money(v.price)}</div><small>Connect to WiFi, open browser, enter code</small></div>`).join('')}</div><script>print()<\/script>`);
  };
  $('#gen').onclick = () => modal('Generate vouchers', fields([
    { name: 'siteId', label: 'Site', type: 'select', options: st.map(s => ({ value: s.id, label: s.name })) }, { name: 'packageId', label: 'Hotspot package', type: 'select', options: pk.filter(p => p.type === 'hotspot').map(p => ({ value: p.id, label: `${p.name} - ${money(p.price)}` })) },
    { name: 'count', label: 'How many', type: 'number', value: 10 }, { name: 'length', label: 'Code length', type: 'number', value: 6 }, { name: 'prefix', label: 'Prefix (optional)' }, { name: 'numeric', label: 'Numbers only', type: 'checkbox' },
  ]), { submit: 'Generate', onSubmit: async v => { const r = await POST('/api/vouchers/generate', v); showRouter(r.router, `Vouchers batch ${r.batch} (first commands)`); toast(`${r.vouchers.length} vouchers created`, 'ok'); router(); } });
  void rows;
};

// ============================================================ CUSTOMERS
async function customerForm(c, preset = {}) {
  const [st, pk] = await Promise.all([sites(), packages(true)]);
  const v = c || { connectionType: 'pppoe', siteId: st[0]?.id, ...preset };
  const m = modal(c ? `Edit ${c.name}` : 'New Customer', `<div id="cf"></div>`, {
    wide: true, onSubmit: async val => {
      if (val.activate !== undefined) val.activate = val.activate === true;
      if (preset.leadId) val.leadId = preset.leadId;
      const r = c ? await PUT(`/api/customers/${c.id}`, val) : await POST('/api/customers', val);
      showRouter(r.router, c ? 'Customer updated on router' : 'Customer created on router');
      toast('Customer saved', 'ok');
      location.hash = `#/customers/${r.customer.id}`; router();
    },
  });
  const draw = type => {
    const cur = { ...v, ...formData(m.el), connectionType: type };
    const f = [
      { name: 'connectionType', label: 'Connection type', type: 'select', options: Object.entries(TYPES).map(([value, label]) => ({ value, label })) },
      { name: 'siteId', label: 'Site (router)', type: 'select', options: st.map(s => ({ value: s.id, label: s.name })) },
      { name: 'name', label: 'Full name', required: true }, { name: 'phone', label: 'Phone (M-Pesa / SMS)', placeholder: '07XXXXXXXX' }, { name: 'whatsapp', label: 'WhatsApp number (blank = same as phone)' }, { name: 'altPhone', label: 'Alternative phone' },
      { name: 'email', label: 'Email' }, { name: 'idNumber', label: 'ID number' }, { name: 'address', label: 'Address / estate' }, { name: 'location', label: 'Landmark / building' }, { name: 'gps', label: 'GPS (lat,long)', placeholder: '-1.1834,36.9301' }, { name: 'installedAt', label: 'Installation date', type: 'date' }, { name: 'routerModel', label: 'Customer router / CPE model' }, { name: 'routerSerial', label: 'CPE serial / MAC' },
      { name: 'packageId', label: 'Package', type: 'select', options: pk.filter(p => p.type === type).map(p => ({ value: p.id, label: `${p.name} - ${money(p.price)} / ${p.validityValue} ${p.validityUnit}` })) },
    ];
    if (type === 'pppoe' || type === 'hotspot') f.push({ name: 'username', label: 'Username', placeholder: 'auto = account number' }, { name: 'password', label: 'Password', placeholder: 'auto-generated' });
    if (type === 'pppoe') f.push({ name: 'ipAddress', label: 'Fixed IP (optional, sets remote-address)' });
    if (type === 'static') f.push({ name: 'ipAddress', label: 'Static IP', placeholder: 'auto from static range' }, { name: 'macAddress', label: 'MAC (optional, static ARP)' });
    if (type === 'dhcp') f.push({ name: 'macAddress', label: 'Customer router MAC', required: true, placeholder: 'AA:BB:CC:DD:EE:FF' }, { name: 'ipAddress', label: 'Reserved IP', placeholder: 'auto' });
    if (type === 'hotspot') f.push({ name: 'macAddress', label: 'Bind to MAC (optional)' });
    f.push({ name: 'onuSn', label: 'ONU serial (SmartOLT link, optional)', placeholder: 'HWTC1234ABCD' });
    if (!c) f.push({ name: 'activate', label: 'Activate now (expiry = now + package validity)', type: 'checkbox', value: true }, { name: 'initialPayment', label: `Initial payment received (${CUR})`, type: 'number', value: '' });
    else f.push({ name: 'expiresAt', label: 'Expiry', type: 'datetime-local', value: c.expiresAt ? new Date(new Date(c.expiresAt) - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : '' });
    f.push({ name: 'notes', label: 'Notes', type: 'textarea', full: true });
    $('#cf', m.el).innerHTML = fields(f, cur);
    $('[name=connectionType]', m.el).onchange = e => draw(e.target.value);
  };
  draw(v.connectionType);
}

routes.customers = async page => {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const st = await sites(); const pk = await packages();
  const state = { type: params.get('type') || 'pppoe', status: params.get('status') || '', siteId: '', packageId: '', search: '' };
  page.innerHTML = `<div class="grid g4" id="cards"></div>
  <div class="card"><h2>Filters</h2><div class="filters">
    <label>Site<select id="fSite"><option value="">All</option>${st.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
    <label>Status<select id="fStatus"><option value="">All</option><option value="active">Active</option><option value="expired">Expired</option><option value="disabled">Disabled</option><option value="online">Online</option></select></label>
    <label>Connection<select id="fConn"><option value="">All</option>${Object.entries(TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
    <label>Package<select id="fPkg"><option value="">All</option>${pk.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label></div>
    <label>Search:<input id="fSearch" placeholder="name, account, phone, IP, MAC, ONU SN"></label></div>
  <div class="tabs">${Object.entries(TYPES).map(([k, l]) => `<div class="tab ${k === state.type ? 'active' : ''}" data-type="${k}">${l}</div>`).join('')}</div>
  <div class="card"><div class="toolbar"><div class="muted" id="count"></div><div class="actions">
    <select id="bulk" style="width:auto"><option value="">Actions</option><option value="sms">Send SMS</option><option value="resync">Re-sync to router</option><option value="disable">Disable</option><option value="enable">Enable</option><option value="kick">Disconnect session</option><option value="delete">Delete</option></select>
    <a class="btn" href="/api/customers.csv" download>Export CSV</a><button class="btn primary" id="new">New Customer</button></div></div><div id="list"></div></div>`;
  $('#fStatus').value = state.status;
  const draw = async () => {
    const q = new URLSearchParams({ type: $('#fConn').value || state.type, status: $('#fStatus').value, siteId: $('#fSite').value, packageId: $('#fPkg').value, search: $('#fSearch').value });
    const r = await GET('/api/customers?' + q);
    const s = r.stats;
    const stat = (v, l, ic, cls, st) => `<a class="card stat" href="javascript:void(0)" data-st="${st}"><div><div class="v">${v}</div><div class="l">${l}</div></div><div class="bub ${cls}">${ic}</div></a>`;
    $('#cards').innerHTML = stat(s.total, 'Total Users', '&#9786;', 'b-acc', '') + stat(s.active, 'Active Users', '&#10003;', 'b-ok', 'active') + stat(s.expired, 'Expired Users', '&#8722;', 'b-bad', 'expired') + stat(s.disabled, 'Disabled Users', '&#10005;', 'b-dark', 'disabled');
    $$('#cards [data-st]').forEach(a => (a.onclick = () => { $('#fStatus').value = a.dataset.st; draw(); }));
    $('#count').textContent = `${r.rows.length} customers - ${s.online} online overall`;
    const type = $('#fConn').value || state.type;
    $('#list').innerHTML = table([
      { label: '<input type="checkbox" id="all">', render: c => `<input type="checkbox" class="sel" value="${c.id}">` },
      { label: 'Account', render: c => `<b>${esc(c.accountNo)}</b>` },
      { label: 'Name', render: c => `<span class="dotc ${c.online ? 'on' : ''}" title="${c.online ? 'online' : 'offline'}"></span>${esc(c.name)}<div class="small muted">${esc(c.phone || '')}</div>` },
      { label: type === 'static' || type === 'dhcp' ? 'IP / MAC' : 'Username', render: c => ['static', 'dhcp'].includes(c.connectionType) ? `<span class="mono">${esc(c.ipAddress)}</span><div class="small muted mono">${esc(c.macAddress || '')}</div>` : `<span class="mono">${esc(c.username)}</span>${c.sessionIp && c.online ? `<div class="small muted mono">${esc(c.sessionIp)}</div>` : ''}` },
      { label: 'Package', render: c => `${esc(c.packageName)}<div class="small muted">${money(c.price)}</div>` },
      { label: 'Site', key: 'siteName' },
      { label: 'Status', render: c => pill(c.status) },
      { label: 'Expiry', render: c => `${dt(c.expiresAt)}<div class="small muted">${timeLeft(c.expiresAt)}</div>` },
    ], r.rows, { empty: 'No customers match', onRow: c => (location.hash = `#/customers/${c.id}`) });
    const all = $('#all'); if (all) all.onchange = () => $$('.sel').forEach(x => (x.checked = all.checked));
  };
  $$('.tab').forEach(t => (t.onclick = () => { state.type = t.dataset.type; $('#fConn').value = ''; $$('.tab').forEach(x => x.classList.toggle('active', x === t)); draw(); }));
  ['fSite', 'fStatus', 'fConn', 'fPkg'].forEach(i => ($('#' + i).onchange = draw));
  let tmr; $('#fSearch').oninput = () => { clearTimeout(tmr); tmr = setTimeout(draw, 250); };
  $('#new').onclick = () => customerForm(null, { connectionType: state.type });
  $('#bulk').onchange = async e => {
    const action = e.target.value; e.target.value = '';
    const ids = $$('.sel:checked').map(x => Number(x.value));
    if (!action) return;
    if (!ids.length) return toast('Tick some customers first', 'bad');
    let body = { ids, action };
    if (action === 'sms') {
      return modal(`SMS to ${ids.length} customers`, fields([{ name: 'message', label: 'Message (placeholders: {name} {account} {expiry} {package} {price} {paybill})', type: 'textarea', full: true }]), { submit: 'Send', onSubmit: async v => { const r = await POST('/api/customers/bulk', { ...body, message: v.message }); toast(`Sent ${r.ok}`, 'ok'); } });
    }
    if (!(await confirmBox(`${action} ${ids.length} customers?`))) return;
    const r = await POST('/api/customers/bulk', body);
    toast(`${r.ok} done, ${r.failed} failed`, r.failed ? 'bad' : 'ok');
    draw();
  };
  await draw();
};

// Polls an M-Pesa transaction until it finishes, updating a status element.
async function watchTxn(t, el, done) {
  const show = x => { el.innerHTML = `<div class="lesson">${pill(x.status)} ${esc(x.message || '')}</div>`; };
  show(t);
  for (let i = 0; i < 70 && t.status === 'pending'; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try { t = await GET(`/api/portal/txn/${t.id}`); } catch { break; }
    show(t);
  }
  if (done) done(t);
}
const secret = v => `<span class="mono secret" data-v="${esc(v)}">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</span> <a href="javascript:void(0)" class="reveal small">show</a>`;
function bindSecrets(el = document) { $$('.reveal', el).forEach(a => (a.onclick = () => { const s = a.previousElementSibling; const shown = s.dataset.shown === '1'; s.textContent = shown ? '••••••••' : s.dataset.v; s.dataset.shown = shown ? '' : '1'; a.textContent = shown ? 'show' : 'hide'; })); }

routes['customers/:id'] = async (page, id) => {
  const d = await GET(`/api/customers/${id}`);
  const c = d.customer;
  const act = async (action, body, msg) => { const r = await POST(`/api/customers/${id}/action/${action}`, body); if (r.router && r.router.ops) showRouter(r.router, `${action}: ${c.name}`); toast(msg || 'Done', 'ok'); router(); return r; };
  const creds = c.connectionType === 'pppoe' || c.connectionType === 'hotspot';
  page.innerHTML = `<div class="card"><div class="toolbar"><div><h2><span class="dotc ${c.online ? 'on' : ''}"></span>${esc(c.name)} ${pill(c.status)} ${pill(TYPES[c.connectionType])}</h2>
    <div class="muted">Account <b>${esc(c.accountNo)}</b> &middot; ${esc(c.siteName)} &middot; ${esc(c.packageName)} (${money(c.price)}) &middot; expires ${dt(c.expiresAt)} (${timeLeft(c.expiresAt)}) &middot; balance ${money(c.balance)}</div></div>
    <div class="actions"><button class="btn ok" id="stk">Request M-Pesa</button><button class="btn ok" id="pay">Record payment</button><button class="btn primary" id="edit">Edit</button>
    <select id="more" style="width:auto"><option value="">More actions...</option><option value="extend">Extend / set expiry</option><option value="package">Change package</option><option value="${c.disabled ? 'enable' : 'disable'}">${c.disabled ? 'Enable' : 'Disable'}</option><option value="expire">Expire now</option><option value="kick">Disconnect session</option><option value="resync">Re-sync to router</option>${creds ? '<option value="reset-password">Reset password</option><option value="send-credentials">Send login details</option>' : ''}<option value="adjust">Adjust balance / credit</option><option value="sms">Send message</option><option value="note">Add note</option><option value="ticket">Open ticket</option><option value="delete">Delete customer</option></select></div></div>
    <div class="subtabs">${['Overview', 'Statement', 'M-Pesa', 'Fiber / ONU', 'Activity', 'Tickets', 'Messages', 'Router log'].map((t, i) => `<div class="subtab ${i ? '' : 'active'}" data-t="${i}">${t}</div>`).join('')}</div><div id="tb"></div></div>`;
  const tb = $('#tb');
  const kv = pairs => `<div class="kv">${pairs.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div>`;
  const tabs = [
    () => {
      tb.innerHTML = `<div class="grid g2"><div><h3>Customer</h3>${kv([['Phone', esc(c.phone || '-')], ['Alt. phone', esc(c.altPhone || '-')], ['WhatsApp', esc(c.whatsapp || c.phone || '-')], ['Email', esc(c.email || '-')], ['ID number', esc(c.idNumber || '-')], ['Address', esc(c.address || '-')], ['Location / GPS', `${esc(c.location || '-')} ${c.gps ? `<a target="_blank" href="https://maps.google.com/?q=${encodeURIComponent(c.gps)}">map</a>` : ''}`], ['Installed', c.installedAt ? dshort(c.installedAt) : '-'], ['CPE / router', `${esc(c.routerModel || '-')} ${esc(c.routerSerial || '')}`], ['Created', dt(c.createdAt)], ['Notes', esc(c.notes || '-')]])}</div>
      <div><h3>Service</h3>${kv([['Connection', TYPES[c.connectionType]], ...(creds ? [['Username', `<span class="mono">${esc(c.username)}</span>`], ['Password', secret(c.password)]] : []), ['IP address', `<span class="mono">${esc(c.ipAddress || c.sessionIp || 'dynamic (from pool)')}</span>`], ['MAC', `<span class="mono">${esc(c.macAddress || c.sessionMac || '-')}</span>`],
        ['Session', c.online ? `<span class="pill p-online">online</span> ${esc(c.sessionIp || '')} uptime ${esc(c.sessionUptime || '-')}` : `offline${c.lastSeen ? ' &middot; last seen ' + dt(c.lastSeen) : ''}`], ['ONU', `<span class="mono">${esc(c.onuSn || '-')}</span>`], ['Balance', money(c.balance)]])}</div></div>
      <div class="lesson" style="margin-top:18px"><b>On the MikroTik:</b> ${{ pppoe: `look in <span class="mono">PPP &rarr; Secrets</span> for <b>${esc(c.username)}</b> and <span class="mono">PPP &rarr; Active Connections</span> when online. Test it by dialing PPPoE from another VM with these credentials.`, hotspot: `look in <span class="mono">IP &rarr; Hotspot &rarr; Users</span> for <b>${esc(c.username)}</b>.`, static: `look in <span class="mono">Queues</span> for <b>OI-${esc(c.username)}</b> and <span class="mono">IP &rarr; Firewall &rarr; Address Lists</span> (OI-ACTIVE / OI-EXPIRED) for ${esc(c.ipAddress)}.`, dhcp: `look in <span class="mono">IP &rarr; DHCP Server &rarr; Leases</span> for MAC ${esc(c.macAddress)} (block-access toggles on expiry) and the queue <b>OI-${esc(c.username)}</b>.` }[c.connectionType]}</div>`;
      bindSecrets(tb);
    },
    () => {
      const rows = [...d.payments.map(p => ({ at: p.createdAt, type: 'Payment', ref: p.reference, method: p.method, amount: Number(p.amount), note: `${p.periods} period(s) -> ${dt(p.expiryAfter)}`, p })), ...d.adjustments.map(a => ({ at: a.createdAt, type: 'Adjustment', ref: '-', method: '-', amount: Number(a.amount), note: `${a.note} (by ${a.by})` }))].sort((a, b) => b.at.localeCompare(a.at));
      const total = d.payments.reduce((a, p) => a + Number(p.amount), 0);
      tb.innerHTML = `<div class="row" style="margin-bottom:12px"><span class="pill p-ok">Total paid ${money(total)}</span><span class="pill p-new">Balance ${money(c.balance)}</span><span class="pill p-pending">${d.payments.length} payments</span></div>` +
        table([{ label: 'Date', render: r => dt(r.at) }, { label: 'Type', render: r => pill(r.type === 'Payment' ? 'ok' : 'pending').replace(/>(ok|pending)</, `>${r.type}<`) }, { label: 'Amount', render: r => `<b>${money(r.amount)}</b>` }, { label: 'Method', key: 'method' }, { label: 'Reference', render: r => `<span class="mono">${esc(r.ref)}</span>` }, { label: 'Details', key: 'note' }, { label: '', render: (r) => r.p ? `<button class="btn sm" data-rcpt="${r.p.id}">Receipt</button>` : '' }], rows, { empty: 'No payments yet' });
      $$('[data-rcpt]').forEach(b => (b.onclick = () => receipt(d.payments.find(p => p.id === Number(b.dataset.rcpt)), c)));
    },
    () => { tb.innerHTML = mpesaTable(d.mpesa); },
    async () => {
      tb.innerHTML = '<div class="empty">Asking SmartOLT...</div>';
      try {
        const r = await GET(`/api/customers/${id}/onu`);
        if (!r.linked) { tb.innerHTML = `<div class="empty">No ONU linked. Authorize an ONU in SmartOLT and pick this customer (account ${esc(c.accountNo)}), or set "ONU serial" via Edit.</div>`; return; }
        const o = r.onu;
        tb.innerHTML = `<div class="grid g2"><div class="kv"><div>Serial</div><div class="mono">${esc(o.sn)}</div><div>Status</div><div>${pill(String(o.status).toLowerCase().replace(' ', '_'))}</div><div>OLT / PON</div><div>${esc(o.olt_name)} &middot; ${esc(o.board)}/${esc(o.port)} ONU ${esc(o.onu)}</div><div>ONU type</div><div>${esc(o.onu_type)}</div><div>Mode</div><div>${esc(o.mode)} &middot; VLAN ${esc(o.vlan)}</div><div>Zone / ODB</div><div>${esc(o.zone)} / ${esc(o.odb)}</div></div>
          <div class="kv"><div>ONU Rx power</div><div><b style="color:${o.rx_power < -27 ? 'var(--bad)' : o.rx_power < -25 ? 'var(--warn)' : 'var(--ok)'}">${o.rx_power} dBm</b></div><div>OLT Rx power</div><div>${o.olt_rx_power} dBm</div><div>Distance</div><div>${o.distance} m</div><div>Uptime</div><div>${esc(o.uptime || '-')}</div><div>Last down cause</div><div>${esc(o.last_down_cause || '-')}</div></div></div>
          <div class="row" style="margin-top:16px"><button class="btn" data-onu="reboot">Reboot ONU</button><button class="btn" data-onu="resync">Resync config</button><button class="btn warn" data-onu="disable">Disable ONU</button><button class="btn" data-onu="enable">Enable ONU</button><a class="btn primary" target="_blank" href="${esc(o.url || '#')}">Open in SmartOLT</a></div>`;
        $$('[data-onu]').forEach(b => (b.onclick = async () => { try { await POST(`/api/customers/${id}/onu/${b.dataset.onu}`); toast(`ONU ${b.dataset.onu} sent`, 'ok'); setTimeout(() => tabs[3](), 1500); } catch (e) { fail(e); } }));
      } catch (e) { tb.innerHTML = `<div class="empty" style="color:var(--bad)">${esc(e.message)}<br><span class="muted">Is SmartOLT running?</span></div>`; }
    },
    () => { tb.innerHTML = table([{ label: 'Date', render: a => dt(a.createdAt) }, { label: 'Action', render: a => pill(a.action === 'note' ? 'new' : 'unknown').replace(/>(new|unknown)</, `>${esc(a.action)}<`) }, { label: 'Details', key: 'detail' }, { label: 'By', key: 'by' }], d.activity, { empty: 'No activity yet' }); },
    () => { tb.innerHTML = table([{ label: 'No', key: 'number' }, { label: 'Subject', key: 'subject' }, { label: 'Priority', render: t => pill(t.priority) }, { label: 'Status', render: t => pill(t.status) }, { label: 'Opened', render: t => dt(t.createdAt) }], d.tickets, { onRow: t => (location.hash = `#/tickets/${t.id}`) }); },
    () => { tb.innerHTML = table([{ label: 'Date', render: m => dt(m.createdAt) }, { label: 'Channel', render: m => pill(m.channel || 'sms') }, { label: 'Type', key: 'kind' }, { label: 'To', key: 'to' }, { label: 'Message', key: 'message' }, { label: 'Status', render: m => msgStatus(m.status) }], d.sms); },
    () => { tb.innerHTML = logsHtml(d.logs); bindLogs(); },
  ];
  $$('.subtab').forEach(t => (t.onclick = () => { $$('.subtab').forEach(x => x.classList.remove('active')); t.classList.add('active'); tabs[t.dataset.t](); }));
  tabs[0]();
  $('#edit').onclick = () => customerForm(c);
  $('#pay').onclick = () => paymentForm(c);
  $('#stk').onclick = () => {
    const m = modal(`Request M-Pesa payment from ${c.name}`, `<div class="lesson small">Sends an STK push (PIN prompt) to the customer's phone. When they pay, the account is renewed automatically and they get a confirmation message.</div>` + fields([{ name: 'phone', label: 'M-Pesa phone', value: c.phone }, { name: 'amount', label: `Amount (${CUR})`, type: 'number', value: c.price }]) + '<div id="stkst"></div>', {
      submit: 'Send STK push', onSubmit: async v => { const t = await POST(`/api/customers/${id}/action/stk`, v); watchTxn(t.router, $('#stkst', m.el), x => { if (x.status === 'success') { toast('Payment received', 'ok'); setTimeout(() => { m.close(); router(); }, 1500); } }); return false; },
    });
  };
  const more = {
    extend: () => modal('Extend / set expiry', fields([{ name: 'days', label: 'Add days (free extension / compensation)', type: 'number', value: 1 }, { name: 'expiresAt', label: 'OR set exact expiry', type: 'datetime-local' }]), { onSubmit: v => act('extend', v, 'Expiry updated') }),
    package: async () => { const pk = (await packages(true)).filter(p => p.type === c.connectionType); modal('Change package', `<div class="lesson small">The new speed applies immediately (the session is reconnected). Expiry stays the same.</div>` + fields([{ name: 'packageId', label: 'New package', type: 'select', options: pk.map(p => ({ value: p.id, label: `${p.name} - ${money(p.price)}` })), value: c.packageId }]), { onSubmit: async v => { const r = await PUT(`/api/customers/${id}`, v); showRouter(r.router, 'Package changed'); toast('Package changed', 'ok'); router(); } }); },
    disable: () => act('disable', {}, 'Customer disabled'), enable: () => act('enable', {}, 'Customer enabled'),
    expire: async () => { if (await confirmBox('Set expiry to now? The router entry will be suspended - watch it happen in WinBox.')) act('expire', {}, 'Expired'); },
    kick: () => act('kick', {}, 'Session removed'), resync: () => act('resync', {}, 'Re-synced to router'),
    'reset-password': () => modal('Reset password', fields([{ name: 'channel', label: 'Send the new login by', type: 'select', options: ['sms', 'whatsapp', 'both'] }]), { onSubmit: v => act('reset-password', v, 'New password set and sent') }),
    'send-credentials': () => modal('Send login details', fields([{ name: 'channel', label: 'Send by', type: 'select', options: ['sms', 'whatsapp', 'both'] }]), { submit: 'Send', onSubmit: v => act('send-credentials', v, 'Login details sent') }),
    adjust: () => modal('Adjust balance', `<div class="lesson small">Positive = credit (e.g. compensation, overpayment), negative = debit. When a payment arrives, the balance is used first.</div>` + fields([{ name: 'amount', label: `Amount (${CUR})`, type: 'number' }, { name: 'note', label: 'Reason' }]), { onSubmit: v => act('adjust-balance', v, 'Balance adjusted') }),
    sms: () => modal(`Message ${c.name}`, fields([{ name: 'channel', label: 'Channel', type: 'select', options: ['sms', 'whatsapp', 'both'] }, { name: 'message', label: 'Message ({name} {account} {expiry} {package} {price} {paybill} {username} {password})', type: 'textarea', full: true }]), { submit: 'Send', onSubmit: async v => { await POST(`/api/customers/${id}/action/sms`, v); toast('Message queued', 'ok'); router(); } }),
    note: () => modal('Add note', fields([{ name: 'text', label: 'Note (saved in the activity log)', type: 'textarea', full: true }]), { onSubmit: v => act('note', v, 'Note added') }),
    ticket: () => ticketForm({ customerId: c.id }),
    delete: async () => { if (await confirmBox(`Delete ${esc(c.name)} and remove them from the router?`)) { const r = await DEL(`/api/customers/${id}`); showRouter(r.router, 'Customer removed'); location.hash = '#/customers'; } },
  };
  $('#more').onchange = e => { const a = e.target.value; e.target.value = ''; if (more[a]) more[a](); };
};
const msgStatus = s => { s = String(s || ''); return s.startsWith('failed') ? `<span class="pill p-failed" title="${esc(s)}">failed</span><div class="small" style="color:var(--bad)">${esc(s.slice(8))}</div>` : s === 'sending' ? pill('pending') : `<span class="pill p-ok">${esc(s.split(' (')[0])}</span>`; };
function mpesaTable(list) {
  return table([{ label: 'Date', render: r => dt(r.createdAt) }, { label: 'Type', render: r => `${r.kind === 'c2b' ? 'Paybill (C2B)' : 'STK push'}<div class="small muted">${esc(r.purpose)} &middot; ${esc(r.mode)}</div>` },
    { label: 'Phone', render: r => `<span class="mono">${esc(r.phone)}</span>${r.payer ? `<div class="small muted">${esc(r.payer)}</div>` : ''}` }, { label: 'Amount', render: r => `<b>${money(r.amount)}</b>` }, { label: 'Account ref', render: r => esc(r.reference || '-') },
    { label: 'Receipt', render: r => `<span class="mono">${esc(r.receipt || '-')}</span>` }, { label: 'Status', render: r => pill(r.status) }, { label: 'Message', render: r => `<span class="small">${esc(r.message || '')}</span>${r.lastError ? `<div class="small" style="color:var(--bad)">${esc(r.lastError)}</div>` : ''}` },
    { label: '', render: r => r.status === 'unmatched' ? `<button class="btn sm ok" data-alloc="${r.id}">Allocate</button>` : r.status === 'pending' && r.mode !== 'simulate' ? `<button class="btn sm" data-recheck="${r.id}">Check now</button>` : '' }], list, { empty: 'No M-Pesa transactions yet' });
}

// ============================================================ M-PESA
routes.mpesa = async page => {
  const [list, s] = await Promise.all([GET('/api/mpesa'), GET('/api/settings')]);
  const mode = s.mpesa.mode;
  page.innerHTML = `<div class="card"><div class="toolbar"><div><h2>M-Pesa transactions ${pill(mode === 'simulate' ? 'simulate' : 'live')} <span class="muted small">${esc(mode)}</span></h2></div>
    <div class="actions"><button class="btn" id="test">Test connection</button><button class="btn ok" id="stk">Test STK push</button><button class="btn" id="c2b">Simulate paybill payment</button><button class="btn" id="reg">Register C2B URLs</button><button class="btn" id="cbs">Callback log</button><a class="btn" href="#/settings">Settings</a></div></div>
  <div class="lesson small"><b>STK push</b>: we ask Safaricom to show a PIN prompt on the customer's phone; the result comes back by <b>callback</b> (needs a public https URL) or by <b>polling the query API</b> every few seconds (works on your PC with no public URL).
  <b>C2B / Paybill</b>: customer pays from the M-Pesa menu with their account number; Safaricom POSTs a confirmation to us and we renew that account. Unknown account numbers land here as <i>unmatched</i> for you to allocate.</div>
  <div id="ml">${mpesaTable(list)}</div></div>`;
  const bindRows = () => {
    $$('[data-alloc]').forEach(b => (b.onclick = async () => { const cs = (await GET('/api/customers')).rows; modal('Allocate payment to a customer', fields([{ name: 'customerId', label: 'Customer', type: 'select', options: cs.map(x => ({ value: x.id, label: `${x.accountNo} ${x.name}` })), full: true }]), { onSubmit: async v => { const r = await POST(`/api/mpesa/${b.dataset.alloc}/allocate`, v); showRouter(r.router, 'Payment allocated'); router(); } }); }));
    $$('[data-recheck]').forEach(b => (b.onclick = async () => { await POST(`/api/mpesa/${b.dataset.recheck}/recheck`); router(); }));
  };
  bindRows();
  $('#test').onclick = async () => { try { toast(esc((await POST('/api/mpesa/test')).message), 'ok'); } catch (e) { fail(e); } };
  $('#stk').onclick = () => { const m = modal('Test STK push', `<div class="lesson small">Sandbox: use the test number <b>254708374149</b> or your own Safaricom number (sandbox pushes reach real phones but no money moves).</div>` + fields([{ name: 'phone', label: 'Phone', value: '254708374149' }, { name: 'amount', label: 'Amount', type: 'number', value: 1 }]) + '<div id="st"></div>', { submit: 'Send', onSubmit: async v => { const t = await POST('/api/mpesa/stk', v); watchTxn(t, $('#st', m.el)); return false; } }); };
  $('#c2b').onclick = () => modal('Simulate paybill (C2B) payment', `<div class="lesson small">${mode === 'simulate' ? 'Simulate mode: we post a Safaricom-style confirmation to our own endpoint.' : 'Sandbox: Safaricom sends the confirmation to your registered public URL (register C2B URLs first).'} Use a customer account number as the bill reference.</div>` + fields([{ name: 'billRef', label: 'Account number (BillRefNumber)', value: 'LN1001' }, { name: 'amount', label: 'Amount', type: 'number', value: 1500 }, { name: 'phone', label: 'Payer phone', value: '254708374149' }]), { submit: 'Pay', onSubmit: async v => { await POST('/api/mpesa/c2b/simulate', v); toast('Paybill payment sent', 'ok'); setTimeout(router, 1500); } });
  $('#reg').onclick = async () => { try { const r = await POST('/api/mpesa/c2b/register'); toast(esc(r.ResponseDescription || JSON.stringify(r)), 'ok'); } catch (e) { fail(e); } };
  $('#cbs').onclick = async () => { const l = await GET('/api/mpesa/callbacks'); modal('Raw callbacks received from Safaricom', `<pre>${esc(JSON.stringify(l, null, 2))}</pre>`, { wide: true }); };
  timer = setInterval(async () => { if (!location.hash.startsWith('#/mpesa')) return clearInterval(timer); $('#ml').innerHTML = mpesaTable(await GET('/api/mpesa')); bindRows(); }, 5000);
};
let timer = null;

function receipt(p, c) {
  const w = window.open('', '_blank');
  w.document.write(`<title>Receipt ${esc(p.reference)}</title><body style="font-family:sans-serif;max-width:420px;margin:30px auto"><h2>Payment receipt</h2><p>Ref: <b>${esc(p.reference)}</b><br>Date: ${dt(p.createdAt)}</p><p>Customer: ${esc(p.customerName)} (${esc(p.accountNo)})<br>Package: ${esc(p.packageName || '-')}</p><h3>Amount: ${money(p.amount)} via ${esc(p.method)}</h3><p>Valid until: ${dt(p.expiryAfter)}</p><script>print()<\/script>`);
  void c;
}

async function paymentForm(c) {
  let custOpts = [];
  if (!c) custOpts = (await GET('/api/customers')).rows.map(x => ({ value: x.id, label: `${x.accountNo} - ${x.name} (${x.packageName} ${money(x.price)})` }));
  modal(c ? `Payment for ${c.name}` : 'Record payment', `<div class="lesson small">Each time the balance covers the package price, expiry moves forward by one validity period and the router entry is re-enabled.</div>` + fields([
    ...(c ? [] : [{ name: 'customerId', label: 'Customer', type: 'select', options: custOpts, full: true }]),
    { name: 'amount', label: `Amount (${CUR})`, type: 'number', value: c?.price || '', required: true }, { name: 'method', label: 'Method', type: 'select', options: ['mpesa', 'cash', 'bank', 'card'] },
    { name: 'reference', label: 'Reference (blank = auto)' }, { name: 'note', label: 'Note' },
  ]), { onSubmit: async v => { if (c) v.customerId = c.id; const r = await POST('/api/payments', v); showRouter(r.router, 'Payment applied'); toast(`Paid. New expiry ${dt(r.customer.expiresAt)}`, 'ok'); router(); } });
}

// ============================================================ LEADS / TICKETS
const LEAD_STATUS = ['new', 'contacted', 'survey', 'converted', 'lost'];
function leadForm(l) {
  modal(l ? 'Edit lead' : 'New lead', fields([{ name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email' }, { name: 'location', label: 'Location' }, { name: 'source', label: 'Source', type: 'select', options: ['Walk-in', 'Facebook', 'Referral', 'Flyer', 'Website', 'Other'] }, { name: 'interest', label: 'Interested in' }, { name: 'status', label: 'Status', type: 'select', options: LEAD_STATUS }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }], l || {}),
    { onSubmit: async v => { l ? await PUT(`/api/leads/${l.id}`, v) : await POST('/api/leads', v); router(); } });
}
routes.leads = async page => {
  const list = await GET('/api/leads');
  page.innerHTML = `<div class="card"><div class="toolbar"><h2>Leads</h2><button class="btn primary" id="new">+ New Lead</button></div>
  <div class="grid g4" style="margin-bottom:16px">${LEAD_STATUS.slice(0, 4).map(s => `<div class="card stat" style="margin:0;padding:18px"><div><div class="v">${list.filter(l => l.status === s).length}</div><div class="l">${s}</div></div></div>`).join('')}</div>
  ${table([{ label: 'Name', render: l => `<b>${esc(l.name)}</b><div class="small muted">${esc(l.phone || '')}</div>` }, { label: 'Location', key: 'location' }, { label: 'Source', key: 'source' }, { label: 'Interest', key: 'interest' }, { label: 'Status', render: l => pill(l.status) }, { label: 'Notes', key: 'notes' }, { label: 'Created', render: l => dshort(l.createdAt) },
    { label: '', render: l => `${l.status !== 'converted' ? `<button class="btn sm ok" data-conv="${l.id}">Convert</button> ` : `<a href="#/customers/${l.customerId}">customer</a> `}<button class="btn sm bad" data-del="${l.id}">Delete</button>` }], list, { onRow: leadForm })}</div>`;
  $('#new').onclick = () => leadForm();
  $$('[data-conv]').forEach(b => (b.onclick = () => { const l = list.find(x => x.id === Number(b.dataset.conv)); customerForm(null, { name: l.name, phone: l.phone, email: l.email, address: l.location, notes: l.notes, leadId: l.id, connectionType: 'pppoe' }); }));
  $$('[data-del]').forEach(b => (b.onclick = async () => { await DEL(`/api/leads/${b.dataset.del}`); router(); }));
};
async function ticketForm(preset = {}) {
  const [cs, users] = await Promise.all([GET('/api/customers'), GET('/api/users')]);
  modal('New ticket', fields([{ name: 'customerId', label: 'Customer', type: 'select', blank: '- none -', options: cs.rows.map(c => ({ value: c.id, label: `${c.accountNo} ${c.name}` })), full: true }, { name: 'subject', label: 'Subject', required: true, full: true }, { name: 'category', label: 'Category', type: 'select', options: ['No internet', 'Speed', 'Fiber', 'Billing', 'Installation', 'Relocation', 'Other'] }, { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high'], value: 'medium' }, { name: 'assignedTo', label: 'Assign to', type: 'select', blank: '- unassigned -', options: users.map(u => u.username) }, { name: 'description', label: 'Description', type: 'textarea', full: true }], preset),
    { onSubmit: async v => { const t = await POST('/api/tickets', v); location.hash = `#/tickets/${t.id}`; router(); } });
}
routes.tickets = async page => {
  const list = await GET('/api/tickets');
  page.innerHTML = `<div class="card"><div class="toolbar"><h2>Tickets</h2><button class="btn primary" id="new">+ New Ticket</button></div>
  ${table([{ label: 'No', render: t => `<b>${esc(t.number)}</b>` }, { label: 'Subject', key: 'subject' }, { label: 'Customer', key: 'customerName' }, { label: 'Category', key: 'category' }, { label: 'Priority', render: t => pill(t.priority) }, { label: 'Status', render: t => pill(t.status) }, { label: 'Assigned', render: t => esc(t.assignedTo || '-') }, { label: 'Opened', render: t => dt(t.createdAt) }], list, { onRow: t => (location.hash = `#/tickets/${t.id}`) })}</div>`;
  $('#new').onclick = () => ticketForm();
};
routes['tickets/:id'] = async (page, id) => {
  const t = await GET(`/api/tickets/${id}`);
  page.innerHTML = `<div class="card"><div class="toolbar"><div><h2>${esc(t.number)} &middot; ${esc(t.subject)} ${pill(t.status)} ${pill(t.priority)}</h2><div class="muted">${t.customer ? `<a href="#/customers/${t.customer.id}">${esc(t.customer.name)} (${esc(t.customer.accountNo)})</a> &middot; ` : ''}${esc(t.category || '')} &middot; opened by ${esc(t.openedBy)} ${dt(t.createdAt)} &middot; assigned ${esc(t.assignedTo || '-')}</div></div>
  <div class="actions"><select id="st" style="width:auto">${['open', 'in_progress', 'resolved', 'closed'].map(s => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select><button class="btn bad" id="del">Delete</button></div></div>
  <p>${esc(t.description || '')}</p><h3>Updates</h3>${t.comments.map(c => `<div class="comment"><b>${esc(c.by)}</b> <span class="muted small">${dt(c.at)}</span><div>${esc(c.text)}</div></div>`).join('') || '<div class="muted">No updates</div>'}
  <form id="cm" class="row" style="margin-top:14px"><input name="text" placeholder="Add an update..." style="flex:1"><button class="btn primary">Post</button></form></div>`;
  $('#st').onchange = async e => { await PUT(`/api/tickets/${id}`, { status: e.target.value }); router(); };
  $('#cm').onsubmit = async e => { e.preventDefault(); await POST(`/api/tickets/${id}/comments`, formData(e.target)); router(); };
  $('#del').onclick = async () => { await DEL(`/api/tickets/${id}`); location.hash = '#/tickets'; };
};

// ============================================================ PAYMENTS / EXPENSES
routes.payments = async page => {
  page.innerHTML = `<div class="card"><div class="toolbar"><h2>Payments</h2><div class="actions"><input type="date" id="from"><input type="date" id="to"><select id="method"><option value="">All methods</option><option>mpesa</option><option>cash</option><option>bank</option><option>card</option><option>voucher</option></select><input id="q" placeholder="search"><button class="btn" id="csv">Export CSV</button><button class="btn primary" id="new">Record payment</button></div></div><div id="pl"></div></div>`;
  let rows = [];
  const draw = async () => {
    rows = await GET('/api/payments?' + new URLSearchParams({ from: $('#from').value, to: $('#to').value, method: $('#method').value, search: $('#q').value }));
    const total = rows.reduce((a, p) => a + Number(p.amount), 0);
    $('#pl').innerHTML = `<div class="row" style="margin-bottom:12px"><span class="pill p-ok">Total: ${money(total)}</span><span class="pill p-new">${rows.length} payments</span></div>` +
      table([{ label: 'Date', render: p => dt(p.createdAt) }, { label: 'Customer', render: p => p.customerId ? `<a href="#/customers/${p.customerId}">${esc(p.customerName)}</a>` : esc(p.customerName) }, { label: 'Account', key: 'accountNo' }, { label: 'Package', key: 'packageName' }, { label: 'Amount', render: p => `<b>${money(p.amount)}</b>` }, { label: 'Method', render: p => pill(p.method) }, { label: 'Ref', render: p => `<span class="mono">${esc(p.reference)}</span>` }, { label: 'By', key: 'by' }, { label: '', render: p => `<button class="btn sm" data-r="${p.id}">Receipt</button>` }], rows.slice(0, 500));
    $$('[data-r]').forEach(b => (b.onclick = () => receipt(rows.find(p => p.id === Number(b.dataset.r)))));
  };
  ['from', 'to', 'method'].forEach(i => ($('#' + i).onchange = draw)); $('#q').oninput = draw;
  $('#new').onclick = () => paymentForm();
  $('#csv').onclick = () => { const csv = ['date,customer,account,package,amount,method,reference', ...rows.map(p => [p.createdAt, p.customerName, p.accountNo, p.packageName, p.amount, p.method, p.reference].map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','))].join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'payments.csv'; a.click(); };
  draw();
};
routes.expenses = async page => {
  const [list, dash] = await Promise.all([GET('/api/expenses'), GET('/api/dashboard')]);
  page.innerHTML = `<div class="grid g3"><div class="card stat"><div><div class="v">${money(dash.stats.revenueMonth)}</div><div class="l">Revenue this month</div></div></div><div class="card stat"><div><div class="v">${money(dash.stats.expensesMonth)}</div><div class="l">Expenses this month</div></div></div><div class="card stat"><div><div class="v">${money(dash.stats.revenueMonth - dash.stats.expensesMonth)}</div><div class="l">Profit</div></div></div></div>
  <div class="card"><div class="toolbar"><h2>Expenses</h2><button class="btn primary" id="new">+ Add expense</button></div>${table([{ label: 'Date', key: 'date' }, { label: 'Category', key: 'category' }, { label: 'Amount', render: e => money(e.amount) }, { label: 'Note', key: 'note' }, { label: 'By', key: 'by' }, { label: '', render: e => `<button class="btn sm bad" data-del="${e.id}">Delete</button>` }], list)}</div>`;
  $('#new').onclick = () => modal('Add expense', fields([{ name: 'category', label: 'Category', type: 'select', options: ['Bandwidth', 'Equipment', 'Salaries', 'Rent', 'Power', 'Transport', 'Marketing', 'Other'] }, { name: 'amount', label: 'Amount', type: 'number', required: true }, { name: 'date', label: 'Date', type: 'date', value: new Date().toISOString().slice(0, 10) }, { name: 'note', label: 'Note' }]), { onSubmit: async v => { await POST('/api/expenses', v); router(); } });
  $$('[data-del]').forEach(b => (b.onclick = async () => { await DEL(`/api/expenses/${b.dataset.del}`); router(); }));
};

// ============================================================ SMS / LOGS / USERS / SETTINGS
routes.sms = async page => {
  const [list, s] = await Promise.all([GET('/api/sms'), GET('/api/settings')]);
  const provider = ch => s.messaging[ch].provider;
  page.innerHTML = `<div class="card"><h2>Send message</h2><div class="lesson small">SMS provider: <b>${esc(provider('sms'))}</b> &middot; WhatsApp provider: <b>${esc(provider('whatsapp'))}</b> &middot; change in <a href="#/settings">Settings</a>. "simulate" only writes to the outbox below.</div><form id="f">${fields([{ name: 'channel', label: 'Channel', type: 'select', options: ['sms', 'whatsapp', 'both'], value: s.messaging.defaultChannel }, { name: 'group', label: 'Recipients', type: 'select', options: [{ value: '', label: 'Single number' }, { value: 'all', label: 'All customers' }, { value: 'active', label: 'Active customers' }, { value: 'expired', label: 'Expired customers' }, { value: 'disabled', label: 'Disabled customers' }] }, { name: 'to', label: 'Phone (single number)' }, { name: 'message', label: 'Message - placeholders {name} {account} {package} {expiry} {price} {paybill}', type: 'textarea', full: true }])}<button class="btn primary">Send</button></form></div>
  <div class="card"><h2>Outbox</h2><div id="ob"></div></div>`;
  const draw = l => { $('#ob').innerHTML = table([{ label: 'Date', render: m => dt(m.createdAt) }, { label: 'Channel', render: m => pill(m.channel || 'sms') }, { label: 'To', key: 'to' }, { label: 'Type', key: 'kind' }, { label: 'Message', key: 'message' }, { label: 'Status', render: m => msgStatus(m.status) }], l); };
  draw(list);
  $('#f').onsubmit = async e => { e.preventDefault(); try { const r = await POST('/api/sms/send', formData(e.target)); toast(`Queued ${r.sent}`, 'ok'); setTimeout(async () => draw(await GET('/api/sms')), 1500); } catch (err) { fail(err); } };
  timer = setInterval(async () => { if (!location.hash.startsWith('#/sms')) return clearInterval(timer); draw(await GET('/api/sms')); }, 5000);
};
function logsHtml(list) {
  return list.map((l, i) => `<div class="comment"><div class="row"><b>${esc(l.context)}</b>${pill(l.ok ? 'ok' : 'error')}${pill(l.mode)}<span class="muted small">${esc(l.siteName)} &middot; ${dt(l.createdAt)}</span><span class="spacer"></span><button class="btn sm" data-log="${i}">Commands (${l.ops.length})</button></div>
    <div class="hidden" id="log${i}">${l.ops.map(o => `<div class="cmd ${o.ok ? 'ok' : 'bad'}">${esc(o.cli)}${o.note ? `<div class="n"># ${esc(o.note)}</div>` : ''}${o.error ? `<div class="e">${esc(o.error)}</div>` : ''}</div>`).join('')}</div></div>`).join('') || '<div class="empty">No router activity</div>';
}
function bindLogs() { $$('[data-log]').forEach(b => (b.onclick = () => $('#log' + b.dataset.log).classList.toggle('hidden'))); }
routes.logs = async page => {
  const list = await GET('/api/logs');
  page.innerHTML = `<div class="card"><div class="toolbar"><h2>Router Logs</h2><button class="btn bad" id="clr">Clear</button></div><div class="lesson">Every change OneISP made to a router, with the exact RouterOS commands. This is the best place to learn what billing software does behind the scenes.</div>${logsHtml(list)}</div>`;
  bindLogs();
  $('#clr').onclick = async () => { await DEL('/api/logs'); router(); };
};
routes.users = async page => {
  const list = await GET('/api/users');
  const form = u => modal(u ? 'Edit user' : 'New user', fields([{ name: 'username', label: 'Username', required: !u }, { name: 'name', label: 'Name' }, { name: 'phone', label: 'Phone' }, { name: 'role', label: 'Role', type: 'select', options: ['admin', 'support', 'cashier', 'technician'] }, { name: 'password', label: u ? 'New password (blank = keep)' : 'Password', type: 'password' }], u || {}), { onSubmit: async v => { u ? await PUT(`/api/users/${u.id}`, v) : await POST('/api/users', v); router(); } });
  page.innerHTML = `<div class="card"><div class="toolbar"><h2>Staff users</h2><button class="btn primary" id="new">+ New user</button></div>${table([{ label: 'Username', key: 'username' }, { label: 'Name', key: 'name' }, { label: 'Phone', key: 'phone' }, { label: 'Role', render: u => pill(u.role) }, { label: '', render: u => `<button class="btn sm bad" data-del="${u.id}">Delete</button>` }], list, { onRow: form })}</div>`;
  $('#new').onclick = () => form();
  $$('[data-del]').forEach(b => (b.onclick = async () => { try { await DEL(`/api/users/${b.dataset.del}`); router(); } catch (e) { fail(e); } }));
};
routes.settings = async page => {
  const s = await GET('/api/settings');
  const mp = s.mpesa, ms = s.messaging;
  page.innerHTML = `<form id="f"><div class="card"><h2>Company & billing</h2>${fields([{ name: 'companyName', label: 'Company name' }, { name: 'currency', label: 'Currency' }, { name: 'paybill', label: 'M-Pesa paybill (shown in messages)' }, { name: 'accountPrefix', label: 'Account number prefix' },
    { name: 'expiredAction', label: 'When a PPPoE customer expires', type: 'select', options: [{ value: 'disable', label: 'Disable the PPP secret' }, { value: 'redirect', label: 'Move to OI-EXPIRED profile (redirect to pay page)' }] }, { name: 'reminderDays', label: 'Send expiry reminder N days before', type: 'number' },
    { name: 'serverIp', label: 'Server IP (this PC as seen by MikroTik)', help: 'VirtualBox host-only adapter is usually 192.168.56.1' }, { name: 'smsEnabled', label: 'Automatic messages enabled (welcome, payment, reminders...)', type: 'checkbox' }], s)}</div>

  <div class="card"><h2>M-Pesa (Safaricom Daraja)</h2>
  <div class="lesson small">Get keys at <a href="https://developer.safaricom.co.ke" target="_blank">developer.safaricom.co.ke</a> &rarr; My Apps. Sandbox test values: shortcode <b>174379</b> with the published passkey (pre-filled), test phone <b>254708374149</b>.
  <b>Public base URL</b> is optional for STK (we poll the query API) but required for real callbacks and C2B - run <span class="mono">cloudflared tunnel --url http://localhost:${location.port || 80}</span> and paste the https URL it prints.</div>
  ${fields([{ name: 'mp_mode', label: 'Mode', type: 'select', value: mp.mode, options: [{ value: 'simulate', label: 'Simulate (no internet needed, auto-approves)' }, { value: 'sandbox', label: 'Daraja sandbox (real API, test money)' }, { value: 'production', label: 'Production (real money!)' }] },
    { name: 'mp_type', label: 'Shortcode type', type: 'select', value: mp.type, options: [{ value: 'paybill', label: 'Paybill (CustomerPayBillOnline)' }, { value: 'till', label: 'Till / Buy goods (CustomerBuyGoodsOnline)' }] },
    { name: 'mp_consumerKey', label: 'Consumer key', value: mp.consumerKey }, { name: 'mp_consumerSecret', label: 'Consumer secret', type: 'password', value: mp.consumerSecret },
    { name: 'mp_shortcode', label: 'Business shortcode (STK)', value: mp.shortcode }, { name: 'mp_passkey', label: 'Lipa na M-Pesa passkey', type: 'password', value: mp.passkey },
    { name: 'mp_till', label: 'Till number (only for Buy goods)', value: mp.till }, { name: 'mp_c2bShortcode', label: 'C2B shortcode (sandbox: 600982)', value: mp.c2bShortcode },
    { name: 'mp_callbackBase', label: 'Public base URL (https, optional)', value: mp.callbackBase, placeholder: 'https://xxxx.trycloudflare.com' }, { name: 'mp_c2bRejectUnknown', label: 'Reject paybill payments with unknown account numbers', type: 'checkbox', value: mp.c2bRejectUnknown }])}
  <div class="row"><button type="button" class="btn" id="mpTest">Save & test keys</button><a class="btn" href="#/mpesa">M-Pesa transactions</a></div></div>

  <div class="card"><h2>Messaging (SMS & WhatsApp)</h2>
  <div class="lesson small"><b>SMS</b>: Africa's Talking - create a free account, use the <i>sandbox</i> app (username <span class="mono">sandbox</span>) and its API key; messages appear in the AT simulator.<br>
  <b>WhatsApp</b>: either <b>Twilio</b> WhatsApp sandbox (easiest: send "join &lt;code&gt;" from your WhatsApp to +1 415 523 8886 first) or <b>Meta WhatsApp Cloud API</b> (free test number; add your phone as a recipient; free-text works only within 24h after the customer messaged you, otherwise set an approved template).</div>
  ${fields([{ name: 'ms_defaultChannel', label: 'Default channel for automatic messages', type: 'select', value: ms.defaultChannel, options: ['sms', 'whatsapp', 'both'] }, { name: 'ms_hotspotChannel', label: 'Send hotspot codes by', type: 'select', value: ms.hotspotChannel, options: ['whatsapp', 'sms', 'both'] },
    { name: 'sms_provider', label: 'SMS provider', type: 'select', value: ms.sms.provider, options: [{ value: 'simulate', label: 'Simulate (outbox only)' }, { value: 'africastalking', label: "Africa's Talking" }] }, { name: 'sms_sandbox', label: "Use Africa's Talking sandbox", type: 'checkbox', value: ms.sms.sandbox },
    { name: 'sms_username', label: 'AT username (live only)', value: ms.sms.username }, { name: 'sms_apiKey', label: 'AT API key', type: 'password', value: ms.sms.apiKey }, { name: 'sms_senderId', label: 'Sender ID (optional)', value: ms.sms.senderId },
    { name: 'wa_provider', label: 'WhatsApp provider', type: 'select', value: ms.whatsapp.provider, options: [{ value: 'simulate', label: 'Simulate (outbox only)' }, { value: 'twilio', label: 'Twilio WhatsApp' }, { value: 'meta', label: 'Meta WhatsApp Cloud API' }] },
    { name: 'wa_twilioSid', label: 'Twilio Account SID', value: ms.whatsapp.twilioSid }, { name: 'wa_twilioToken', label: 'Twilio Auth token', type: 'password', value: ms.whatsapp.twilioToken }, { name: 'wa_twilioFrom', label: 'Twilio WhatsApp number', value: ms.whatsapp.twilioFrom },
    { name: 'wa_phoneNumberId', label: 'Meta phone number ID', value: ms.whatsapp.phoneNumberId }, { name: 'wa_token', label: 'Meta access token', type: 'password', value: ms.whatsapp.token },
    { name: 'wa_template', label: 'Meta template name (blank = free text)', value: ms.whatsapp.template }, { name: 'wa_templateLang', label: 'Template language', value: ms.whatsapp.templateLang }, { name: 'wa_templateHasParam', label: 'Template has one {{1}} body parameter (we put the message there)', type: 'checkbox', value: ms.whatsapp.templateHasParam }])}
  <div class="row"><input id="testTo" placeholder="Test phone e.g. 0712345678" style="max-width:240px"><select id="testCh" style="max-width:160px"><option>whatsapp</option><option>sms</option></select><button type="button" class="btn" id="msgTest">Save & send test</button><span id="msgRes" class="small"></span></div></div>

  <div class="card"><h2>Message templates</h2><div class="lesson small">Placeholders: {company} {name} {account} {username} {password} {package} {price} {expiry} {paybill} {currency} {amount} {code} {receipt} {ticket}</div>${fields(Object.keys(s.smsTemplates).map(k => ({ name: 'tpl_' + k, label: k, type: 'textarea', full: true, value: s.smsTemplates[k] })))}</div>
  <div class="card"><h2>Integrations</h2><div class="lesson small">OneISP and SmartOLT work together: SmartOLT pulls customers (PPPoE username/password) from OneISP when you authorize an ONU, and OneISP shows ONU signal on the customer page.</div>
  ${fields([{ name: 'so_url', label: 'SmartOLT URL', value: s.smartolt.url }, { name: 'so_token', label: 'SmartOLT API token (X-Token)', value: s.smartolt.token }, { name: 'apiToken', label: 'OneISP API token (give this to SmartOLT)' }], s)}
  <button type="button" class="btn" id="testSo">Test SmartOLT connection</button></div>
  <div class="row"><button class="btn primary">Save settings</button><span class="spacer"></span><button type="button" class="btn bad" id="reset">Reset all data to demo</button></div></form>`;
  const collect = () => {
    const v = formData($('#f'));
    const pref = p => Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith(p)).map(([k, x]) => [k.slice(p.length), x]));
    const body = { ...v, smsTemplates: pref('tpl_'), smartolt: { url: v.so_url, token: v.so_token }, mpesa: pref('mp_'), messaging: { ...pref('ms_'), sms: pref('sms_'), whatsapp: pref('wa_') } };
    return body;
  };
  const save = () => PUT('/api/settings', collect());
  $('#f').onsubmit = async e => { e.preventDefault(); try { await save(); toast('Settings saved', 'ok'); } catch (err) { fail(err); } };
  $('#mpTest').onclick = async () => { try { await save(); toast(esc((await POST('/api/mpesa/test')).message), 'ok'); } catch (e) { fail(e); } };
  $('#msgTest').onclick = async () => {
    try {
      await save();
      const r = await POST('/api/messaging/test', { to: $('#testTo').value, channel: $('#testCh').value });
      $('#msgRes').textContent = 'sending...';
      setTimeout(async () => { const m = await GET(`/api/sms/${r.id}`); $('#msgRes').innerHTML = msgStatus(m.status); }, 4000);
    } catch (e) { fail(e); }
  };
  $('#testSo').onclick = async () => { try { const r = await POST('/api/settings/smartolt/test'); toast(`SmartOLT OK - ${r.olts} OLT(s)`, 'ok'); } catch (e) { fail(e); } };
  $('#reset').onclick = async () => { if (await confirmBox('Wipe everything and restore demo data?')) { await POST('/api/settings/reset'); location.reload(); } };
};

routes.learn = async page => {
  page.innerHTML = `<div class="card"><h2>Lab guide - learning MikroTik with this simulator</h2>
  <div class="lesson"><b>1. Start simulated.</b> Everything works without a router. Each action pops up the <b>Router commands</b> panel with the RouterOS CLI it ran. Copy those into WinBox &rarr; New Terminal to do it by hand.</div>
  <div class="lesson"><b>2. Prepare the CHR.</b> In VirtualBox give the CHR a <i>Host-only</i> adapter (ether1 or ether2). In WinBox: <span class="mono">/ip address print</span> to find its IP (e.g. 192.168.56.101). Enable the REST API: <span class="mono">/ip service set www disabled=no</span>. Test in a browser: <span class="mono">http://192.168.56.101/rest/system/resource</span> (login admin).</div>
  <div class="lesson"><b>3. Bootstrap.</b> Sites &rarr; your site &rarr; <b>Provisioning script</b>. Adjust interface names (or create bridges <span class="mono">/interface bridge add name=br-pppoe</span>), paste the script in WinBox terminal. Read each section - it is the whole ISP setup.</div>
  <div class="lesson"><b>4. Go live.</b> Edit the site: mode = Live, host = CHR IP, user/password = the oneisp API user from the script. "Test connection", then "Re-provision all". Open WinBox &rarr; PPP &rarr; Secrets: your customers are there.</div>
  <div class="lesson"><b>5. Exercises.</b><br>
  &bull; Create a PPPoE customer &rarr; watch <span class="mono">PPP &rarr; Secrets</span>. Click <i>Expire now</i> &rarr; the secret gets disabled. Record a payment &rarr; re-enabled.<br>
  &bull; Change a package speed &rarr; <span class="mono">PPP &rarr; Profiles</span> rate-limit changes.<br>
  &bull; Create a Static customer &rarr; look at <span class="mono">Queues</span> and <span class="mono">IP &rarr; Firewall &rarr; Address Lists</span>.<br>
  &bull; Create a DHCP customer &rarr; <span class="mono">IP &rarr; DHCP Server &rarr; Leases</span>; expire them and see <i>block-access</i>.<br>
  &bull; Generate vouchers &rarr; <span class="mono">IP &rarr; Hotspot &rarr; Users</span>; note limit-uptime.<br>
  &bull; Dial PPPoE from a second VM (another CHR: <span class="mono">/interface pppoe-client add interface=ether1 user=ln1001 password=... disabled=no</span>) on the same VirtualBox internal network - then Sites &rarr; Sync sessions shows them online.<br>
  &bull; Open SmartOLT, authorize an ONU and link it to a customer - the customer's "Fiber / ONU" tab shows its signal.</div>
  <p>Full step-by-step guide: <span class="mono">docs/MIKROTIK-LAB.md</span> in the project folder.</p></div>`;
};

boot();
