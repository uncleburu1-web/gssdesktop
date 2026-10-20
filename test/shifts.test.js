const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, seedProduct } = require('./helpers');

const DEVICE = 'abcdef12-3456-7890-abcd-ef1234567890';
const line = (productId, qty = 1, price = 100) => ({ product_id: productId, item_name: 'Cola', quantity: qty, unit_price: price });
const sell = (db, input, owner = 'alice') => dbm.createSale(db)({ cart_owner: owner, ...input });
const setup = (qty = 500) => { const m = makeDb(); dbm.setSetting(m.db, 'device_id', DEVICE); return { ...m, product: seedProduct(m.db, { qty }).product }; };

test('a shift opens with a float; only one can be open per cashier, but cashiers are independent', () => {
  const { db, cleanup } = setup();
  try {
    const s = dbm.openShift(db, 'alice', 5000);
    assert.equal(s.status, 'open'); assert.equal(s.opening_float, 5000);
    assert.equal(dbm.getOpenShift(db, 'alice').id, s.id);
    assert.throws(() => dbm.openShift(db, 'alice', 100), /already/i);
    assert.ok(dbm.openShift(db, 'bob', 0));
    assert.equal(dbm.getOpenShift(db, 'carol'), null);
    assert.throws(() => dbm.openShift(db, 'carol', -1), /float/i);
    assert.throws(() => dbm.openShift(db, 'carol', 'abc'), /float/i);
  } finally { cleanup(); }
});

test('sales and their payments attach to the cashier\'s open shift; selling WITHOUT a shift still works', () => {
  const { db, product, cleanup } = setup();
  try {
    const noShift = sell(db, { items: [line(product.id)] });
    assert.equal(noShift.shift_id, null, 'never block a sale just because no shift is open');
    const shift = dbm.openShift(db, 'alice', 1000);
    const inShift = sell(db, { items: [line(product.id)] });
    assert.equal(inShift.shift_id, shift.id);
    assert.equal(inShift.payments[0].shift_id, shift.id);
    assert.equal(sell(db, { items: [line(product.id)] }, 'bob').shift_id, null, 'bob has no open shift of his own');
  } finally { cleanup(); }
});

test('CASH EXPECTED = float + cash taken - nothing for change given back + paid in - paid out; cards and transfers are not in the drawer', () => {
  const { db, product, cleanup } = setup();
  try {
    dbm.openShift(db, 'alice', 5000);
    sell(db, { items: [line(product.id, 10, 100)], payments: [{ method: 'cash', amount: 1000, tendered: 2000 }] });   // 1000 kept, 1000 change handed back
    sell(db, { items: [line(product.id, 10, 100)], payment_method: 'transfer' });                                    // 1000 by transfer
    sell(db, { items: [line(product.id, 10, 100)], payments: [{ method: 'cash', amount: 300, tendered: 500 }, { method: 'pos', amount: 700 }] });
    dbm.addCashMovement(db, 'alice', { kind: 'paid_in', amount: 400, reason: 'Owner top-up' });
    dbm.addCashMovement(db, 'alice', { kind: 'paid_out', amount: 150, reason: 'Bought sachet water' });

    const live = dbm.getShiftReport(db, dbm.getOpenShift(db, 'alice').id);
    assert.equal(live.cash.opening_float, 5000);
    assert.equal(live.cash.cash_sales, 1300);               // 1000 + 300: what stayed in the drawer
    assert.equal(live.cash.paid_in, 400); assert.equal(live.cash.paid_out, 150);
    assert.equal(live.cash.expected, 5000 + 1300 + 400 - 150);
    assert.deepEqual(live.payments.by_method, { cash: 1300, transfer: 1000, pos: 700, mobile: 0 });
    assert.equal(live.sales.count, 3); assert.equal(live.sales.gross, 3000);
  } finally { cleanup(); }
});

test('closing is a BLIND count: you hand over what you counted, and the variance is computed for you and recorded', () => {
  const { db, product, cleanup } = setup();
  try {
    dbm.openShift(db, 'alice', 1000);
    sell(db, { items: [line(product.id, 5, 100)], payment_method: 'cash' });          // expected 1500
    const z = dbm.closeShift(db, 'alice', { countedCash: 1450, notes: 'short 50' });
    assert.equal(z.cash.expected, 1500); assert.equal(z.cash.counted, 1450); assert.equal(z.cash.variance, -50);
    assert.equal(z.shift.z_number, 1); assert.ok(z.shift.closed_at);
    assert.equal(dbm.getOpenShift(db, 'alice'), null);
    dbm.openShift(db, 'bob', 0);
    for (const bad of [undefined, null, '', 'abc', -5, NaN]) {
      assert.throws(() => dbm.closeShift(db, 'bob', { countedCash: bad }), /count/i, String(bad));
    }
    assert.ok(dbm.getOpenShift(db, 'bob'), 'a refused close leaves the shift open');
    assert.throws(() => dbm.closeShift(db, 'nobody', { countedCash: 0 }), /no open shift/i);
  } finally { cleanup(); }
});

test('a closed Z-report is FROZEN: later changes to the data never rewrite it', () => {
  const { db, product, cleanup } = setup();
  try {
    const shift = dbm.openShift(db, 'alice', 0);
    const sale = sell(db, { items: [line(product.id, 2, 100)], payment_method: 'cash' });
    const closed = dbm.closeShift(db, 'alice', { countedCash: 200 });
    dbm.deleteSale(db)(sale.id);                                                   // deleted AFTER the shift was closed
    const again = dbm.getShiftReport(db, shift.id);
    assert.deepEqual(again, closed);
    assert.equal(again.sales.count, 1); assert.equal(again.cash.expected, 200);
  } finally { cleanup(); }
});

