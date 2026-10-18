// Test-only stand-in for `better-sqlite3`, built on Node's built-in `node:sqlite`
// (Node >= 22.5). It exists so the REAL db.js / sync.js can be executed under plain
// `node --test` without the native module, which is compiled for Electron's ABI and
// usually will not load under the system Node. Only the API surface db.js/sync.js use.
const { DatabaseSync } = require('node:sqlite');

class Database {
  constructor(file) {
    this._db = new DatabaseSync(file);
    this._depth = 0;
  }
  pragma(text) { return this._db.prepare(`PRAGMA ${text}`).all(); }
  exec(sql) { this._db.exec(sql); return this; }
  prepare(sql) {
    const st = this._db.prepare(sql);
    return {
      run: (...a) => st.run(...a),
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
    };
  }
  // better-sqlite3 semantics: returns a function; BEGIN/COMMIT around it, SAVEPOINT when nested.
  transaction(fn) {
    const self = this;
    return function wrapped(...args) {
      const nested = self._depth > 0;
      const sp = `sp_${self._depth}`;
      self._db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN');
      self._depth += 1;
      try {
        const result = fn.apply(this, args);
        self._depth -= 1;
        self._db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
        return result;
      } catch (err) {
        self._depth -= 1;
        self._db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
        throw err;
      }
    };
  }
  close() { this._db.close(); }
}

module.exports = Database;
