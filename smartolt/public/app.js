// SmartOLT simulator front-end (vanilla JS, hash routing).
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dt = d => (d ? new Date(d).toLocaleString() : '-');
const STATUS = { online: ['&#127760;', 'Online'], power_fail: ['&#128268;', 'Power fail'], los: ['&#10007;', 'LOS'], offline: ['&#127760;', 'Offline'], disabled: ['&#8856;', 'Disabled'] };
const stIcon = s => `<span class="st st-${s}" title="${STATUS[s]?.[1] || s}">${STATUS[s]?.[0] || '?'}</span>`;
const sig = o => o.status === 'online' ? `<span class="sig ${o.signal}"><i></i><i></i><i></i><i></i></span><span class="mono">${o.rxPower.toFixed(2)} dBm</span>` : '<span class="muted">-</span>';
const lbl = (t, c) => `<span class="lbl l-${c || t}">${esc(t)}</span>`;
let META = null;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Login required'); }
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const GET = u => api('GET', u), POST = (u, b) => api('POST', u, b || {}), PUT = (u, b) => api('PUT', u, b), DEL = u => api('DELETE', u);
function toast(m, t = '') { const d = document.createElement('div'); d.className = `toast ${t}`; d.innerHTML = m; $('#toasts').appendChild(d); setTimeout(() => d.remove(), t === 'bad' ? 7000 : 3500); }
const fail = e => toast(esc(e.message), 'bad');

// Shows the OLT commands an action produced.
function showCli(logs, title = 'Commands sent to the OLT') {
  const list = (Array.isArray(logs) ? logs : [logs]).filter(Boolean);
  if (!list.length) return;
  const text = list.map(l => `! ${l.action} ${l.sn} on ${l.oltName} (${l.via})\n${l.commands.join('\n')}`).join('\n\n');
  const p = $('#cmdPanel');
  p.innerHTML = `<div class="h"><b>${esc(title)}</b><span><button class="btn sm" id="cpy">Copy</button> <button class="btn sm" id="cls">&times;</button></span></div><pre>${esc(text)}</pre>`;
  p.classList.remove('hidden');
  $('#cls').onclick = () => p.classList.add('hidden');
  $('#cpy').onclick = () => { navigator.clipboard.writeText(text); toast('Copied'); };
}

