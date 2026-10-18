// Stage 2 regression tests (architecture analysis G1, G2).
//   G1  on a protocol-2 cloud a sale is queued as ONE 'sale_doc' row (header + lines + payments)
//   G2  an installment is queued as an append-only 'sale_payment'; pulled payments merge by id
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, login, FakeCloud, sleep, seedProduct, markCatalogSynced, sellLocally } = require('./helpers');
const { startSyncEngine } = require('../src/main/sync');

const queued = (db) => db.prepare(`SELECT entity_type, entity_id, operation, payload FROM sync_queue WHERE entity_type NOT IN ('product','stock_batch') ORDER BY rowid`).all();
const useProtocol = (db, n) => dbm.setSetting(db, 'cloud_sync_protocol', String(n));
const paymentsOf = (db, saleId) => db.prepare(`SELECT * FROM sale_payments WHERE sale_id = ? AND is_deleted = 0 ORDER BY rowid`).all(saleId);

function withDb(body) {
  const { db, cleanup } = makeDb();
  try { return body(db); } finally { cleanup(); }
}

function installmentSale(db, product, deposit = 200) {
  return dbm.createSale(db)({
    items: [{ product_id: product.id, item_name: 'Cola', quantity: 10, unit_price: 100 }],   // total 1000
    status: 'outstanding', amount_paid: deposit, payment_method: 'cash',
  });
}

test('protocol 1 (an older cloud): a sale still queues as header + one row per line, exactly as before', () => withDb((db) => {
  const { product } = seedProduct(db); markCatalogSynced(db);
  dbm.createSale(db)({ items: [
    { product_id: product.id, item_name: 'Cola', quantity: 1, unit_price: 100 },
    { product_id: product.id, item_name: 'Cola', quantity: 2, unit_price: 100 },
  ] });
  assert.deepEqual(queued(db).map((r) => r.entity_type), ['sale', 'sale_item', 'sale_item']);
}));

test('G1: on protocol 2 a sale is ONE outbox row carrying its lines and payments', () => withDb((db) => {
  const { product } = seedProduct(db); markCatalogSynced(db); useProtocol(db, 2);
  const sale = dbm.createSale(db)({
    items: [{ product_id: product.id, item_name: 'Cola', quantity: 3, unit_price: 100 }],
    payments: [{ method: 'cash', amount: 100, tendered: 200 }, { method: 'transfer', amount: 200, reference: 'GTB-9' }],
  });
  const rows = queued(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_type, 'sale_doc');
  assert.equal(rows[0].entity_id, sale.id);
  const doc = JSON.parse(rows[0].payload);
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].quantity, 3);
  assert.deepEqual(doc.payments.map((p) => [p.method, p.amount]), [['cash', 100], ['transfer', 200]]);
  assert.equal(doc.payments[0].change_given, 100);
  assert.ok(doc.receipt_no, 'the receipt number travels with it');
}));

test('G1: a failed sale queues NOTHING (the outbox row is inside the sale\'s own transaction)', () => withDb((db) => {
  const { product } = seedProduct(db); markCatalogSynced(db); useProtocol(db, 2);
  assert.throws(() => dbm.createSale(db)({
    items: [{ product_id: product.id, item_name: 'Cola', quantity: 1, unit_price: 100 }],
    payments: [{ method: 'cash', amount: 50 }],                       // does not add up
  }));
  assert.equal(queued(db).length, 0);
}));

test('G2: on protocol 2 an installment is an append-only sale_payment, not a sale overwrite', () => withDb((db) => {
  const { product } = seedProduct(db); markCatalogSynced(db); useProtocol(db, 2);
  const sale = installmentSale(db, product);
  db.prepare(`DELETE FROM sync_queue`).run();
  dbm.addPayment(db)(sale.id, 300, { method: 'transfer' });
  const rows = queued(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_type, 'sale_payment');
  const p = JSON.parse(rows[0].payload);
  assert.equal(p.sale_id, sale.id);
  assert.equal(p.amount, 300);
  assert.equal(p.method, 'transfer');
  assert.equal(rows[0].entity_id, p.id);
}));

