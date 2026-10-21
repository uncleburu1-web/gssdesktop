// Stage 8: customer returns on the till — offline-first, same rules as the cloud.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, stockOf, seedProduct } = require('./helpers');

function withDb(body) { const { db, cleanup } = makeDb(); try { return body(db); } finally { cleanup(); } }
const queued = (db, type) => db.prepare(`SELECT * FROM sync_queue WHERE entity_type = ?`).all(type);

function setup(db, { protocol = '5' } = {}) {
  dbm.setSetting(db, 'cloud_sync_protocol', protocol);
  dbm.setSetting(db, 'user_profile', JSON.stringify({ username: 'boss' }));
  const { product } = seedProduct(db, { qty: 20 });
  const sale = dbm.createSale(db)({
    cart_owner: 'boss', items: [{ product_id: product.id, item_name: 'Juice', quantity: 5, unit_price: 1000, discount: 500 }],
    amount_paid: 4500,
  });
  return { product, sale, line: sale.items[0] };
}

test('a return puts stock back, refunds the discounted value and queues one document', () => withDb((db) => {
  const { product, sale, line } = setup(db);
  assert.equal(stockOf(db, product.id), 15);
  const r = dbm.createReturn(db, { sale_id: sale.id, lines: [{ sale_item_id: line.id, quantity: 2 }], reason: 'Wrong flavour' }, 'boss');
  assert.equal(r.refund_amount, 1800);
  assert.equal(stockOf(db, product.id), 17);
  assert.equal(r.sale.returned_quantities[line.id], 2);
  const [doc] = queued(db, 'sale_return');
  const payload = JSON.parse(doc.payload);
  assert.equal(doc.entity_id, r.id);
  assert.deepEqual(payload.lines, [{ sale_item_id: line.id, quantity: 2, restock: true }]);
  assert.equal(payload.reason, 'Wrong flavour');
}));

test('damaged items are written off, and nothing can be returned twice', () => withDb((db) => {
  const { product, sale, line } = setup(db);
  dbm.createReturn(db, { sale_id: sale.id, lines: [{ sale_item_id: line.id, quantity: 4, restock: false }], reason: 'Burst' }, 'boss');
  assert.equal(stockOf(db, product.id), 15, 'damaged: not back in stock');
  assert.throws(() => dbm.createReturn(db, { sale_id: sale.id, lines: [{ sale_item_id: line.id, quantity: 2 }], reason: 'x' }, 'boss'), /Only 1/);
  assert.throws(() => dbm.deleteSale(db)(sale.id), /returns recorded/);
}));

test('reason, whole units and a refund within the value are required', () => withDb((db) => {
  const { sale, line } = setup(db);
  const go = (extra) => () => dbm.createReturn(db, { sale_id: sale.id, lines: [{ sale_item_id: line.id, quantity: 1 }], reason: 'ok', ...extra }, 'boss');
  assert.throws(go({ reason: ' ' }), /reason/);
  assert.throws(go({ lines: [{ sale_item_id: line.id, quantity: 1.5 }] }), /whole number/);
  assert.throws(go({ refund_amount: 2000 }), /at most 900/);
  assert.equal(queued(db, 'sale_return').length, 0);
}));

test('cash refunds come out of the expected drawer; the Z and day reports show them', () => withDb((db) => {
  dbm.setSetting(db, 'cloud_sync_protocol', '5');
  dbm.setSetting(db, 'user_profile', JSON.stringify({ username: 'boss' }));
  const shift = dbm.openShift(db, 'boss', 1000);
  const { product } = seedProduct(db, { qty: 9 });
  const sale = dbm.createSale(db)({ cart_owner: 'boss', items: [{ product_id: product.id, item_name: 'Tea', quantity: 2, unit_price: 500 }], amount_paid: 1000 });
  dbm.createReturn(db, { sale_id: sale.id, lines: [{ sale_item_id: sale.items[0].id, quantity: 1 }], reason: 'Changed mind' }, 'boss');
  const z = dbm.getShiftReport(db, shift.id);
  assert.equal(z.refunds.total, 500);
  assert.equal(z.cash.expected, 1000 + 1000 - 500);
  const d = new Date();
  const day = dbm.getDayReport(db, { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` });
  assert.equal(day.returns.count, 1);
  assert.equal(day.returns.by_method.cash, 500);
}));

test('older cloud: the return works offline and goes up once the cloud reaches protocol 5', () => withDb((db) => {
  const { sale, line } = setup(db, { protocol: '4' });
  const r = dbm.createReturn(db, { sale_id: sale.id, lines: [{ sale_item_id: line.id, quantity: 1 }], reason: 'x' }, 'boss');
  assert.equal(queued(db, 'sale_return').length, 0);
  dbm.setSetting(db, 'cloud_sync_protocol', '5');
  assert.ok(dbm.reconcileUnsyncedRows(db) >= 1);
  const [doc] = queued(db, 'sale_return');
  assert.equal(JSON.parse(doc.payload).lines.length, 1, 'reconciled with its lines, not the bare row');
  assert.equal(doc.entity_id, r.id);
}));

test("the cloud's copy of our own return is not applied again; a web return is", () => withDb((db) => {
  const { product, sale, line } = setup(db);
  const r = dbm.createReturn(db, { sale_id: sale.id, lines: [{ sale_item_id: line.id, quantity: 1 }], reason: 'x' }, 'boss');
  const batch = db.prepare(`SELECT id FROM stock_batches WHERE product_id = ?`).get(product.id);
  dbm.applyPulledOperation(db, 'stock_movement', 'update', { id: dbm.uuid(), kind: 'return', product_id: product.id, batch_id: batch.id, quantity: '1.000', client_ref: r.id });
  assert.equal(stockOf(db, product.id), 16);
  dbm.applyPulledOperation(db, 'stock_movement', 'update', { id: dbm.uuid(), kind: 'return', product_id: product.id, batch_id: batch.id, quantity: '2.000', client_ref: dbm.uuid() });
  assert.equal(stockOf(db, product.id), 18);
}));
