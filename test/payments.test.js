const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { dbm, makeDb, seedProduct, stockOf } = require('./helpers');

const DEVICE = 'abcdef12-3456-7890-abcd-ef1234567890';
const line = (productId, qty = 1, price = 100) => ({ product_id: productId, item_name: 'Cola', quantity: qty, unit_price: price });
const sell = (db, input) => dbm.createSale(db)({ cart_owner: 'alice', ...input });
const payRows = (db, saleId) => db.prepare(`SELECT * FROM sale_payments WHERE sale_id = ? AND is_deleted = 0 ORDER BY rowid`).all(saleId);

// ---------------------------------------------------------------- receipt numbers
test('every sale gets a receipt number: <till code>-<6-digit counter>, unique per till by construction', () => {
  const { db, cleanup } = makeDb();
  try {
    dbm.setSetting(db, 'device_id', DEVICE);
    const { product } = seedProduct(db);
    const a = sell(db, { items: [line(product.id)] });
    const b = sell(db, { items: [line(product.id)] });
    assert.equal(a.receipt_no, 'ABCDEF-000001');
    assert.equal(b.receipt_no, 'ABCDEF-000002');
    assert.equal(a.invoice_number + 1, b.invoice_number, 'the familiar invoice number keeps counting as before');
  } finally { cleanup(); }
});

test('two tills can never print the same receipt number', () => {
  const one = makeDb(); const two = makeDb();
  try {
    dbm.setSetting(one.db, 'device_id', DEVICE);
    dbm.setSetting(two.db, 'device_id', '0f9e8d7c-1111-2222-3333-444455556666');
    const p1 = seedProduct(one.db).product; const p2 = seedProduct(two.db).product;
    const r1 = sell(one.db, { items: [line(p1.id)] }).receipt_no;
    const r2 = sell(two.db, { items: [line(p2.id)] }).receipt_no;     // both are each till's FIRST sale
    assert.notEqual(r1, r2);
  } finally { one.cleanup(); two.cleanup(); }
});

test('the database itself refuses a duplicate receipt number', () => {
  const { db, cleanup } = makeDb();
  try {
    dbm.setSetting(db, 'device_id', DEVICE);
    const { product } = seedProduct(db);
    const a = sell(db, { items: [line(product.id)] });
    const b = sell(db, { items: [line(product.id)] });
    assert.throws(() => db.prepare(`UPDATE sales SET receipt_no = ? WHERE id = ?`).run(a.receipt_no, b.id), /UNIQUE/);
    // ...while sales that predate receipt numbers (NULL) never collide with each other
    db.prepare(`UPDATE sales SET receipt_no = NULL WHERE id IN (?, ?)`).run(a.id, b.id);
  } finally { cleanup(); }
});

test('receipt numbers travel in the sale that is uploaded', () => {
  const { db, cleanup } = makeDb();
  try {
    dbm.setSetting(db, 'device_id', DEVICE);
    const { product } = seedProduct(db);
    const sale = sell(db, { items: [line(product.id)] });
    const op = db.prepare(`SELECT payload FROM sync_queue WHERE entity_type = 'sale' AND entity_id = ?`).get(sale.id);
    assert.equal(JSON.parse(op.payload).receipt_no, 'ABCDEF-000001');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- single payment (unchanged behaviour)
test('a normal single-method sale still works exactly as before, and records one payment', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    const sale = sell(db, { payment_method: 'pos', items: [line(product.id, 3, 100)] });
    assert.equal(sale.total, 300); assert.equal(sale.amount_paid, 300);
    assert.equal(sale.payment_method, 'pos'); assert.equal(sale.status, 'completed');
    assert.equal(sale.payments.length, 1);
    assert.deepEqual([sale.payments[0].method, sale.payments[0].amount], ['pos', 300]);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- split tender
test('SPLIT: N100,000-style sale paid by cash + transfer + card is recorded as three payments that add up', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db, { qty: 100 });
    const sale = sell(db, {
      items: [line(product.id, 10, 100)],                                     // total 1,000
      payments: [
        { method: 'cash', amount: 300, tendered: 500 },                       // customer hands over 500, gets 200 back
        { method: 'transfer', amount: 500, reference: 'TRF-88213' },
        { method: 'pos', amount: 200, reference: '4417' },
      ],
    });
    assert.equal(sale.total, 1000); assert.equal(sale.amount_paid, 1000); assert.equal(sale.status, 'completed');
    assert.equal(sale.payment_method, 'transfer', 'legacy field = the method that paid the most, so older reports keep working');
    assert.deepEqual(sale.payments.map((p) => [p.method, p.amount]), [['cash', 300], ['transfer', 500], ['pos', 200]]);
    const cash = sale.payments.find((p) => p.method === 'cash');
    assert.equal(cash.tendered, 500); assert.equal(cash.change_given, 200);
    assert.equal(sale.payments.find((p) => p.method === 'transfer').reference, 'TRF-88213');
    assert.equal(stockOf(db, product.id), 90);
  } finally { cleanup(); }
});

test('SPLIT: payments that do not add up to the total are refused, and NOTHING is left behind', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db, { qty: 50 });
    const before = db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n;
    for (const payments of [
      [{ method: 'cash', amount: 300 }, { method: 'transfer', amount: 600 }],     // short by 100
      [{ method: 'cash', amount: 700 }, { method: 'transfer', amount: 400 }],     // over by 100
    ]) {
      assert.throws(() => sell(db, { items: [line(product.id, 10, 100)], payments }), /add up/i);
    }
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sales`).get().n, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sale_payments`).get().n, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n, before);
    assert.equal(stockOf(db, product.id), 50, 'stock must be untouched by a refused sale');
  } finally { cleanup(); }
});