function modal(title, body, { wide, submit = 'Save', onSubmit } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal ${wide ? 'wide' : ''}"><div class="modal-head"><h3>${esc(title)}</h3><button type="button" class="x">&times;</button></div><div>${body}</div><div class="modal-foot"><button type="button" class="btn cancel">Cancel</button>${onSubmit ? `<button class="btn primary">${esc(submit)}</button>` : ''}</div></form>`;
  $('#modalRoot').appendChild(bg);
  const close = () => bg.remove();
  $$('.x,.cancel', bg).forEach(b => (b.onclick = close));
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  const f = $('form', bg);
  f.onsubmit = async e => { e.preventDefault(); if (!onSubmit) return close(); const b = $('.modal-foot .primary', bg); b.disabled = true; try { if ((await onSubmit(formData(f), f)) !== false) close(); } catch (err) { fail(err); } finally { b.disabled = false; } };
  return { el: f, close };
}
function formData(f) { const o = {}; $$('[name]', f).forEach(i => { o[i.name] = i.type === 'checkbox' ? i.checked : i.value; }); return o; }
function field(f, v = {}) {
  const val = v[f.name] ?? f.value ?? '';
  const cls = f.full ? 'full' : '';
  if (f.type === 'select') return `<label class="${cls}">${esc(f.label)}<select name="${f.name}">${f.blank !== undefined ? `<option value="">${esc(f.blank)}</option>` : ''}${f.options.map(o => (typeof o === 'object' ? o : { value: o, label: o })).map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(val) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${f.help ? `<span class="small muted">${f.help}</span>` : ''}</label>`;
  if (f.type === 'checkbox') return `<label class="${cls}"><input type="checkbox" name="${f.name}" ${val === true || val === 'true' ? 'checked' : ''}> ${esc(f.label)}</label>`;
  if (f.type === 'textarea') return `<label class="${cls}">${esc(f.label)}<textarea name="${f.name}">${esc(val)}</textarea></label>`;
  return `<label class="${cls}">${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} step="any">${f.help ? `<span class="small muted">${f.help}</span>` : ''}</label>`;
}
const fields = (l, v) => `<div class="fgrid">${l.map(f => field(f, v)).join('')}</div>`;
function confirmBox(msg) { return new Promise(res => { const m = modal('Confirm', `<p>${msg}</p>`, { submit: 'Yes', onSubmit: () => res(true) }); $$('.x,.cancel', m.el).forEach(b => b.addEventListener('click', () => res(false))); }); }
function table(cols, rows, { empty = 'No data', onRow } = {}) {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  const id = 't' + Math.random().toString(36).slice(2);
  if (onRow) setTimeout(() => $$(`#${id} tbody tr`).forEach((tr, i) => tr.addEventListener('click', e => { if (!e.target.closest('button,a,input,select')) onRow(rows[i]); })));
  return `<div class="tw"><table id="${id}"><thead><tr>${cols.map(c => `<th>${c.label}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr style="${onRow ? 'cursor:pointer' : ''}">${cols.map(c => `<td>${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// SVG line chart: series = [{name, color, points:[[t,v],...]}]
function lineChart(series, { height = 240, unit = '', fmt = v => v, min } = {}) {
  const w = 900, pl = 50, pr = 10, pt = 10, pb = 26;
  const pts = series.flatMap(s => s.points.filter(p => p[1] !== null && p[1] !== undefined));
  if (!pts.length) return '<div class="empty">No samples yet - wait a minute</div>';
  const t0 = Math.min(...pts.map(p => p[0])), t1 = Math.max(...pts.map(p => p[0])) || t0 + 1;
  let v0 = min !== undefined ? min : Math.min(...pts.map(p => p[1])), v1 = Math.max(...pts.map(p => p[1]));
  if (v0 === v1) { v0 -= 1; v1 += 1; }
  const x = t => pl + ((t - t0) / (t1 - t0 || 1)) * (w - pl - pr), y = v => pt + (1 - (v - v0) / (v1 - v0)) * (height - pt - pb);
  const grid = [0, .25, .5, .75, 1].map(f => { const v = v0 + (v1 - v0) * f; return `<line x1="${pl}" x2="${w - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#eee"/><text x="2" y="${y(v) + 4}">${fmt(v)}${unit}</text>`; }).join('');
  const times = [0, .5, 1].map(f => { const t = t0 + (t1 - t0) * f; return `<text x="${x(t)}" y="${height - 6}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>`; }).join('');
  const paths = series.map(s => {
    let d = '', pen = false;
    s.points.forEach(p => { if (p[1] === null || p[1] === undefined) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`; pen = true; });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
  }).join('');
  const legend = series.map((s, i) => `<rect x="${pl + i * 170}" y="${height - 14}" width="0" height="0"/><text x="${w - pr - (series.length - i) * 150}" y="12" fill="${s.color}" style="fill:${s.color};font-weight:600">&#9632; ${esc(s.name)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none">${grid}${times}${paths}${legend}</svg>`;
}
function bars(data, { color = '#1e88e5', height = 200 } = {}) {
  const w = 900, max = Math.max(1, ...data.map(d => d.total)), bw = (w - 40) / Math.max(1, data.length);
  return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none">${data.map((d, i) => { const h = (d.total / max) * (height - 40); return `<rect x="${30 + i * bw + bw * .15}" y="${height - 22 - h}" width="${bw * .7}" height="${h}" fill="${color}"><title>${esc(d.label)}: ${d.total}</title></rect><text x="${30 + i * bw + bw / 2}" y="${height - 6}" text-anchor="middle">${esc(d.label)}</text>${d.total ? `<text x="${30 + i * bw + bw / 2}" y="${height - 26 - h}" text-anchor="middle">${d.total}</text>` : ''}`; }).join('')}</svg>`;
}
const kbps = v => (v >= 1024 ? (v / 1024).toFixed(v >= 10240 ? 0 : 1) + 'M' : Math.round(v) + 'k');

// ---------------- routing
const routes = {};
let timer = null;
async function router() {
  clearInterval(timer);
  const [name, id] = (location.hash.slice(2).split('?')[0] || 'dashboard').split('/');
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.r === name || (name === 'onu' && a.dataset.r === 'configured')));
  $('#nav').classList.remove('open');
  const page = $('#page');
  page.innerHTML = '<div class="empty">Loading...</div>';
  try {
    META = await GET('/api/meta');
    await (routes[id ? name + '/:id' : name] || routes.dashboard)(page, id);
    GET('/api/unconfigured').then(u => ($('#waitBadge').textContent = u.length || ''));
  } catch (e) { page.innerHTML = `<div class="panel empty">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', router);
function showLogin() { $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#loginForm').onsubmit = async e => { e.preventDefault(); try { await POST('/api/login', formData(e.target)); boot(); } catch (err) { fail(err); } };
$('#logout').onclick = async () => { await POST('/api/logout'); showLogin(); };
$('#burger').onclick = () => $('#nav').classList.toggle('open');
async function boot() {
  try { const me = await api('GET', '/api/me'); $('#company').textContent = me.company; $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden'); router(); } catch { showLogin(); }
}
const oltOpts = () => META.olts.map(o => ({ value: o.id, label: o.name }));
const ponBoards = olt => (olt?.boards || []).filter(b => b.ports);

// ================================================= DASHBOARD
routes.dashboard = async page => {
  const d = await GET('/api/dashboard');
  page.innerHTML = `<div class="grid g4">
    <a class="tile t-blue" href="#/unconfigured"><div class="ic">&#9203;</div><div class="v">${d.waiting}</div><div class="l">Waiting authorization</div><div class="sub">D: ${d.waiting} &nbsp; Resync: 0 &nbsp; New: ${d.waiting}</div></a>
    <a class="tile t-green" href="#/configured?status=online"><div class="ic">&#10003;</div><div class="v">${d.online}</div><div class="l">Online</div><div class="sub">Total authorized: ${d.total}</div></a>
    <a class="tile t-grey" href="#/configured?status=offline"><div class="ic">&#9888;</div><div class="v">${d.offline}</div><div class="l">Total offline</div><div class="sub">PwrFail: ${d.powerFail} &nbsp; LoS: ${d.los} &nbsp; N/A: ${d.na}</div></a>
    <a class="tile t-orange" href="#/configured?signal=warning"><div class="ic">&#128246;</div><div class="v">${d.warning + d.critical}</div><div class="l">Low signals</div><div class="sub">Warning: ${d.warning} &nbsp; Critical: ${d.critical}</div></a></div>
  <div class="grid g2" style="margin-top:18px">
    <div class="panel"><h3>Network status</h3>${lineChart([{ name: 'Online', color: '#43a047', points: d.network.map(n => [n[0], n[1]]) }, { name: 'Offline', color: '#e53935', points: d.network.map(n => [n[0], n[2]]) }], { min: 0, fmt: v => Math.round(v) })}</div>
    <div class="panel"><h3>ONU authorizations per day</h3>${bars(d.authorizations)}</div></div>
  <div class="grid g2"><div class="panel"><h3>OLTs</h3>${table([{ label: 'Name', render: o => `<a href="#/olt/${o.id}"><b>${esc(o.name)}</b></a>` }, { label: 'Hardware', render: o => `${esc(o.vendor)} ${esc(o.hardware)}` }, { label: 'IP', key: 'ip' }, { label: 'Uptime', key: 'uptime' }, { label: 'Env temp', render: o => `${o.temperature}&deg;C` }, { label: 'ONUs', render: o => `${o.online}/${o.onus}` }], d.olts)}</div>
  <div class="panel"><h3>Latest events</h3>${table([{ label: 'Time', render: e => dt(e.createdAt) }, { label: 'Type', render: e => lbl(e.type, e.severity) }, { label: 'Message', key: 'message' }], d.events)}<div class="more"><a href="#/events">All events &rarr;</a></div></div></div>`;
  timer = setInterval(() => { if (location.hash.startsWith('#/dashboard') || !location.hash) router(); }, 30000);
};

// ================================================= UNCONFIGURED + AUTHORIZE
routes.unconfigured = async page => {
  const list = await GET('/api/unconfigured');
  page.innerHTML = `<div class="panel"><div class="toolbar"><h2>Unconfigured ONUs</h2><div class="acts"><button class="btn" id="refresh">&#8635; Refresh (autofind)</button><button class="btn" id="sim">+ Simulate plugging in a new ONU</button></div></div>
  <div class="lesson">When a technician connects a new ONU, the OLT detects it on its PON port and lists it in <b>autofind</b> (Huawei <span class="mono">display ont autofind all</span> / ZTE <span class="mono">show gpon onu uncfg</span>).
  Click <b>Authorize</b> to register it: SmartOLT sends <span class="mono">ont add</span> + WAN/VLAN config + <span class="mono">service-port</span> to the OLT.</div>
  ${META.olts.map(olt => { const rows = list.filter(u => u.oltId === olt.id); return `<h3 style="margin-top:16px">${esc(olt.name)} <span class="muted small">${esc(olt.vendor)}</span></h3>` + table([{ label: 'PON type', key: 'ponType' }, { label: 'Board', key: 'board' }, { label: 'Port', key: 'port' }, { label: 'PON description', render: u => olt.vendor === 'ZTE' ? `gpon-olt_1/${u.board}/${u.port}` : `0/${u.board}/${u.port}` }, { label: 'SN', render: u => `<b class="mono">${esc(u.sn)}</b>` }, { label: 'Type', key: 'equipmentId' }, { label: 'Detected', render: u => dt(u.detectedAt) }, { label: 'Action', render: u => `<button class="btn primary sm" data-auth="${u.id}">Authorize</button> <button class="btn sm" data-del="${u.id}">Hide</button>` }], rows, { empty: 'No unconfigured ONUs on this OLT' }); }).join('')}</div>`;
  $$('[data-auth]').forEach(b => (b.onclick = () => authorizeForm(list.find(u => u.id === Number(b.dataset.auth)))));
  $$('[data-del]').forEach(b => (b.onclick = async () => { await DEL(`/api/unconfigured/${b.dataset.del}`); router(); }));
  $('#refresh').onclick = async () => { await POST('/api/unconfigured/refresh'); router(); };
  $('#sim').onclick = () => modal('Simulate a new ONU connected to the fiber', fields([{ name: 'oltId', label: 'OLT', type: 'select', options: oltOpts() }, { name: 'board', label: 'Board (blank = random)' }, { name: 'port', label: 'Port (blank = random)' }, { name: 'sn', label: 'Serial (blank = random)', placeholder: 'HWTC12345678' }]), { submit: 'Plug it in', onSubmit: async v => { await POST('/api/unconfigured/simulate', v); toast('ONU detected', 'ok'); router(); } });
  timer = setInterval(async () => { const u = await GET('/api/unconfigured'); if (u.length !== list.length) router(); }, 15000);
};

function authorizeForm(u = {}) {
  const olt = META.olts.find(o => o.id === u.oltId) || META.olts[0];
  const guessType = META.onuTypes.find(t => t.name.replace('ZTE-', '') === String(u.equipmentId || '').replace('ZTE-', '')) || META.onuTypes.find(t => t.vendor === olt.vendor);
  const v = { oltId: olt.id, board: u.board ?? ponBoards(olt)[0]?.slot, port: u.port ?? 0, sn: u.sn || '', onuTypeId: guessType?.id, mode: guessType?.modes.includes('routing') ? 'routing' : 'bridging', vlan: 100, wanMode: 'pppoe', downloadProfileId: META.speedProfiles.find(s => s.type === 'download')?.id, uploadProfileId: META.speedProfiles.find(s => s.type === 'upload')?.id };
  const m = modal('Authorize ONU', `<div class="lesson small"><b>Tip:</b> search a OneISP customer to fill name, address and the PPPoE username/password - the ONU will dial PPPoE to your MikroTik with the same account OneISP created.</div>
    <div class="row" style="margin-bottom:10px"><input id="cs" placeholder="Search OneISP customer (name, account, phone)" style="flex:1"><button type="button" class="btn" id="csb">Search</button></div><div id="cr"></div><div id="af"></div>`, {
    wide: true, submit: 'Authorize', onSubmit: async val => { const o = await POST('/api/onus/authorize', val); const d = await GET(`/api/onus/${o.id}`); showCli(d.cli, 'Authorization commands sent to the OLT'); toast(`${o.sn} authorized`, 'ok'); location.hash = `#/onu/${o.id}`; },
  });
  const draw = patch => {
    const cur = { ...v, ...formData(m.el), ...patch };
    const o = META.olts.find(x => x.id === Number(cur.oltId));
    $('#af', m.el).innerHTML = fields([
      { name: 'oltId', label: 'OLT', type: 'select', options: oltOpts() }, { name: 'ponType', label: 'PON type', type: 'select', options: ['GPON'] },
      { name: 'board', label: 'Board', type: 'select', options: ponBoards(o).map(b => ({ value: b.slot, label: `${b.slot} (${b.type})` })) }, { name: 'port', label: 'Port', type: 'number' },
      { name: 'sn', label: 'SN', required: true }, { name: 'onuTypeId', label: 'ONU type', type: 'select', options: META.onuTypes.map(t => ({ value: t.id, label: `${t.name} (${t.ethPorts} eth${t.wifi ? ', WiFi' : ''}${t.catv ? ', CATV' : ''})` })) },
      { name: 'mode', label: 'ONU mode', type: 'select', options: [{ value: 'routing', label: 'Routing (ONU dials PPPoE / DHCP itself)' }, { value: 'bridging', label: 'Bridging (customer router behind ONU does PPPoE)' }] },
      { name: 'vlan', label: 'User VLAN-ID', type: 'select', options: META.vlans.map(x => ({ value: x.vlan, label: `${x.vlan} - ${x.description}` })) },
      { name: 'wanMode', label: 'WAN mode (routing)', type: 'select', options: ['pppoe', 'dhcp', 'static'] }, { name: 'externalId', label: 'OneISP customer ID (external ID)' },
      { name: 'pppoeUser', label: 'PPPoE username' }, { name: 'pppoePass', label: 'PPPoE password' },
      { name: 'zoneId', label: 'Zone', type: 'select', blank: '- none -', options: META.zones.map(z => ({ value: z.id, label: z.name })) }, { name: 'odbId', label: 'ODB (splitter)', type: 'select', blank: '- none -', options: META.odbs.map(z => ({ value: z.id, label: `${z.name} (${z.splitter})` })) },
      { name: 'odbPort', label: 'ODB port' }, { name: 'onuId', label: 'ONU ID (blank = next free)' },
      { name: 'downloadProfileId', label: 'Download speed profile', type: 'select', options: META.speedProfiles.filter(s => s.type === 'download').map(s => ({ value: s.id, label: s.name })) },
      { name: 'uploadProfileId', label: 'Upload speed profile', type: 'select', options: META.speedProfiles.filter(s => s.type === 'upload').map(s => ({ value: s.id, label: s.name })) },
      { name: 'name', label: 'Name', required: true }, { name: 'address', label: 'Address or comment' }, { name: 'phone', label: 'Contact' }, { name: 'catv', label: 'CATV enabled', type: 'checkbox' },
    ], cur);
    $('[name=oltId]', m.el).onchange = () => draw({ board: ponBoards(META.olts.find(x => x.id === Number($('[name=oltId]', m.el).value)))[0]?.slot });
  };
  draw({});
  const search = async () => {
    try {
      const list = await GET('/api/oneisp/customers?search=' + encodeURIComponent($('#cs', m.el).value));
      $('#cr', m.el).innerHTML = table([{ label: 'Account', key: 'account_no' }, { label: 'Name', key: 'name' }, { label: 'Type', key: 'connection_type' }, { label: 'Username', key: 'username' }, { label: 'Status', key: 'status' }, { label: 'ONU', render: c => esc(c.onu_sn || '-') }, { label: '', render: c => `<button type="button" class="btn sm primary" data-pick="${c.id}">Use</button>` }], list.slice(0, 8), { empty: 'No customers found' });
      $$('[data-pick]', m.el).forEach(b => (b.onclick = () => { const c = list.find(x => x.id === Number(b.dataset.pick)); draw({ name: c.name, address: c.address || c.location || '', phone: c.phone || '', pppoeUser: c.username, pppoePass: c.password, externalId: c.id, wanMode: c.connection_type === 'pppoe' ? 'pppoe' : 'dhcp' }); $('#cr', m.el).innerHTML = `<div class="lesson small">Linked to OneISP customer <b>${esc(c.account_no)} ${esc(c.name)}</b></div>`; }));
    } catch (e) { $('#cr', m.el).innerHTML = `<div class="small" style="color:var(--bad)">${esc(e.message)}</div>`; }
  };
  $('#csb', m.el).onclick = search;
  $('#cs', m.el).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
}

// ================================================= CONFIGURED
routes.configured = async page => {
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  const st = { status: p.get('status') || '', signal: p.get('signal') || '', mode: '' };
  const sel = (id, label, opts) => `<div class="f"><b>${label}</b><select id="${id}"><option value="">Any</option>${opts.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div>`;
  page.innerHTML = `<div class="panel"><div class="filters">
    <div class="f"><b>Search</b><input id="q" placeholder="SN, IP, name, address" style="width:220px"></div>
    ${sel('olt', 'OLT', oltOpts())}${sel('board', 'Board', [...new Set(META.olts.flatMap(o => ponBoards(o).map(b => b.slot)))].map(s => ({ value: s, label: s })))}
    ${sel('port', 'Port', Array.from({ length: 17 }, (_, i) => ({ value: i, label: i })))}${sel('zone', 'Zone', META.zones.map(z => ({ value: z.id, label: z.name })))}
    ${sel('odb', 'Splitter', META.odbs.map(z => ({ value: z.id, label: z.name })))}${sel('vlan', 'VLAN', META.vlans.map(v => ({ value: v.vlan, label: v.vlan })))}
    ${sel('type', 'ONU type', META.onuTypes.map(t => ({ value: t.id, label: t.name })))}${sel('profile', 'Profile', META.speedProfiles.map(s => ({ value: s.id, label: s.name })))}
    ${sel('pon', 'PON type', [{ value: 'GPON', label: 'GPON' }])}
    <span class="ibar">${['online', 'power_fail', 'los', 'offline', 'disabled'].map(s => `<button class="ibtn st-${s}" data-status="${s}" title="${STATUS[s][1]}">${STATUS[s][0]}</button>`).join('')}</span>
    <span class="ibar">${['good', 'warning', 'critical'].map(s => `<button class="ibtn" data-signal="${s}" title="Signal ${s}"><span class="sig ${s}"><i></i><i></i><i></i><i></i></span></button>`).join('')}</span>
    <span class="ibar"><button class="ibtn" data-mode="bridging" title="Bridging"><b>B</b></button><button class="ibtn" data-mode="routing" title="Routing"><b>R</b></button></span>
    <a class="btn" href="/api/reports/onus.csv" title="Export CSV">&#8681; CSV</a></div></div>
  <div class="panel"><div class="toolbar"><div id="count" class="muted"></div><button class="btn primary" id="manual">+ Add ONU manually</button></div><div id="list"></div></div>`;
  const sync = () => { $$('[data-status]').forEach(b => b.classList.toggle('on', b.dataset.status === st.status)); $$('[data-signal]').forEach(b => b.classList.toggle('on', b.dataset.signal === st.signal)); $$('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === st.mode)); };
  const draw = async () => {
    sync();
    const q = new URLSearchParams({ search: $('#q').value, oltId: $('#olt').value, board: $('#board').value, port: $('#port').value, zoneId: $('#zone').value, odbId: $('#odb').value, vlan: $('#vlan').value, onuTypeId: $('#type').value, profileId: $('#profile').value, ponType: $('#pon').value, status: st.status, signal: st.signal, mode: st.mode });
    const rows = await GET('/api/onus?' + q);
    $('#count').textContent = `${rows.length} ONUs`;
    $('#list').innerHTML = table([
      { label: 'Status', render: o => stIcon(o.status) }, { label: 'Name', render: o => `<b>${esc(o.name)}</b>${o.externalId ? ' <span class="lbl l-info" title="Linked to OneISP">ISP</span>' : ''}` },
      { label: 'SN / MAC', render: o => `<span class="mono">${esc(o.sn)}</span>` }, { label: 'ONU', render: o => `${esc(o.oltName)}<div class="small muted mono">${esc(o.pon)}</div>` },
      { label: 'Zone', key: 'zoneName' }, { label: 'ODB', key: 'odbName' }, { label: 'Signal', render: sig },
      { label: 'B/R', render: o => lbl(o.mode === 'routing' ? 'R' : 'B') }, { label: 'VLAN', key: 'vlan' }, { label: 'TV', render: o => o.catv ? 'On' : '-' },
      { label: 'Type', key: 'onuTypeName' }, { label: 'Auth date', render: o => new Date(o.authorizedAt).toLocaleDateString() }, { label: 'Action', render: o => `<a class="btn sm primary" href="#/onu/${o.id}">View</a>` },
    ], rows, { empty: 'No ONUs match the filters', onRow: o => (location.hash = `#/onu/${o.id}`) });
  };
  ['olt', 'board', 'port', 'zone', 'odb', 'vlan', 'type', 'profile', 'pon'].forEach(i => { if (p.get(i)) $('#' + i).value = p.get(i); $('#' + i).onchange = draw; });
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(draw, 250); };
  $$('[data-status]').forEach(b => (b.onclick = () => { st.status = st.status === b.dataset.status ? '' : b.dataset.status; draw(); }));
  $$('[data-signal]').forEach(b => (b.onclick = () => { st.signal = st.signal === b.dataset.signal ? '' : b.dataset.signal; draw(); }));
  $$('[data-mode]').forEach(b => (b.onclick = () => { st.mode = st.mode === b.dataset.mode ? '' : b.dataset.mode; draw(); }));
  $('#manual').onclick = () => authorizeForm({});
  await draw();
  timer = setInterval(draw, 20000);
};

// ================================================= ONU DETAIL
routes['onu/:id'] = async (page, id) => {
  const d = await GET(`/api/onus/${id}`);
  const o = d.onu;
  const rows = (pairs) => `<div class="kv">${pairs.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('')}</div>`;
  page.innerHTML = `<div class="panel"><div class="toolbar"><h2>${stIcon(o.status)} ${esc(o.name)} <span class="muted small mono">${esc(o.sn)}</span></h2>
    <div class="acts"><button class="btn" id="getStatus">Get status</button><button class="btn" id="running">Show running config</button><button class="btn" id="ping">Ping</button><button class="btn" id="live">LIVE!</button></div></div>
  <div class="grid g2"><div>${rows([['OLT', esc(o.oltName)], ['Board', o.board], ['Port', o.port], ['ONU', `<span class="mono">${esc(o.pon)}</span>`], ['GPON channel', 'GPON'], ['SN', `<span class="mono">${esc(o.sn)}</span>`], ['ONU type', esc(o.onuTypeName)], ['Zone', esc(o.zoneName)], ['ODB (Splitter)', `${esc(o.odbName)} port ${esc(o.odbPort || '-')}`], ['Name', esc(o.name)], ['Address or comment', esc(o.address)], ['Contact', esc(o.phone)], ['Authorization date', dt(o.authorizedAt) + ` (${esc(o.via)})`], ['ONU external ID', o.externalId ? `${o.externalId} <span class="lbl l-info">OneISP</span> ${o.externalAccount ? esc(o.externalAccount) + ' ' + esc(o.externalStatus || '') : ''}` : '<span class="muted">not linked</span>']])}</div>
  <div>${rows([['Status', `${lbl(STATUS[o.status][1], o.status)} ${o.uptime ? `(${o.uptime})` : ''}`], ['ONU/OLT Rx signal', o.status === 'online' ? `${sig(o)} / <span class="mono">${o.oltRxPower.toFixed(2)} dBm</span> ${lbl(o.signal)}` : '-'], ['Tx power', o.status === 'online' ? `${o.txPower.toFixed(2)} dBm` : '-'], ['Distance', `${o.distance} m`], ['Temperature', o.status === 'online' ? `${o.temperature.toFixed(0)} &deg;C` : '-'], ['Last down cause', esc(o.lastDownCause || '-') + (o.lastDownAt ? ` at ${dt(o.lastDownAt)}` : '')], ['Attached VLANs', o.vlan], ['ONU mode', `${o.mode === 'routing' ? 'Routing' : 'Bridging'}${o.mode === 'routing' ? ` - WAN ${o.wanMode.toUpperCase()}${o.wanIp && o.status === 'online' ? ' ' + o.wanIp : ''}` : ''}`], ['TR069', 'Active (simulated ACS)'], ['Mgmt IP', o.status === 'online' ? `10.30.${o.oltId}.${(o.id % 250) + 2}` : '-'], ['WiFi', esc(o.wifiSsid || '-')], ['CATV', o.catv ? 'Enabled' : 'Disabled']])}</div></div></div>
  <div class="grid g2"><div class="panel"><h3>Traffic (last hours)</h3>${lineChart([{ name: 'Download', color: '#1e88e5', points: o.history.traf.map(p => [p[0], p[1]]) }, { name: 'Upload', color: '#43a047', points: o.history.traf.map(p => [p[0], p[2]]) }], { min: 0, fmt: kbps })}</div>
  <div class="panel"><h3>Signal (dBm)</h3>${lineChart([{ name: 'ONU Rx', color: '#fb8c00', points: o.history.sig.map(p => [p[0], p[1]]) }, { name: 'OLT Rx', color: '#8e24aa', points: o.history.sig.map(p => [p[0], p[2]]) }], { fmt: v => v.toFixed(1) })}</div></div>
  <div class="grid g2"><div class="panel"><div class="toolbar"><h3>Speed profiles</h3><button class="btn sm" id="eSpeed">Configure</button></div>${rows([['Download', esc(o.downloadName)], ['Upload', esc(o.uploadName)], ['Service-port', o.servicePort ?? '-']])}
    <h3 style="margin-top:16px">Ethernet ports</h3>${table([{ label: 'Port', key: 'p' }, { label: 'Admin state', key: 'a' }, { label: 'Mode', key: 'm' }, { label: 'DHCP', key: 'd' }], Array.from({ length: META.onuTypes.find(t => t.id === o.onuTypeId)?.ethPorts || 1 }, (_, i) => ({ p: `eth_0/${i + 1}`, a: 'Enabled', m: o.mode === 'routing' ? 'LAN' : `Access VLAN ${o.vlan}`, d: o.mode === 'routing' ? 'ONU' : 'No control' })))}</div>
  <div class="panel"><div class="toolbar"><h3>WAN / VLAN / WiFi</h3><div class="acts"><button class="btn sm" id="eWan">Configure</button>${o.externalId ? '<button class="btn sm" id="pull">Pull PPPoE from OneISP</button>' : ''}</div></div>
    ${rows([['Mode', o.mode], ['VLAN', o.vlan], ['WAN', o.mode === 'routing' ? o.wanMode : 'n/a (bridge)'], ['PPPoE username', `<span class="mono">${esc(o.pppoeUser || '-')}</span>`], ['PPPoE password', `<span class="mono">${esc(o.pppoePass || '-')}</span>`], ['WiFi SSID', esc(o.wifiSsid)], ['WiFi password', `<span class="mono">${esc(o.wifiPassword)}</span>`]])}
    <div class="lesson small">${o.mode === 'routing' ? `Routing: the ONU itself dials PPPoE <b>${esc(o.pppoeUser)}</b> on VLAN ${o.vlan} to your MikroTik PPPoE server. On MikroTik you need a VLAN ${o.vlan} interface with the PPPoE server on it.` : `Bridging: VLAN ${o.vlan} is passed untagged to eth port 1. The customer's own router (or a MikroTik) does PPPoE/DHCP.`}</div></div></div>
  <div class="panel"><div class="acts"><button class="btn warn" id="reboot">Reboot</button><button class="btn" id="resync">Resync config</button>${o.disabled ? '<button class="btn ok" id="enable">Enable ONU</button>' : '<button class="btn" id="disable">Disable ONU</button>'}<button class="btn" id="move">Move ONU</button><button class="btn" id="edit">Edit details</button><button class="btn bad" id="del">Delete</button></div></div>
  <div class="grid g2"><div class="panel"><h3>Commands sent to the OLT for this ONU</h3>${d.cli.map(l => `<div class="small muted">${dt(l.createdAt)} - ${esc(l.action)} (${esc(l.via)})</div><pre>${esc(l.commands.join('\n'))}</pre>`).join('') || '<div class="empty">None yet</div>'}</div>
  <div class="panel"><h3>Events</h3>${table([{ label: 'Time', render: e => dt(e.createdAt) }, { label: 'Type', render: e => lbl(e.type, e.severity) }, { label: 'Message', key: 'message' }], d.events)}</div></div>`;
  const act = async a => { try { const r = await POST(`/api/onus/${id}/${a}`); showCli(r.cli); toast(`${a} sent`, 'ok'); setTimeout(router, 600); } catch (e) { fail(e); } };
  const edit = async (title, list) => modal(title, fields(list, o), { onSubmit: async v => { const r = await PUT(`/api/onus/${id}`, v); showCli(r.cli); toast('Saved', 'ok'); router(); } });
  $('#reboot').onclick = async () => { if (await confirmBox('Reboot this ONU? It goes offline ~45 seconds.')) act('reboot'); };
  $('#resync').onclick = () => act('resync_config');
  if ($('#disable')) $('#disable').onclick = async () => { if (await confirmBox('Disable (deactivate) this ONU?')) act('disable'); };
  if ($('#enable')) $('#enable').onclick = () => act('enable');
  $('#del').onclick = async () => { if (await confirmBox('Delete this ONU from the OLT? It will reappear in Unconfigured if still connected.')) { await DEL(`/api/onus/${id}`); toast('Deleted', 'ok'); location.hash = '#/configured'; } };
  $('#getStatus').onclick = async () => { const olt = META.olts.find(x => x.id === o.oltId); const cmd = olt.vendor === 'ZTE' ? `show gpon onu detail-info ${o.pon}\nshow pon power attenuation ${o.pon}` : `enable\nconfig\ndisplay ont info 0 ${o.board} ${o.port} ${o.onuId}\ninterface gpon 0/${o.board}\ndisplay ont optical-info ${o.port} ${o.onuId}\nquit`; const r = await POST(`/api/olts/${o.oltId}/cli`, { command: cmd, session: 'status' + Date.now() }); modal('ONU status from OLT', `<pre>${esc(cmd.split('\n').map(c => '> ' + c).join('\n'))}\n\n${esc(r.output)}</pre>`, { wide: true }); };
  $('#running').onclick = () => modal('Running configuration (what is on the OLT)', `<pre>${esc(d.running.join('\n'))}</pre>`, { wide: true });
  $('#ping').onclick = async () => { const r = await POST('/api/diagnostics/ping', { onuId: o.id }); modal('Ping ONU WAN', `<pre>${esc(r.output)}</pre>`); };
  $('#live').onclick = () => { toast('Live mode: refreshing every 10s'); clearInterval(timer); timer = setInterval(router, 10000); };
  $('#edit').onclick = () => edit('Edit ONU details', [{ name: 'name', label: 'Name' }, { name: 'address', label: 'Address or comment' }, { name: 'phone', label: 'Contact' }, { name: 'zoneId', label: 'Zone', type: 'select', blank: '-', options: META.zones.map(z => ({ value: z.id, label: z.name })) }, { name: 'odbId', label: 'ODB', type: 'select', blank: '-', options: META.odbs.map(z => ({ value: z.id, label: z.name })) }, { name: 'odbPort', label: 'ODB port' }, { name: 'onuTypeId', label: 'ONU type', type: 'select', options: META.onuTypes.map(t => ({ value: t.id, label: t.name })) }, { name: 'externalId', label: 'OneISP customer ID' }, { name: 'catv', label: 'CATV', type: 'checkbox' }]);
  $('#eSpeed').onclick = () => edit('Speed profiles', [{ name: 'downloadProfileId', label: 'Download', type: 'select', options: META.speedProfiles.filter(s => s.type === 'download').map(s => ({ value: s.id, label: s.name })) }, { name: 'uploadProfileId', label: 'Upload', type: 'select', options: META.speedProfiles.filter(s => s.type === 'upload').map(s => ({ value: s.id, label: s.name })) }]);
  $('#eWan').onclick = () => edit('WAN / VLAN / WiFi', [{ name: 'mode', label: 'Mode', type: 'select', options: ['routing', 'bridging'] }, { name: 'vlan', label: 'VLAN', type: 'select', options: META.vlans.map(v => ({ value: v.vlan, label: `${v.vlan} ${v.description}` })) }, { name: 'wanMode', label: 'WAN mode', type: 'select', options: ['pppoe', 'dhcp', 'static'] }, { name: 'staticIp', label: 'Static IP' }, { name: 'pppoeUser', label: 'PPPoE username' }, { name: 'pppoePass', label: 'PPPoE password' }, { name: 'wifiSsid', label: 'WiFi SSID' }, { name: 'wifiPassword', label: 'WiFi password' }]);
  if ($('#pull')) $('#pull').onclick = async () => { try { const r = await POST(`/api/onus/${id}/pull-oneisp`); showCli(r.cli.length ? r.cli : [{ action: 'mode', sn: o.sn, oltName: o.oltName, via: 'web', commands: r.running }], 'PPPoE credentials from OneISP'); toast('Updated from OneISP', 'ok'); router(); } catch (e) { fail(e); } };
  $('#move').onclick = () => { const olt = META.olts.find(x => x.id === o.oltId); modal('Move ONU to another PON port', fields([{ name: 'board', label: 'Board', type: 'select', options: ponBoards(olt).map(b => ({ value: b.slot, label: b.slot })) }, { name: 'port', label: 'Port', type: 'number' }], o), { onSubmit: async v => { await POST(`/api/onus/${id}/move`, v); toast('Moved', 'ok'); router(); } }); };
};

// ================================================= GRAPHS / EVENTS / DIAGNOSTICS / REPORTS
routes.graphs = async page => {
  page.innerHTML = `<div class="panel"><div class="row"><b>OLT</b><select id="olt"><option value="">All OLTs</option>${oltOpts().map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select></div></div><div id="g"></div>`;
  const draw = async () => {
    const g = await GET('/api/graphs?oltId=' + $('#olt').value);
    $('#g').innerHTML = `<div class="panel"><h3>ONUs online / offline</h3>${lineChart([{ name: 'Online', color: '#43a047', points: g.network.map(n => [n[0], n[1]]) }, { name: 'Offline', color: '#e53935', points: g.network.map(n => [n[0], n[2]]) }], { min: 0, fmt: v => Math.round(v) })}</div>
    <div class="panel"><h3>PON traffic (sum of ONUs)</h3>${lineChart([{ name: 'Download', color: '#1e88e5', points: g.traffic.map(p => [p[0], p[1]]) }, { name: 'Upload', color: '#43a047', points: g.traffic.map(p => [p[0], p[2]]) }], { min: 0, fmt: kbps })}</div>
    <div class="panel"><h3>Top consumers now</h3>${table([{ label: 'ONU', render: o => `<a href="#/onu/${o.id}">${esc(o.name)}</a> <span class="muted mono small">${esc(o.sn)}</span>` }, { label: 'Download', render: o => kbps(o.down) + 'bps' }, { label: 'Upload', render: o => kbps(o.up) + 'bps' }], g.top)}</div>`;
  };
  $('#olt').onchange = draw;
  await draw();
  timer = setInterval(draw, 30000);
};
routes.events = async page => {
  page.innerHTML = `<div class="panel"><div class="toolbar"><h2>Events</h2><div class="acts"><select id="type"><option value="">All types</option>${['los', 'power_fail', 'online', 'offline', 'authorized', 'deleted', 'reboot', 'autofind', 'disabled', 'enabled', 'resync', 'moved'].map(t => `<option>${t}</option>`).join('')}</select><select id="olt"><option value="">All OLTs</option>${oltOpts().map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select><button class="btn bad" id="clr">Clear</button></div></div><div id="l"></div></div>`;
  const draw = async () => { const l = await GET('/api/events?' + new URLSearchParams({ type: $('#type').value, oltId: $('#olt').value })); $('#l').innerHTML = table([{ label: 'Time', render: e => dt(e.createdAt) }, { label: 'Type', render: e => lbl(e.type, e.severity) }, { label: 'Severity', key: 'severity' }, { label: 'ONU', render: e => esc(e.onuSn || '-') }, { label: 'Message', key: 'message' }], l); };
  $('#type').onchange = draw; $('#olt').onchange = draw;
  $('#clr').onclick = async () => { await DEL('/api/events'); draw(); };
  await draw();
  timer = setInterval(draw, 20000);
};
routes.diagnostics = async page => {
  const d = await GET('/api/diagnostics');
  const t = (title, rows, hint) => `<div class="panel"><h3>${title} <span class="lbl">${rows.length}</span></h3>${hint ? `<div class="lesson small">${hint}</div>` : ''}${table([{ label: '', render: o => stIcon(o.status) }, { label: 'ONU', render: o => `<a href="#/onu/${o.id}">${esc(o.name)}</a>` }, { label: 'SN', render: o => `<span class="mono">${esc(o.sn)}</span>` }, { label: 'PON', render: o => `${esc(o.oltName)} ${esc(o.pon)}` }, { label: 'ODB', key: 'odbName' }, { label: 'Signal', render: sig }, { label: 'Last down', render: o => `${esc(o.lastDownCause || '-')} ${o.lastDownAt ? dt(o.lastDownAt) : ''}` }], rows, { empty: 'All good' })}</div>`;
  page.innerHTML = `<div class="panel"><h3>Ping tool</h3><div class="row"><input id="tgt" value="8.8.8.8"><button class="btn primary" id="pg">Ping from OLT</button></div><pre id="po" class="hidden"></pre></div>
  ${d.portsLos.length ? `<div class="panel"><h3>PON ports with LOS</h3><div class="lesson small">If many ONUs on one port are LOS at the same time, the problem is the feeder fiber or splitter (ODB), not the customers.</div>${table([{ label: 'Port', key: 'port' }, { label: 'LOS ONUs', key: 'count' }, { label: 'Total on port', key: 'total' }], d.portsLos)}</div>` : ''}
  <div class="grid g2">${t('LOS (loss of signal)', d.los, 'Red LOS light on ONU: fiber cut, bent drop cable, dirty connector or disconnected patch cord.')}${t('Power fail (dying gasp)', d.powerFail, 'Customer turned the ONU off or had a power cut. Usually not a network problem.')}
  ${t(`Critical signal (&lt; ${d.thresholds.critical} dBm)`, d.critical, 'Too weak: check splices, connectors, too many splitters, or a long drop. Clean connectors first.')}${t(`Warning signal (&lt; ${d.thresholds.warning} dBm)`, d.warning)}
  ${t('Offline over 24 hours', d.offlineLong)}${t('Not linked to OneISP', d.noOneIsp, 'These ONUs have no customer in billing - link them via Edit details &rarr; OneISP customer ID.')}</div>`;
  $('#pg').onclick = async () => { const r = await POST('/api/diagnostics/ping', { target: $('#tgt').value }); $('#po').textContent = r.output; $('#po').classList.remove('hidden'); };
};
routes.reports = async page => {
  const r = await GET('/api/reports');
  const t = (title, rows) => `<div class="panel"><h3>${title}</h3>${table([{ label: 'Group', render: x => esc(x.key) }, { label: 'Total', key: 'total' }, { label: 'Online', render: x => x.online ?? '-' }], rows)}</div>`;
  page.innerHTML = `<div class="panel"><div class="toolbar"><h2>Reports</h2><a class="btn primary" href="/api/reports/onus.csv">Export all ONUs (CSV)</a></div></div>
  <div class="panel"><h3>Signal distribution (online ONUs)</h3>${bars(r.signal.map(s => ({ label: s.key, total: s.total })), { color: '#fb8c00' })}</div>
  <div class="grid g3">${t('By status', r.byStatus)}${t('By OLT', r.byOlt)}${t('By zone', r.byZone)}${t('By ONU type', r.byType)}${t('By mode', r.byMode)}${t('By VLAN', r.byVlan)}${t('By download profile', r.bySpeed)}
  <div class="panel"><h3>Splitter (ODB) usage</h3>${table([{ label: 'ODB', key: 'key' }, { label: 'Used', render: x => `${x.used} / ${x.ports}` }, { label: 'Free', render: x => x.ports - x.used }], r.odbUsage)}</div></div>`;
};

// ================================================= OLT CLI + OLT DETAIL
function terminal(el, oltId) {
  const olt = META.olts.find(o => o.id === Number(oltId));
  const sid = 'term' + Math.random().toString(36).slice(2);
  el.innerHTML = `<div class="term" id="tout">Connected to ${esc(olt.name)} (${esc(olt.vendor)}) via telnet - simulated.\nType ? for supported commands. Try:\n${olt.vendor === 'ZTE' ? '  show gpon onu uncfg\n  show gpon onu state gpon-olt_1/1/1' : '  enable\n  config\n  display ont autofind all\n  interface gpon 0/0\n  display ont info 0 all'}\n\n</div><div class="term-row"><span id="tprompt">${olt.vendor === 'ZTE' ? 'ZXAN#' : esc(olt.name.includes('HQ') ? 'MA5608T>' : 'OLT>')}</span>&nbsp;<input id="tin" autocomplete="off" spellcheck="false"></div>`;
  const out = $('#tout', el), inp = $('#tin', el);
  const hist = []; let hi = 0;
  inp.onkeydown = async e => {
    if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); inp.value = hist[hi] || ''; return; }
    if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); inp.value = hist[hi] || ''; return; }
    if (e.key !== 'Enter') return;
    const cmd = inp.value; inp.value = '';
    if (cmd) { hist.push(cmd); hi = hist.length; }
    out.innerHTML += `<span class="in">${esc($('#tprompt', el).textContent)} ${esc(cmd)}</span>\n`;
    try { const r = await POST(`/api/olts/${oltId}/cli`, { command: cmd, session: sid }); if (r.output) out.innerHTML += esc(r.output) + '\n'; $('#tprompt', el).textContent = r.prompt; } catch (err) { out.innerHTML += esc(err.message) + '\n'; }
    out.scrollTop = out.scrollHeight;
  };
  inp.focus();
  POST(`/api/olts/${oltId}/cli`, { command: '', session: sid }).then(r => ($('#tprompt', el).textContent = r.prompt));
}
routes.cli = async page => {
  page.innerHTML = `<div class="panel"><div class="toolbar"><h2>OLT CLI (telnet simulator)</h2><select id="olt">${oltOpts().map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select></div>
  <div class="lesson">This is what you would see over telnet/SSH on a real OLT. Commands change the real simulator state: an <span class="mono">ont add</span> here appears in <b>Configured</b>. Arrow-up recalls history.</div><div id="term"></div></div>`;
  $('#olt').onchange = () => terminal($('#term'), $('#olt').value);
  terminal($('#term'), $('#olt').value);
};
routes['olt/:id'] = async (page, id) => {
  const d = await GET(`/api/olts/${id}`);
  const o = d.olt;
  page.innerHTML = `<div class="panel"><div class="toolbar"><h2>${esc(o.name)} <span class="muted small">${esc(o.vendor)} ${esc(o.hardware)} ${esc(o.software)}</span></h2><div class="acts"><a class="btn" href="#/configured">ONUs</a><button class="btn" id="edit">Edit OLT</button></div></div>
    <div class="kv"><div>IP / telnet</div><div class="mono">${esc(o.ip)}:${o.telnetPort}</div><div>SNMP</div><div class="mono">${o.snmpPort} community ${esc(o.snmpCommunity || '')}</div><div>Boards</div><div>${o.boards.map(b => `slot ${b.slot}: <b>${esc(b.type)}</b>${b.ports ? ` (${b.ports} PON)` : ''}`).join(' &middot; ')}</div><div>Uptime</div><div>${Math.floor((Date.now() - new Date(o.bootTime)) / 864e5)} days</div><div>Temperature</div><div>${Math.round(o.temperature)} &deg;C</div></div></div>
  <div class="panel"><h3>PON ports</h3><div class="ports">${d.ports.map(p => `<div class="port ${p.total ? 'has' : ''} ${p.los ? 'alarm' : ''}" data-b="${p.board}" data-p="${p.port}"><b>${p.board}/${p.port}</b>${p.online}/${p.total} online${p.los ? `<div style="color:var(--bad)">${p.los} LOS</div>` : ''}${p.waiting ? `<div style="color:var(--blue2)">${p.waiting} waiting</div>` : ''}<div class="muted">avg ${p.avgRx}</div></div>`).join('')}</div></div>
  <div class="grid g2"><div class="panel"><h3>OLT base configuration SmartOLT expects</h3><div class="lesson small">VLANs on the uplink, traffic tables (speed profiles), the flexible line profile and one service profile per ONU type. Run once when adding an OLT.</div><pre>${esc(d.setup)}</pre></div>
  <div class="panel"><h3>CLI</h3><div id="term"></div></div></div>`;
  $$('.port').forEach(p => (p.onclick = () => { location.hash = `#/configured?olt=${id}&board=${p.dataset.b}&port=${p.dataset.p}`; }));
  $('#edit').onclick = () => collectionForm('olts', o);
  terminal($('#term'), id);
};

// ================================================= SETTINGS
const COLS = {
  olts: { title: 'OLTs', fields: [{ name: 'name', label: 'Name' }, { name: 'vendor', label: 'Vendor', type: 'select', options: ['Huawei', 'ZTE'] }, { name: 'hardware', label: 'Hardware', placeholder: 'MA5608T / MA5800-X2 / C320' }, { name: 'software', label: 'Software version' }, { name: 'hostname', label: 'CLI hostname' }, { name: 'ip', label: 'IP' }, { name: 'telnetPort', label: 'Telnet port', type: 'number', value: 23 }, { name: 'snmpPort', label: 'SNMP port', type: 'number', value: 161 }, { name: 'snmpCommunity', label: 'SNMP community', value: 'public' }, { name: 'uplinkSlot', label: 'Uplink slot (Huawei)', type: 'number' }, { name: 'uplinkPort', label: 'Uplink port (Huawei)', type: 'number' }, { name: 'uplink', label: 'Uplink interface (ZTE)' }, { name: 'boards', label: 'Boards "slot:type:ports, ..."', full: true, placeholder: '0:GPFD:16, 1:GPFD:16, 2:MCUD:0' }],
    cols: [{ label: 'Name', render: r => `<a href="#/olt/${r.id}">${esc(r.name)}</a>` }, { label: 'Vendor', render: r => `${esc(r.vendor)} ${esc(r.hardware)}` }, { label: 'IP', key: 'ip' }, { label: 'Boards', render: r => (r.boards || []).map(b => `${b.slot}:${b.type}`).join(', ') }, { label: 'ONUs', key: 'used' }] },
  zones: { title: 'Zones', fields: [{ name: 'name', label: 'Zone name' }], cols: [{ label: 'Name', key: 'name' }, { label: 'ONUs', key: 'used' }] },
  odbs: { title: 'ODBs (splitters)', fields: [{ name: 'name', label: 'Name' }, { name: 'zoneId', label: 'Zone', type: 'select', options: () => META.zones.map(z => ({ value: z.id, label: z.name })) }, { name: 'splitter', label: 'Splitter ratio', type: 'select', options: ['1:2', '1:4', '1:8', '1:16', '1:32'] }, { name: 'ports', label: 'Ports', type: 'number', value: 8 }, { name: 'latitude', label: 'Latitude' }, { name: 'longitude', label: 'Longitude' }],
    cols: [{ label: 'Name', key: 'name' }, { label: 'Zone', render: r => esc(META.zones.find(z => z.id === r.zoneId)?.name || '-') }, { label: 'Splitter', key: 'splitter' }, { label: 'Ports', key: 'ports' }, { label: 'ONUs', key: 'used' }, { label: 'GPS', render: r => `${r.latitude ?? ''}, ${r.longitude ?? ''}` }] },
  onuTypes: { title: 'ONU types', fields: [{ name: 'name', label: 'Name' }, { name: 'vendor', label: 'Vendor', type: 'select', options: ['Huawei', 'ZTE', 'VSOL', 'Other'] }, { name: 'ponType', label: 'PON type', type: 'select', options: ['GPON', 'EPON'] }, { name: 'ethPorts', label: 'Ethernet ports', type: 'number' }, { name: 'voip', label: 'POTS ports', type: 'number' }, { name: 'wifi', label: 'WiFi', type: 'checkbox' }, { name: 'catv', label: 'CATV', type: 'checkbox' }, { name: 'srvProfileId', label: 'Huawei ont-srvprofile-id', type: 'number' }, { name: 'modes', label: 'Allowed modes', type: 'select', options: ['routing,bridging', 'bridging', 'routing'] }],
    cols: [{ label: 'Name', key: 'name' }, { label: 'Vendor', key: 'vendor' }, { label: 'PON', key: 'ponType' }, { label: 'Eth', key: 'ethPorts' }, { label: 'POTS', key: 'voip' }, { label: 'WiFi', render: r => (r.wifi ? 'yes' : '-') }, { label: 'CATV', render: r => (r.catv ? 'yes' : '-') }, { label: 'Srv profile', key: 'srvProfileId' }, { label: 'Modes', key: 'modes' }, { label: 'ONUs', key: 'used' }] },
  speedProfiles: { title: 'Speed profiles', fields: [{ name: 'name', label: 'Name', placeholder: '20M' }, { name: 'type', label: 'Direction', type: 'select', options: ['download', 'upload'] }, { name: 'speed', label: 'Speed (kbps)', type: 'number' }, { name: 'index', label: 'Huawei traffic-table index', type: 'number' }],
    cols: [{ label: 'Name', key: 'name' }, { label: 'Direction', key: 'type' }, { label: 'Speed', render: r => `${r.speed} kbps (${kbps(r.speed)})` }, { label: 'Traffic table', key: 'index' }, { label: 'ONUs', key: 'used' }] },
  vlans: { title: 'VLANs', fields: [{ name: 'vlan', label: 'VLAN ID', type: 'number' }, { name: 'description', label: 'Description' }], cols: [{ label: 'VLAN', key: 'vlan' }, { label: 'Description', key: 'description' }] },
};
function collectionForm(name, rec) {
  const c = COLS[name];
  const v = rec ? { ...rec, boards: Array.isArray(rec.boards) ? rec.boards.map(b => `${b.slot}:${b.type}:${b.ports}`).join(', ') : rec.boards } : {};
  modal(`${rec ? 'Edit' : 'Add'} ${c.title}`, fields(c.fields.map(f => ({ ...f, options: typeof f.options === 'function' ? f.options() : f.options })), v), { onSubmit: async val => { rec ? await PUT(`/api/settings/${name}/${rec.id}`, val) : await POST(`/api/settings/${name}`, val); toast('Saved', 'ok'); router(); } });
}
routes.settings = async page => {
  const tabs = [['general', 'General'], ...Object.entries(COLS).map(([k, c]) => [k, c.title]), ['cli', 'OLT command log']];
  const cur = sessionStorage.soTab || 'general';
  page.innerHTML = `<div class="panel"><div class="tabs">${tabs.map(([k, l]) => `<div class="tab ${k === cur ? 'active' : ''}" data-t="${k}">${l}</div>`).join('')}</div><div id="tb"></div></div>`;
  $$('.tab').forEach(t => (t.onclick = () => { sessionStorage.soTab = t.dataset.t; router(); }));
  const tb = $('#tb');
  if (cur === 'general') {
    const s = await GET('/api/settings');
    tb.innerHTML = `<form id="f">${fields([{ name: 'companyName', label: 'Company name' }, { name: 'apiToken', label: 'SmartOLT API key (X-Token) - give this to OneISP' }, { name: 'oi_url', label: 'OneISP URL', value: s.oneisp.url }, { name: 'oi_token', label: 'OneISP API token', value: s.oneisp.token }, { name: 'signalWarning', label: 'Signal warning below (dBm)', type: 'number' }, { name: 'signalCritical', label: 'Signal critical below (dBm)', type: 'number' }, { name: 'tr069Url', label: 'TR-069 ACS URL' }, { name: 'username', label: 'Login username' }, { name: 'password', label: 'New login password (blank = keep)', type: 'password', value: '' },
      { name: 'sim_faults', label: 'Simulate random LOS / power fails', type: 'checkbox', value: s.simulation.faults }, { name: 'sim_autofind', label: 'Simulate new ONUs appearing in autofind', type: 'checkbox', value: s.simulation.autofind }, { name: 'sim_speed', label: 'Fault rate multiplier', type: 'number', value: s.simulation.speed }], s)}
      <div class="row"><button class="btn primary">Save</button><button type="button" class="btn" id="t">Test OneISP</button><button type="button" class="btn" id="sy">Sync PPPoE credentials from OneISP</button><span class="spacer"></span><button type="button" class="btn bad" id="rs">Reset demo data</button></div></form>
      <div class="lesson" style="margin-top:16px"><b>API</b> (like the real SmartOLT API, send header <span class="mono">X-Token: ${esc(s.apiToken)}</span>):<br>
      <span class="mono small">GET /api/system/get_olts &middot; GET /api/onu/unconfigured_onus &middot; GET /api/onu/get_all_onus_details &middot; GET /api/onu/get_onu_details/{sn} &middot; GET /api/onu/get_onu_signal/{sn} &middot; POST /api/onu/authorize_onu &middot; POST /api/onu/reboot/{sn} &middot; POST /api/onu/resync_config/{sn} &middot; POST /api/onu/disable/{sn} &middot; POST /api/onu/enable/{sn} &middot; POST /api/onu/delete/{sn}</span></div>`;
    $('#f').onsubmit = async e => { e.preventDefault(); const v = formData(e.target); await PUT('/api/settings', { ...v, oneisp: { url: v.oi_url, token: v.oi_token }, simulation: { faults: v.sim_faults, autofind: v.sim_autofind, speed: v.sim_speed } }); toast('Saved', 'ok'); };
    $('#t').onclick = async () => { try { const r = await POST('/api/settings/oneisp/test'); toast(`OneISP OK - ${r.customers} customers`, 'ok'); } catch (e) { fail(e); } };
    $('#sy').onclick = async () => { try { const r = await POST('/api/settings/oneisp/sync'); toast(`${r.updated} ONU(s) updated`, 'ok'); } catch (e) { fail(e); } };
    $('#rs').onclick = async () => { if (await confirmBox('Reset all SmartOLT data to the demo?')) { await POST('/api/settings/reset'); location.reload(); } };
  } else if (cur === 'cli') {
    const l = await GET('/api/cli-log');
    tb.innerHTML = l.map(x => `<div class="small muted">${dt(x.createdAt)} &middot; ${esc(x.oltName)} &middot; ${esc(x.action)} ${esc(x.sn)} (${esc(x.via)})</div><pre>${esc(x.commands.join('\n'))}</pre>`).join('') || '<div class="empty">Nothing yet</div>';
  } else {
    const c = COLS[cur];
    const list = await GET(`/api/settings/${cur}`);
    tb.innerHTML = `<div class="toolbar"><h3>${c.title}</h3><button class="btn primary" id="add">+ Add</button></div>${table([...c.cols, { label: '', render: r => `<button class="btn sm bad" data-del="${r.id}">Delete</button>` }], list, { onRow: r => collectionForm(cur, r) })}`;
    $('#add').onclick = () => collectionForm(cur);
    $$('[data-del]').forEach(b => (b.onclick = async () => { try { await DEL(`/api/settings/${cur}/${b.dataset.del}`); router(); } catch (e) { fail(e); } }));
  }
};

routes.learn = async page => {
  page.innerHTML = `<div class="panel"><h2>How GPON + SmartOLT work (and how they meet MikroTik / OneISP)</h2>
  <div class="lesson"><b>The chain:</b> Internet &rarr; <b>MikroTik</b> (PPPoE server, billing enforced by OneISP) &rarr; VLAN 100 trunk &rarr; <b>OLT</b> uplink &rarr; PON port (1 fiber) &rarr; <b>ODB splitter</b> 1:8 / 1:16 &rarr; drop cable &rarr; <b>ONU</b> at the customer.</div>
  <div class="lesson"><b>Optical budget:</b> OLT transmits about +3..+5 dBm. Every splitter costs ~3.5 dB per split level (1:8 &asymp; 10.5 dB, 1:16 &asymp; 13.5 dB), each km of fiber ~0.35 dB, each connector ~0.5 dB. Good ONU Rx is <b>-15 to -25 dBm</b>; below <b>-27</b> is critical; ONUs stop working near -28/-29 dBm.</div>
  <div class="lesson"><b>Authorization (Huawei):</b><br><span class="mono">interface gpon 0/0</span> &rarr; <span class="mono">ont add 1 5 sn-auth "HWTC12345678" omci ont-lineprofile-id 10 ont-srvprofile-id 11 desc "John"</span><br>
  <span class="mono">ont ipconfig 1 5 ip-index 0 pppoe vlan 100 ... username "ln1001" password "..."</span> (routing mode) or <span class="mono">ont port native-vlan 1 5 eth 1 vlan 100</span> (bridge mode)<br>
  <span class="mono">quit</span> &rarr; <span class="mono">service-port 101 vlan 100 gpon 0/0/1 ont 5 gemport 1 multi-service user-vlan 100 ...</span> (connects the ONU's traffic to uplink VLAN 100)</div>
  <div class="lesson"><b>Routing vs bridging:</b> In <b>routing</b> mode the ONU is the customer's router and dials PPPoE itself with the OneISP username/password. In <b>bridging</b> mode the ONU is just a media converter: a customer router (TP-Link, MikroTik hAP...) behind it dials PPPoE.</div>
  <div class="lesson"><b>MikroTik side for fiber customers:</b><br><span class="mono">/interface vlan add name=vlan100-ftth vlan-id=100 interface=ether2</span><br><span class="mono">/interface pppoe-server server add service-name=ftth interface=vlan100-ftth default-profile=OI-DEFAULT disabled=no</span><br>OneISP keeps the PPP secrets; SmartOLT keeps the ONUs; the PPPoE username is the link between them.</div>
  <div class="lesson"><b>Status meanings:</b> &#127760; online &middot; &#128268; power fail = dying-gasp (customer power off) &middot; &#10007; LOS = no light (fiber problem) &middot; grey = offline/unknown &middot; &#8856; disabled by you.</div>
  <div class="lesson"><b>Exercises:</b> 1) Unconfigured &rarr; authorize HWTC9F3E2A11 linked to a OneISP customer. 2) OLT CLI: <span class="mono">enable / config / interface gpon 0/0 / display ont autofind all / ont add 5 1 sn-auth HWTCB7C41D02 omci ont-lineprofile-id 10 ont-srvprofile-id 12 desc "cli test"</span>. 3) Diagnostics: find the LOS ONU and the customer ticket about it in OneISP. 4) Change an ONU speed profile and read the new service-port. 5) Delete an ONU and see it come back in autofind.</div>
  <p>More: <span class="mono">docs/SMARTOLT-GPON.md</span></p></div>`;
};

boot();