test('G2: a pulled web payment is ADDED to a till sale, and completes it when it covers the balance', () => withDb((db) => {
  const { product } = seedProduct(db); markCatalogSynced(db); useProtocol(db, 2);
  const sale = installmentSale(db, product, 200);
  const own = paymentsOf(db, sale.id)[0];
  dbm.applyPulledOperation(db, 'sale', 'update', {
    id: sale.id, customer_name: 'Walk-in', payment_method: 'cash', status: 'completed', amount_paid: '1000.00', invoice_number: sale.invoice_number,
    payments: [
      { id: own.id, method: 'cash', amount: '200.00', source: 'till' },
      { id: 'web-pay-1', method: 'pos', amount: '800.00', source: 'web' },
    ],
  });
  const after = dbm.getSale(db, sale.id);
  assert.equal(after.amount_paid, 1000);
  assert.equal(after.status, 'completed');
  assert.equal(paymentsOf(db, sale.id).length, 2, 'own payment not duplicated');
}));

test('G2: a local payment not uploaded yet survives a pull that does not know about it', () => withDb((db) => {
  const { product } = seedProduct(db); markCatalogSynced(db); useProtocol(db, 2);
  const sale = installmentSale(db, product, 200);
  const deposit = paymentsOf(db, sale.id)[0];
  dbm.addPayment(db)(sale.id, 300, { method: 'cash' });             // still waiting in the outbox
  dbm.applyPulledOperation(db, 'sale', 'update', {
    id: sale.id, status: 'outstanding', amount_paid: '200.00', invoice_number: sale.invoice_number,
    payments: [{ id: deposit.id, method: 'cash', amount: '200.00', source: 'till' }],
  });
  assert.equal(dbm.getSale(db, sale.id).amount_paid, 500, 'before stage 2 the pull wrote 200 back over it');
}));

test('a legacy cloud lump is NOT added on top of this till\'s own itemised payments', () => withDb((db) => {
  const { product } = seedProduct(db); markCatalogSynced(db); useProtocol(db, 2);
  const sale = sellLocally(db, product.id, 3);                       // 300, one local payment
  dbm.applyPulledOperation(db, 'sale', 'update', {
    id: sale.id, status: 'completed', amount_paid: '300.00', invoice_number: sale.invoice_number,
    payments: [{ id: 'legacy-lump', method: 'cash', amount: '300.00', source: 'legacy' }],
  });
  assert.equal(dbm.getSale(db, sale.id).amount_paid, 300);
  assert.equal(paymentsOf(db, sale.id).length, 1);
}));

test('a sale from another till arrives with its payments (a legacy lump included)', () => withDb((db) => {
  const saleId = dbm.uuid();
  dbm.applyPulledOperation(db, 'sale', 'create', {
    id: saleId, customer_name: 'Other till', status: 'outstanding', amount_paid: '700.00', date: new Date().toISOString(),
    payments: [
      { id: 'lump', method: 'cash', amount: '400.00', source: 'legacy' },
      { id: 'web-2', method: 'transfer', amount: '300.00', source: 'web' },
    ],
  });
  assert.equal(dbm.getSale(db, saleId).amount_paid, 700);
  assert.deepEqual(paymentsOf(db, saleId).map((p) => p.method).sort(), ['cash', 'transfer']);
}));

test('an older cloud (no payments in the pull) behaves exactly as before', () => withDb((db) => {
  const saleId = dbm.uuid();
  dbm.applyPulledOperation(db, 'sale', 'create', {
    id: saleId, customer_name: 'Old cloud', status: 'completed', amount_paid: 250, date: new Date().toISOString(),
  });
  assert.equal(dbm.getSale(db, saleId).amount_paid, 250);
}));

