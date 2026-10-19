// Day report and seller-only visibility on the till.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { dbm, makeDb, seedProduct } = require('./helpers');

function withDb(body) { const { db, cleanup } = makeDb(); try { return body(db); } finally { cleanup(); } }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const sell = (db, owner, qty, price = 100) => dbm.createSale(db)({
  cart_owner: owner, staff_name: owner,
  items: [{ product_id: null, item_name: 'Bread', quantity: qty, unit_price: price }], amount_paid: qty * price,
});

test('a sale records who rang it up, and a seller lists only their own', () => withDb((db) => {
  sell(db, 'ada', 1); sell(db, 'ada', 2); sell(db, 'tunde', 1);
  assert.equal(dbm.listSales(db, { seller: 'ada' }).length, 2);
  assert.equal(dbm.listSales(db, { seller: 'tunde' }).length, 1);
  assert.equal(dbm.listSales(db).length, 3, 'owners see everything');
}));

test("the everyone report covers every seller; a seller's covers only their own", () => withDb((db) => {
  dbm.openShift(db, 'ada', 500);
  sell(db, 'ada', 2);                                                     // 200 cash in ada's shift
  dbm.addCashMovement(db, 'ada', { kind: 'paid_out', amount: 50, reason: 'Fuel' });
  sell(db, 'tunde', 3);                                                   // 300, no shift
  const { product } = seedProduct(db, { qty: 5 });
  dbm.setSetting(db, 'user_profile', JSON.stringify({ username: 'tunde' }));
  dbm.recordDamage(db, { product_id: product.id, quantity: 1, reason: 'Crushed' });

  const all = dbm.getDayReport(db, { date: today() });
  assert.equal(all.sales.count, 2);
  assert.equal(all.sales.gross, 500);
  assert.equal(all.payments.total, 500);
  assert.equal(all.cash.paid_out, 50);
  assert.deepEqual(all.by_seller.map((s) => [s.seller, s.total]), [['tunde', 300], ['ada', 200]]);
  assert.equal(all.stock_changes.length, 1);
  assert.notEqual(all.sales.profit, null);
  assert.ok(all.sellers.includes('ada') && all.sellers.includes('tunde'));

  const ada = dbm.getDayReport(db, { date: today(), seller: 'ada' });
  assert.equal(ada.sales.count, 1);
  assert.equal(ada.payments.total, 200);
  assert.equal(ada.cash.paid_out, 50);
  assert.equal(ada.shifts.length, 1);
  assert.equal(ada.stock_changes.length, 0, "tunde's write-off is not on ada's report");
  assert.equal(ada.by_seller, null);
  assert.equal(ada.sales.profit, null, 'profit is only on the everyone report');

  const tunde = dbm.getDayReport(db, { date: today(), seller: 'tunde' });
  assert.equal(tunde.cash.movements.length, 0);
  assert.equal(tunde.stock_changes.length, 1);
}));

test('a different day is empty and a bad date is refused', () => withDb((db) => {
  sell(db, 'ada', 1);
  assert.equal(dbm.getDayReport(db, { date: '2001-01-01' }).sales.count, 0);
  assert.throws(() => dbm.getDayReport(db, { date: 'yesterday' }), /Pick a day/);
}));

test('the cashier sees each cash in/out on the open shift', () => withDb((db) => {
  const shift = dbm.openShift(db, 'ada', 100);
  dbm.addCashMovement(db, 'ada', { kind: 'paid_in', amount: 20, reason: 'Top-up' });
  const report = dbm.getShiftReport(db, shift.id);
  assert.deepEqual(report.cash_movements.map((c) => [c.kind, c.amount, c.reason]), [['paid_in', 20, 'Top-up']]);
}));

test('an older database gains sales.seller, filled from the shift that sale was made in', () => {
  const { db, dir, cleanup } = makeDb();
  try {
    dbm.openShift(db, 'ada', 0);
    const sale = sell(db, 'ada', 1);
    const loose = sell(db, '', 1);
    db.exec('ALTER TABLE sales DROP COLUMN seller');
    db.close();
    const reopened = dbm.openDb(path.join(dir, 'pos.db'));
    try {
      assert.equal(reopened.prepare(`SELECT seller FROM sales WHERE id = ?`).get(sale.id).seller, 'ada');
      assert.equal(reopened.prepare(`SELECT seller FROM sales WHERE id = ?`).get(loose.id).seller, null);
    } finally { reopened.close(); }
  } finally { cleanup(); }
});

test('a pulled sale keeps who sold it', () => withDb((db) => {
  const id = dbm.uuid();
  dbm.applyPulledOperation(db, 'sale', 'update', { id, seller_username: 'kemi', status: 'completed', date: new Date().toISOString(), payments: [] });
  assert.equal(db.prepare(`SELECT seller FROM sales WHERE id = ?`).get(id).seller, 'kemi');
}));
