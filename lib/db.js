// Tiny JSON-file database. Everything lives in memory and is flushed to disk shortly after each change.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, seed) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      this.data = { _seq: {} };
      if (seed) seed(this);
      this.flush();
    }
    this.data._seq = this.data._seq || {};
  }
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
  // Keep only the newest `max` records of a log-style collection.
  trim(name, max) { const arr = this.col(name); if (arr.length > max) arr.splice(0, arr.length - max); }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 300);
  }
  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
