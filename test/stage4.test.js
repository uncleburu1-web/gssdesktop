// Stage 4: the stock ledger on the till — damage (anyone, with a reason), stock counts (owners;
// enforced in main.js and by the cloud), and movements recorded elsewhere applied exactly once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, login, stockOf, seedProduct, FakeCloud, sleep } = require('./helpers');
const { startSyncEngine } = require('../src/main/sync');

const queued = (db, type) => db.prepare(`SELECT * FROM sync_queue WHERE entity_type = ? ORDER BY rowid`).all(type);
function withDb(body) { const { db, cleanup } = makeDb(); try { return body(db); } finally { cleanup(); } }
const v4 = (db) => dbm.setSetting(db, 'cloud_sync_protocol', '4');
const actAs = (db, username) => dbm.setSetting(db, 'user_profile', JSON.stringify({ username, is_owner: false }));

test('damage takes stock off now, records who and why, and queues ONE document', () => withDb((db) => {
  v4(db); actAs(db, 'sade');
  const { product } = seedProduct(db, { qty: 10 });
  dbm.addStockBatch(db, { product_id: product.id, quantity_received: 5 });
  dbm.recordDamage(db, { product_id: product.id, quantity: 12, reason: 'Shelf collapsed' });

  assert.equal(stockOf(db, product.id), 3);
  const rows = dbm.listStockMovements(db, { productId: product.id });
  assert.equal(rows.length, 2, 'one ledger row per batch touched');
  assert.equal(rows.reduce((s, r) => s + r.quantity, 0), -12);
  assert.ok(rows.every((r) => r.actor === 'sade' && r.reason === 'Shelf collapsed' && r.kind === 'damage'));
  const docs = queued(db, 'stock_movement');
  assert.equal(docs.length, 1);
  const payload = JSON.parse(docs[0].payload);
  assert.equal(payload.kind, 'damage');
  assert.equal(payload.quantity, 12);
  assert.equal(payload.product_id, product.id);
  assert.equal(docs[0].entity_id, payload.id);
}));

test('damage needs a reason, a whole number, and cannot exceed stock — and a refusal changes nothing', () => withDb((db) => {
  v4(db);
  const { product } = seedProduct(db, { qty: 4 });
  assert.throws(() => dbm.recordDamage(db, { product_id: product.id, quantity: 1, reason: '  ' }), /reason/);
  assert.throws(() => dbm.recordDamage(db, { product_id: product.id, quantity: 1.5, reason: 'x' }), /whole/);
  assert.throws(() => dbm.recordDamage(db, { product_id: product.id, quantity: 5, reason: 'x' }), /Only 4/);
  assert.equal(stockOf(db, product.id), 4);
  assert.equal(queued(db, 'stock_movement').length, 0);
  assert.equal(dbm.listStockMovements(db).length, 0);
}));

test('a stock count records the system and counted figures, both directions', () => withDb((db) => {
  v4(db);
  const { product } = seedProduct(db, { qty: 10 });
  dbm.recordStockCount(db, { product_id: product.id, counted_quantity: 7, reason: 'Month end' });
  assert.equal(stockOf(db, product.id), 7);
  dbm.recordStockCount(db, { product_id: product.id, counted_quantity: 9, reason: 'Found two' });
  assert.equal(stockOf(db, product.id), 9);
  const docs = queued(db, 'stock_movement').map((r) => JSON.parse(r.payload));
  assert.deepEqual(docs.map((d) => [d.kind, d.system_quantity, d.counted_quantity]), [['adjustment', 10, 7], ['adjustment', 7, 9]]);
  assert.equal(dbm.recordStockCount(db, { product_id: product.id, counted_quantity: 9, reason: 'same' }).unchanged, true);
  assert.equal(queued(db, 'stock_movement').length, 2, 'a matching count queues nothing');
}));

test('a count on a product with no stock batch creates one locally', () => withDb((db) => {
  v4(db);
  const { product } = seedProduct(db, { qty: 0 });
  dbm.recordStockCount(db, { product_id: product.id, counted_quantity: 6, reason: 'Opening count' });
  assert.equal(stockOf(db, product.id), 6);
}));

test('a damage or count pulled from the cloud is applied once; our own coming back is not applied again', () => withDb((db) => {
  v4(db);
  const { product, batch } = seedProduct(db, { qty: 10 });
  const own = dbm.recordDamage(db, { product_id: product.id, quantity: 2, reason: 'mine' });
  assert.equal(stockOf(db, product.id), 8);

  const fromWeb = { id: dbm.uuid(), kind: 'damage', product_id: product.id, batch_id: batch.id, quantity: '-3.000', reason: 'web', client_ref: null };
  dbm.applyPulledOperation(db, 'stock_movement', 'update', fromWeb);
  dbm.applyPulledOperation(db, 'stock_movement', 'update', fromWeb);        // overlap re-delivery
  assert.equal(stockOf(db, product.id), 5);

  const echo = { id: dbm.uuid(), kind: 'damage', product_id: product.id, batch_id: batch.id, quantity: '-2.000', reason: 'mine', client_ref: own.id };
  dbm.applyPulledOperation(db, 'stock_movement', 'update', echo);
  assert.equal(stockOf(db, product.id), 5, "the cloud's copy of our own write-off is not taken twice");

  const part = { id: dbm.uuid(), kind: 'repair_part_return', product_id: product.id, batch_id: batch.id, quantity: '1.000', reason: '' };
  dbm.applyPulledOperation(db, 'stock_movement', 'update', part);
  assert.equal(stockOf(db, product.id), 6);
}));

test('protocol 3 cloud: damage still works offline-first and goes up once the cloud reaches 4', async () => {
  const { db, cleanup } = makeDb();
  const cloud = new FakeCloud().install();
  login(db);
  try {
    dbm.setSetting(db, 'cloud_sync_protocol', '3');
    const { product } = seedProduct(db, { qty: 5 });
    dbm.recordDamage(db, { product_id: product.id, quantity: 1, reason: 'cracked' });
    assert.equal(stockOf(db, product.id), 4);
    assert.equal(queued(db, 'stock_movement').length, 0, 'never sent to a cloud that cannot apply it');

    cloud.pullBody = { operations: [], server_time: new Date().toISOString(), sync_protocol: 4 };
    const engine = startSyncEngine(db, () => {});
    await sleep(200); await engine.pushNow(); await sleep(100); engine.stop();
    assert.equal(queued(db, 'stock_movement').length, 1);
    assert.ok(db.prepare(`SELECT synced_at FROM stock_docs`).get().synced_at, 'acknowledged');
    assert.ok(cloud.requests.some((r) => r.url.includes('entity_types=stock_movement')), 'one-off backfill of movements');
    assert.ok(dbm.getSetting(db, 'stock_movements_backfilled'));
  } finally { cleanup(); await sleep(10); }
});
