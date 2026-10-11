require('./_setup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbm = require('../src/main/db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchline-test-'));
  const db = dbm.openDb(path.join(dir, 'pos.db'));
  return { db, dir, cleanup: () => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

function login(db, tokens = { access: 'access-1', refresh: 'refresh-1' }) {
  dbm.setSetting(db, 'auth_tokens', JSON.stringify(tokens));
}

function stockOf(db, productId) {
  return db.prepare(`SELECT COALESCE(SUM(quantity_remaining),0) AS n FROM stock_batches WHERE product_id = ? AND is_deleted = 0`).get(productId).n;
}

function seedProduct(db, { name = 'Cola', qty = 45 } = {}) {
  const product = dbm.createProduct(db, { name, sell_price: 100 });
  const batch = qty ? dbm.addStockBatch(db, { product_id: product.id, quantity_received: qty }) : null;
  return { product, batch };
}

// The realistic starting point for the stock tests: the catalog (product + batch) reached the
// cloud long ago; only the offline SALE is still waiting in the outbox.
function markCatalogSynced(db) {
  db.prepare(`UPDATE sync_queue SET status = 'synced' WHERE entity_type IN ('product', 'stock_batch')`).run();
}

function sellLocally(db, productId, quantity) {
  return dbm.createSale(db)({
    items: [{ product_id: productId, item_name: 'Cola', quantity, unit_price: 100 }],
    amount_paid: 100 * quantity,
  });
}

// Insert outbox rows with explicit, strictly increasing timestamps (ORDER BY client_timestamp).
function seedQueue(db, specs) {
  const base = Date.now() - 60_000;
  specs.forEach((spec, i) => {
    const id = spec.id || dbm.uuid();
    db.prepare(
      `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, client_timestamp, status)
       VALUES (?, ?, ?, 'create', ?, ?, 'pending')`
    ).run(id, spec.entity_type, spec.entity_id || id, JSON.stringify({ id }), new Date(base + i).toISOString());
  });
}

const queueCount = (db, status) => db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE status = ?`).get(status).n;

// A controllable stand-in for the Django backend, installed as global fetch.
class FakeCloud {
  constructor() {
    this.pushRequests = [];          // arrays of operation ids, one entry per POST
    this.authHeaders = [];
    this.pushInFlight = 0; this.maxPushInFlight = 0;
    this.pullInFlight = 0; this.maxPullInFlight = 0; this.pullCount = 0;
    this.networkDown = false;
    this.delayMs = 0;
    this.pushHttpStatus = 200;       // anything but 200 -> that status, no body
    this.unauthorizedOnce = false;   // first push answers 401
    this.refreshStatus = 200;
    this.refreshBody = { access: 'access-2' };
    this.applied = new Set();                       // what the "server" has durably applied, by operation id
    this.dropResponseOnce = false;                  // apply the batch, then lose the response (the dangerous case)
    this.pushBehavior = (ops) => ops.map((o) => {
      const duplicate = this.applied.has(o.id);     // idempotency: same id again -> already_applied
      this.applied.add(o.id);
      return { id: o.id, status: duplicate ? 'already_applied' : 'applied' };
    });
    this.pullBody = { operations: [], server_time: new Date().toISOString() };
  }
  install() { globalThis.fetch = (url, init) => this._handle(String(url), init || {}); return this; }
  _json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
  async _handle(url, init) {
    if (this.networkDown) throw new TypeError('fetch failed');
    if (this.delayMs) await sleep(this.delayMs);
    if (url.endsWith('/sync/push/')) {
      this.authHeaders.push((init.headers || {}).Authorization);
      this.pushInFlight += 1; this.maxPushInFlight = Math.max(this.maxPushInFlight, this.pushInFlight);
      try {
        const ops = JSON.parse(init.body).operations;
        this.pushRequests.push(ops.map((o) => o.id));
        if (this.unauthorizedOnce) { this.unauthorizedOnce = false; return this._json({}, 401); }
        if (this.pushHttpStatus !== 200) return this._json({ detail: 'nope' }, this.pushHttpStatus);
        const results = this.pushBehavior(ops);
        if (this.dropResponseOnce) { this.dropResponseOnce = false; throw new TypeError('fetch failed'); }
        return this._json({ results });
      } finally { this.pushInFlight -= 1; }
    }
    if (url.endsWith('/auth/refresh/')) return this._json(this.refreshBody, this.refreshStatus);
    if (url.includes('/sync/pull/')) {
      this.pullCount += 1; this.pullInFlight += 1; this.maxPullInFlight = Math.max(this.maxPullInFlight, this.pullInFlight);
      try { if (this.pullDelayMs) await sleep(this.pullDelayMs); return this._json(this.pullBody); }
      finally { this.pullInFlight -= 1; }
    }
    if (url.endsWith('/sync/reconcile/')) return this._json({ counts: {} });
    return this._json({});
  }
}

// Wait for a push to finish regardless of whether pushNow() returns a promise (old code did not).
async function settlePush(engine) {
  await engine.pushNow();
  await sleep(120);
}

module.exports = { dbm, makeDb, login, stockOf, seedProduct, markCatalogSynced, sellLocally, seedQueue, queueCount, FakeCloud, settlePush, sleep };
