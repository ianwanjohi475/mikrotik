// SQLite database (Node's built-in node:sqlite - no install needed).
//
// Every collection is a real SQL table:   customers(id INTEGER PRIMARY KEY, created_at, updated_at, data JSON)
// plus a view with one column per field:  v_customers(id, name, phone, status, expiresAt, ...)
// Single objects (settings, counters, simulated router state) live in the table kv(key, value JSON).
//
// The apps work on in-memory records and call save(); changed rows are written to SQLite in one
// transaction shortly after. Open data/*.db with "DB Browser for SQLite" or use the SQL console page.
const fs = require('fs');
const path = require('path');

let sqlite = null;
try {
  // hide Node's "SQLite is experimental" warning
  const emit = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
  sqlite = require('node:sqlite');
} catch { sqlite = null; }

const ident = n => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : null);

class Store {
  constructor(file, seed) {
    // `file` may end in .json (old name) - the database lives next to it as .db
    this.jsonFile = file.replace(/\.db$/, '.json');
    this.file = sqlite ? file.replace(/\.json$/, '.db') : this.jsonFile;
    this.sql = !!sqlite;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.written = new Map(); // "table:id" -> json last written
    this.viewCols = {};

    if (!this.sql) {
      console.warn(`[db] node:sqlite not available in Node ${process.version} - using JSON file ${this.file}. Install Node 22.13+ for SQLite.`);
      if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      else { this.data = { _seq: {} }; if (seed) seed(this); this.flush(); }
      this.data._seq = this.data._seq || {};
      return;
    }

    const fresh = !fs.existsSync(this.file);
    this.db = new sqlite.DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    if (fresh) {
      if (fs.existsSync(this.jsonFile)) {
        // migrate data from the older JSON-file version
        this.data = JSON.parse(fs.readFileSync(this.jsonFile, 'utf8'));
        fs.renameSync(this.jsonFile, this.jsonFile + '.imported');
        console.log(`[db] imported ${path.basename(this.jsonFile)} into ${path.basename(this.file)}`);
      } else {
        this.data = { _seq: {} };
        if (seed) seed(this);
      }
      this.data._seq = this.data._seq || {};
      this.flush();
    } else {
      this.load();
    }
  }