test('SPLIT: nonsense payment lines are refused', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    const bad = [
      [{ method: 'bitcoin', amount: 100 }],
      [{ method: 'cash', amount: 0 }, { method: 'pos', amount: 100 }],
      [{ method: 'cash', amount: -50 }, { method: 'pos', amount: 150 }],
      [{ method: 'cash', amount: 'abc' }],
      [{ method: 'cash', amount: 100, tendered: 50 }],                            // handed over less than applied
    ];
    for (const payments of bad) assert.throws(() => sell(db, { items: [line(product.id)], payments }), undefined, JSON.stringify(payments));
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sales`).get().n, 0);
  } finally { cleanup(); }
});

test('amounts are kept to the kobo: 0.1 + 0.2 style float dust never breaks "adds up"', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    const sale = sell(db, { items: [{ ...line(product.id, 1, 0.3) }], payments: [{ method: 'cash', amount: 0.1 }, { method: 'pos', amount: 0.2 }] });
    assert.equal(sale.amount_paid, 0.3);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- installments
test('installment: a deposit is one payment; later payments (any method) are recorded one by one and capped at what is owed', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    const sale = sell(db, { status: 'outstanding', amount_paid: 300, payment_method: 'cash', customer_name: 'Ada', items: [line(product.id, 10, 100)] });
    assert.equal(sale.status, 'outstanding'); assert.equal(sale.payments.length, 1);

    const second = dbm.addPayment(db)(sale.id, 200, { method: 'transfer', reference: 'TRF-1', owner: 'alice' });
    assert.equal(second.amount_paid, 500); assert.equal(second.status, 'outstanding');
    assert.deepEqual(second.payments.map((p) => [p.method, p.amount]), [['cash', 300], ['transfer', 200]]);

    const last = dbm.addPayment(db)(sale.id, 9999, { method: 'cash', owner: 'alice' });   // pays more than is owed
    assert.equal(last.amount_paid, 1000); assert.equal(last.status, 'completed');
    assert.equal(last.payments.at(-1).amount, 500, 'the payment row records what was APPLIED (500), not what was offered (9999)');
  } finally { cleanup(); }
});

test('paying a sale that owes nothing, or with a bad method, is refused', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    const paidUp = sell(db, { items: [line(product.id)] });
    assert.throws(() => dbm.addPayment(db)(paidUp.id, 50, {}), /nothing/i);
    const owing = sell(db, { status: 'outstanding', amount_paid: 10, items: [line(product.id, 5, 100)] });
    assert.throws(() => dbm.addPayment(db)(owing.id, 50, { method: 'bitcoin' }), /method/i);
    assert.throws(() => dbm.addPayment(db)(owing.id, 0, {}), /amount/i);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- migration of existing data
test('sales that existed BEFORE payments existed get a payment row on upgrade (once, never twice)', () => {
  const { db, dir, cleanup } = makeDb();
  const file = path.join(dir, 'pos.db');
  try {
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO sales (id, invoice_number, customer_name, staff_name, payment_method, status, amount_paid, date, created_at, updated_at, is_deleted) VALUES ('old1', 7, 'Walk-in', '', 'transfer', 'completed', 700, ?, ?, ?, 0)`).run(ts, ts, ts);
    db.prepare(`INSERT INTO sales (id, invoice_number, customer_name, staff_name, payment_method, status, amount_paid, date, created_at, updated_at, is_deleted) VALUES ('old2', 8, 'Walk-in', '', 'cash', 'outstanding', 0, ?, ?, ?, 0)`).run(ts, ts, ts);
    db.close();
    for (let i = 0; i < 2; i += 1) {                                   // reopen twice: idempotent
      const again = dbm.openDb(file);
      assert.deepEqual(payRows(again, 'old1').map((p) => [p.method, p.amount]), [['transfer', 700]]);
      assert.equal(payRows(again, 'old2').length, 0, 'nothing was paid, so nothing is invented');
      again.close();
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('payments are part of the uploaded sale; they are NOT uploaded as a separate kind of record the cloud has never heard of', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    sell(db, { items: [line(product.id, 2, 100)], payments: [{ method: 'cash', amount: 100 }, { method: 'pos', amount: 100 }] });
    const kinds = db.prepare(`SELECT DISTINCT entity_type FROM sync_queue`).all().map((r) => r.entity_type).sort();
    assert.ok(!kinds.includes('sale_payment'), kinds.join(','));
    const op = JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE entity_type = 'sale'`).get().payload);
    assert.equal(op.payments.length, 2);
  } finally { cleanup(); }
});