test('the engine switches to protocol 2 only after the cloud announces it', async () => {
  const { db, cleanup } = makeDb();
  const cloud = new FakeCloud().install();
  login(db);
  cloud.pullBody = { operations: [], server_time: new Date().toISOString() };          // an older cloud
  const engine = startSyncEngine(db, () => {});
  try {
    await engine.pullNow(); await sleep(50);
    assert.equal(dbm.cloudSyncProtocol(db), 1);
    cloud.pullBody = { operations: [], server_time: new Date().toISOString(), sync_protocol: 2 };
    await engine.pullNow(); await sleep(50);
    assert.equal(dbm.cloudSyncProtocol(db), 2);
  } finally { engine.stop(); cleanup(); await sleep(10); }
});

// ---- the startup re-upload bug ----------------------------------------------------------------

const prunedHistory = (db) => {
  db.prepare(`UPDATE sync_queue SET status = 'synced', client_timestamp = ?`).run(new Date(Date.now() - 2 * 86400e3).toISOString());
  dbm.pruneSyncQueue(db);
};

test('a sale the cloud confirmed is NOT re-uploaded at the next startup after its outbox row is pruned', async () => {
  const { db, cleanup } = makeDb();
  const cloud = new FakeCloud().install();
  login(db);
  try {
    const { product } = seedProduct(db);
    sellLocally(db, product.id, 1);
    const engine = startSyncEngine(db, () => {});
    await engine.pushNow(); await sleep(100); engine.stop();
    assert.ok(db.prepare(`SELECT synced_at FROM sales`).get().synced_at, 'acknowledged -> synced_at stamped');
    prunedHistory(db);
    assert.equal(dbm.reconcileUnsyncedRows(db), 0, 'before this fix: 4 rows went up again at every startup');
  } finally { cleanup(); await sleep(10); }
});

test('rows pulled from the cloud are never pushed back by the startup reconcile', () => withDb((db) => {
  dbm.applyPulledOperation(db, 'product', 'update', { id: dbm.uuid(), name: 'Web product', sell_price: '5' });
  dbm.applyPulledOperation(db, 'customer', 'update', { id: dbm.uuid(), name: 'Web customer' });
  assert.equal(dbm.reconcileUnsyncedRows(db), 0);
}));

test('a sale waiting as a sale_doc is not queued a second time in the old format', () => withDb((db) => {
  const { product } = seedProduct(db); markCatalogSynced(db); useProtocol(db, 2);
  dbm.createSale(db)({ items: [{ product_id: product.id, item_name: 'Cola', quantity: 1, unit_price: 100 }] });
  db.prepare(`UPDATE products SET synced_at = 'x'`).run();
  db.prepare(`UPDATE stock_batches SET synced_at = 'x'`).run();
  assert.equal(dbm.reconcileUnsyncedRows(db), 0);
}));

test('a row created but NEVER queued is still found and queued (what the reconcile exists for)', () => withDb((db) => {
  const id = dbm.uuid(); const ts = new Date().toISOString();
  db.prepare(`INSERT INTO customers (id, name, created_at, updated_at, is_deleted) VALUES (?, 'Lost', ?, ?, 0)`).run(id, ts, ts);
  assert.equal(dbm.reconcileUnsyncedRows(db), 1);
}));

test('upgrading a till whose history was already pruned does not re-upload it even once', () => {
  const path = require('path');
  const { db, dir, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    sellLocally(db, product.id, 2);
    prunedHistory(db);                                                   // confirmed and pruned, synced_at never stamped (old code)
    db.prepare(`DELETE FROM app_settings WHERE key = 'synced_at_backfill_v1'`).run();
    db.prepare(`UPDATE sales SET synced_at = NULL`).run();
    db.close();
    const reopened = dbm.openDb(path.join(dir, 'pos.db'));               // the upgrade
    try { assert.equal(dbm.reconcileUnsyncedRows(reopened), 0); } finally { reopened.close(); }
  } finally { cleanup(); }
});