  // ---------------------------------------------------------------- loading
  tables() { return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('kv') AND name NOT LIKE 'sqlite_%'").all().map(r => r.name); }
  load() {
    this.data = {};
    for (const { key, value } of this.db.prepare('SELECT key, value FROM kv').all()) {
      this.data[key] = JSON.parse(value);
      this.written.set(`kv:${key}`, value);
    }
    for (const t of this.tables()) {
      this.data[t] = this.db.prepare(`SELECT id, data FROM "${t}" ORDER BY id`).all().map(r => {
        this.written.set(`${t}:${r.id}`, r.data);
        return JSON.parse(r.data);
      });
    }
    this.data._seq = this.data._seq || {};
  }

  // ---------------------------------------------------------------- API used by the apps (unchanged)
  col(name) { return (this.data[name] = this.data[name] || []); }
  obj(name, defaults = {}) { return (this.data[name] = { ...defaults, ...(this.data[name] || {}) }); }
  nextId(name) { this.data._seq[name] = (this.data._seq[name] || 0) + 1; return this.data._seq[name]; }
  insert(name, doc) {
    const rec = { id: this.nextId(name), createdAt: new Date().toISOString(), ...doc };
    this.col(name).push(rec);
    this.save();
    return rec;
  }
  get(name, id) { return this.col(name).find(r => r.id === Number(id)); }
  find(name, pred = () => true) { return this.col(name).filter(pred); }
  findOne(name, pred) { return this.col(name).find(pred); }
  update(name, id, patch) {
    const rec = this.get(name, id);
    if (!rec) return null;
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return rec;
  }
  remove(name, id) {
    const arr = this.col(name);
    const i = arr.findIndex(r => r.id === Number(id));
    if (i >= 0) arr.splice(i, 1);
    this.save();
    return i >= 0;
  }
  trim(name, max) { const arr = this.col(name); if (arr.length > max) arr.splice(0, arr.length - max); }
  // wipe everything and re-seed (used by "Reset demo data")
  reset(seed) { this.data = { _seq: {} }; if (seed) seed(this); this.flush(); }
  save() { clearTimeout(this._t); this._t = setTimeout(() => this.flush(), 300); }

  // ---------------------------------------------------------------- writing
  flush() {
    clearTimeout(this._t);
    if (!this.sql) {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
      return;
    }
    const db = this.db;
    const seen = new Set();
    db.exec('BEGIN');
    try {
      for (const [name, val] of Object.entries(this.data)) {
        const isCollection = Array.isArray(val) && val.every(r => r && typeof r === 'object' && Number.isInteger(r.id));
        if (!isCollection || !ident(name)) {
          const json = JSON.stringify(val);
          seen.add(`kv:${name}`);
          if (this.written.get(`kv:${name}`) !== json) { db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(name, json); this.written.set(`kv:${name}`, json); }
          continue;
        }
        this.ensureTable(name);
        let up = null;
        for (const r of val) {
          const k = `${name}:${r.id}`;
          seen.add(k);
          const json = JSON.stringify(r);
          if (this.written.get(k) === json) continue;
          up = up || db.prepare(`INSERT INTO "${name}"(id, created_at, updated_at, data) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data`);
          up.run(r.id, r.createdAt || null, r.updatedAt || null, json);
          this.written.set(k, json);
        }
        this.refreshView(name, val);
      }
      // rows removed in memory are deleted in SQL
      for (const k of [...this.written.keys()]) {
        if (seen.has(k)) continue;
        const i = k.indexOf(':');
        const t = k.slice(0, i), id = k.slice(i + 1);
        if (t === 'kv') db.prepare('DELETE FROM kv WHERE key = ?').run(id);
        else db.prepare(`DELETE FROM "${t}" WHERE id = ?`).run(Number(id));
        this.written.delete(k);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error('[db] write failed:', e.message);
    }
  }
  ensureTable(name) {
    if (this._made?.has(name)) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (id INTEGER PRIMARY KEY, created_at TEXT, updated_at TEXT, data TEXT NOT NULL CHECK (json_valid(data)))`);
    (this._made = this._made || new Set()).add(name);
  }
  // v_<table>: one real column per top-level field, so plain SQL works: SELECT name, phone FROM v_customers WHERE status='expired'
  refreshView(name, rows) {
    const cols = new Set();
    for (const r of rows) for (const [k, v] of Object.entries(r)) if (ident(k) && k !== 'id' && (v === null || typeof v !== 'object')) cols.add(k);
    const sig = [...cols].sort().join(',');
    if (this.viewCols[name] === sig) return;
    this.viewCols[name] = sig;
    this.db.exec(`DROP VIEW IF EXISTS "v_${name}"`);
    this.db.exec(`CREATE VIEW "v_${name}" AS SELECT id${[...cols].map(c => `, json_extract(data, '$.${c}') AS "${c}"`).join('')} FROM "${name}"`);
  }

  // ---------------------------------------------------------------- SQL console (read-only)
  query(text) {
    if (!this.sql) throw new Error('SQLite is not available in this Node version (need Node 22.13 or newer)');
    const q = String(text || '').trim().replace(/;\s*$/, '');
    if (!/^(select|with|pragma\s+table_info|explain)\b/i.test(q) || /;\s*\S/.test(q)) throw new Error('Only a single SELECT / WITH / PRAGMA table_info / EXPLAIN query is allowed here (read-only)');
    this.flush();
    // a separate read-only connection: even "WITH ... DELETE" cannot change anything
    this.ro = this.ro || new sqlite.DatabaseSync(this.file, { readOnly: true });
    const t0 = Date.now();
    const stmt = this.ro.prepare(q);
    const rows = stmt.all();
    return { rows: rows.slice(0, 1000), count: rows.length, ms: Date.now() - t0, truncated: rows.length > 1000 };
  }
  schema() {
    if (!this.sql) return [];
    this.flush();
    return this.db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type DESC, name").all()
      .map(o => ({ ...o, rows: o.type === 'table' ? this.db.prepare(`SELECT COUNT(*) AS n FROM "${o.name}"`).get().n : null,
        columns: this.db.prepare(`PRAGMA table_info("${o.name}")`).all().map(c => c.name) }));
  }
}

module.exports = { Store };