test('a sale made after closing does not attach to the closed shift; the next shift starts clean with a new Z number', () => {
  const { db, product, cleanup } = setup();
  try {
    dbm.openShift(db, 'alice', 0); dbm.closeShift(db, 'alice', { countedCash: 0 });
    assert.equal(sell(db, { items: [line(product.id)] }).shift_id, null);
    const second = dbm.openShift(db, 'alice', 0);
    sell(db, { items: [line(product.id, 2, 100)] });
    const z = dbm.closeShift(db, 'alice', { countedCash: 200 });
    assert.equal(z.shift.id, second.id); assert.equal(z.shift.z_number, 2); assert.equal(z.sales.count, 1);
  } finally { cleanup(); }
});

test('a sale voided (deleted) during the shift comes out of the cash, and is reported so a manager sees it', () => {
  const { db, product, cleanup } = setup();
  try {
    dbm.openShift(db, 'alice', 0);
    const keep = sell(db, { items: [line(product.id, 1, 100)], payment_method: 'cash' });
    const voided = sell(db, { items: [line(product.id, 4, 100)], payment_method: 'cash' });
    dbm.deleteSale(db)(voided.id);
    const z = dbm.closeShift(db, 'alice', { countedCash: 100 });
    assert.equal(z.sales.count, 1); assert.equal(z.cash.expected, 100);
    assert.equal(z.voided.count, 1); assert.equal(z.voided.paid, 400);
    assert.ok(keep.id);
  } finally { cleanup(); }
});

test('an installment collected today belongs to TODAY\'s shift even though the sale was made in an earlier one', () => {
  const { db, product, cleanup } = setup();
  try {
    dbm.openShift(db, 'alice', 0);
    const sale = sell(db, { status: 'outstanding', amount_paid: 100, payment_method: 'cash', items: [line(product.id, 10, 100)] });
    const first = dbm.closeShift(db, 'alice', { countedCash: 100 });
    assert.equal(first.cash.expected, 100);

    dbm.openShift(db, 'alice', 0);
    dbm.addPayment(db)(sale.id, 300, { method: 'cash', owner: 'alice' });
    const second = dbm.closeShift(db, 'alice', { countedCash: 300 });
    assert.equal(second.cash.cash_sales, 300);
    assert.equal(second.sales.count, 0, 'no new sales were made in the second shift');
    assert.equal(second.outstanding.count, 0);
  } finally { cleanup(); }
});

test('the report names the receipts it covers and what customers still owe from sales made in the shift', () => {
  const { db, product, cleanup } = setup();
  try {
    dbm.openShift(db, 'alice', 0);
    const a = sell(db, { items: [line(product.id)] });
    sell(db, { items: [line(product.id)] });
    const c = sell(db, { status: 'outstanding', amount_paid: 40, customer_name: 'Ada', items: [line(product.id, 1, 100)] });
    const z = dbm.closeShift(db, 'alice', { countedCash: 0 });
    assert.equal(z.sales.count, 3); assert.equal(z.first_receipt, a.receipt_no); assert.equal(z.last_receipt, c.receipt_no);
    assert.deepEqual([z.outstanding.count, z.outstanding.balance], [1, 60]);
  } finally { cleanup(); }
});

test('cash movements need an open shift, a positive amount and a reason', () => {
  const { db, cleanup } = setup();
  try {
    assert.throws(() => dbm.addCashMovement(db, 'alice', { kind: 'paid_out', amount: 10, reason: 'x' }), /no open shift/i);
    dbm.openShift(db, 'alice', 0);
    assert.throws(() => dbm.addCashMovement(db, 'alice', { kind: 'paid_out', amount: 0, reason: 'x' }), /amount/i);
    assert.throws(() => dbm.addCashMovement(db, 'alice', { kind: 'paid_out', amount: 10, reason: '  ' }), /reason/i);
    assert.throws(() => dbm.addCashMovement(db, 'alice', { kind: 'steal', amount: 10, reason: 'x' }), /kind/i);
  } finally { cleanup(); }
});

test('cashiers see their own shifts; an owner can list everyone\'s', () => {
  const { db, cleanup } = setup();
  try {
    dbm.openShift(db, 'alice', 0); dbm.closeShift(db, 'alice', { countedCash: 0 });
    dbm.openShift(db, 'bob', 0); dbm.closeShift(db, 'bob', { countedCash: 0 });
    assert.equal(dbm.listShifts(db, { owner: 'alice' }).length, 1);
    assert.equal(dbm.listShifts(db, {}).length, 2);
  } finally { cleanup(); }
});

test('shifts are local bookkeeping for now: they never enter the sync outbox', () => {
  const { db, product, cleanup } = setup();
  try {
    dbm.openShift(db, 'alice', 0);
    sell(db, { items: [line(product.id)] });
    dbm.addCashMovement(db, 'alice', { kind: 'paid_in', amount: 5, reason: 'x' });
    dbm.closeShift(db, 'alice', { countedCash: 105 });
    const kinds = db.prepare(`SELECT DISTINCT entity_type FROM sync_queue`).all().map((r) => r.entity_type);
    assert.ok(kinds.every((k) => ['product', 'stock_batch', 'sale', 'sale_item'].includes(k)), kinds.join(','));
  } finally { cleanup(); }
});
