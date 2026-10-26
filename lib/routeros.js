// RouterOS v7 integration.
// Every change OneISP makes is described as an "op":
//   { menu: '/ppp/secret', action: 'add'|'set'|'remove'|'upsert'|'exec', find: {name:'x'}, props: {...}, note }
// An op can be rendered as terminal CLI (so you can learn the command) and executed either
// against a real router through the REST API (http(s)://router/rest/...) or against a
// simulated router whose state is kept in the OneISP database.
const http = require('http');
const https = require('https');

function q(v) {
  v = String(v);
  return /^[A-Za-z0-9_.\-\/:@,*+]+$/.test(v) ? v : '"' + v.replace(/(["\\$])/g, '\\$1') + '"';
}
function propsCli(props = {}) {
  return Object.entries(props).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${q(v)}`).join(' ');
}
function findCli(find = {}) {
  const parts = Object.entries(find).map(([k, v]) => `${k}=${q(v)}`);
  return parts.length ? `[find ${parts.join(' ')}]` : '';
}

function toCli(op) {
  const menu = op.menu.replace(/\//g, ' ').trim();
  switch (op.action) {
    case 'add': return `/${menu} add ${propsCli({ ...op.find, ...op.props })}`;
    case 'set': return `/${menu} set ${findCli(op.find)} ${propsCli(op.props)}`;
    case 'remove': return `/${menu} remove ${findCli(op.find)}`;
    case 'upsert': {
      const f = findCli(op.find);
      const p = propsCli({ ...op.find, ...op.props });
      return `:if ([:len ${f}] = 0) do={ /${menu} add ${p} } else={ /${menu} set ${f} ${propsCli(op.props)} }`;
    }
    case 'exec': return op.script;
    default: return `# unknown op ${op.action}`;
  }
}

// ---------- REST client ----------
class RestClient {
  constructor(site) { this.site = site; }
  request(method, pathname, body) {
    const s = this.site;
    const lib = s.useHttps ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = lib.request({
        host: s.host, port: s.port || (s.useHttps ? 443 : 80), method, path: '/rest' + pathname,
        auth: `${s.username}:${s.password}`, rejectUnauthorized: false, timeout: 8000,
        headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { json = data; }
          if (res.statusCode >= 400) {
            const msg = json && (json.detail || json.message) ? `${json.message || ''} ${json.detail || ''}`.trim() : `HTTP ${res.statusCode}`;
            return reject(new Error(`${method} /rest${pathname}: ${msg}`));
          }
          resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new Error(`Timeout connecting to ${s.host}:${s.port}`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  async list(menu, find) {
    const qs = find && Object.keys(find).length ? '?' + new URLSearchParams(find).toString() : '';
    return (await this.request('GET', menu + qs)) || [];
  }
  async run(op) {
    const stringify = p => Object.fromEntries(Object.entries(p || {}).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    switch (op.action) {
      case 'add': return this.request('PUT', op.menu, stringify(op.props));
      case 'set': {
        const rows = await this.list(op.menu, op.find);
        for (const r of rows) await this.request('PATCH', `${op.menu}/${r['.id']}`, stringify(op.props));
        return { matched: rows.length };
      }
      case 'remove': {
        const rows = await this.list(op.menu, op.find);
        for (const r of rows) await this.request('DELETE', `${op.menu}/${r['.id']}`);
        return { removed: rows.length };
      }
      case 'upsert': {
        const rows = await this.list(op.menu, op.find);
        if (!rows.length) { await this.request('PUT', op.menu, stringify({ ...op.find, ...op.props })); return { did: 'add' }; }
        for (const r of rows) await this.request('PATCH', `${op.menu}/${r['.id']}`, stringify(op.props));
        return { did: 'set', updated: rows.length };
      }
      case 'exec': return this.request('POST', '/execute', { script: op.script });
    }
  }
}

// ---------- Simulated router ----------
// State shape: { '/ppp/secret': [ {'.id':'*1', name:..}, ...], ... }
class SimRouter {
  constructor(state) { this.state = state; }
  table(menu) { return (this.state[menu] = this.state[menu] || []); }
  match(row, find = {}) { return Object.entries(find).every(([k, v]) => String(row[k]) === String(v)); }
  nextId() { this.state._id = (this.state._id || 0) + 1; return '*' + this.state._id.toString(16).toUpperCase(); }
  async list(menu, find) { return this.table(menu).filter(r => this.match(r, find)); }
  async run(op) {
    const t = op.menu ? this.table(op.menu) : null;
    const clean = p => Object.fromEntries(Object.entries(p || {}).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    switch (op.action) {
      case 'add': { const row = { '.id': this.nextId(), disabled: 'false', ...clean(op.props) }; t.push(row); return row; }
      case 'set': { const rows = t.filter(r => this.match(r, op.find)); rows.forEach(r => Object.assign(r, clean(op.props))); return { matched: rows.length }; }
      case 'remove': {
        const before = t.length;
        this.state[op.menu] = t.filter(r => !this.match(r, op.find));
        return { removed: before - this.state[op.menu].length };
      }
      case 'upsert': {
        const rows = t.filter(r => this.match(r, op.find));
        if (!rows.length) { t.push({ '.id': this.nextId(), disabled: 'false', ...clean({ ...op.find, ...op.props }) }); return { did: 'add' }; }
        rows.forEach(r => Object.assign(r, clean(op.props)));
        return { did: 'set', updated: rows.length };
      }
      case 'exec': return { ok: true, note: 'Scripts are not interpreted by the simulated router' };
    }
  }
}

module.exports = { toCli, RestClient, SimRouter, q };
