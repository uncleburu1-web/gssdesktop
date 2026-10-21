/*
 * A till that receives the cloud's stock history must end with the cloud's number, whatever
 * order the history arrives in.
 *
 * Found in the v1.0.22 release check (21 Oct 2026): a fresh till applies every pulled sale first
 * and every damage / count / return afterwards. When that replay crossed zero, the till refused
 * to go below zero and silently dropped the rest of the change, so a fresh till showed 14 bottles
 * of an item the cloud had 6 of. The fix: apply exactly what the cloud applied, no clamping.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, stockOf } = require('./helpers');

const at = (minutes) => new Date(Date.UTC(2026, 9, 21, 8, minutes)).toISOString();

// The cloud's history for one product, in the order it really happened. Each step keeps the cloud
// at or above zero, as the cloud itself enforces.
function history(productId, batchId) {
  const sale = (n, qty, shortfall = 0) => {
    const saleId = dbm.uuid();
    return [
      ['sale', { id: saleId, invoice_number: n, customer_name: 'Other till', payment_method: 'cash', status: 'completed', amount_paid: 100 * qty, date: at(n) }],
      ['sale_item', { id: dbm.uuid(), sale_id: saleId, product_id: productId, item_name: 'Oil', quantity: qty, unit_price: 100, unit_cost: 0, discount: 0, stock_shortfall: shortfall }],
    ];
  };
  const move = (kind, quantity, minute) => [['stock_movement', { id: dbm.uuid(), kind, product_id: productId, batch_id: batchId, quantity: String(quantity), reason: kind, created_at: at(minute) }]];
  // received 10 -> damage -4 (6) -> count +6 (12) -> sale 12 (0) -> count +5 (5) -> sale 3 (2) -> return +1 (3)
  return [move('damage', -4, 1), move('adjustment', 6, 2), sale(3, 12), move('adjustment', 5, 4), sale(5, 3), move('return', 1, 6)];
}
const CLOUD_FINAL = 3;

function freshTill() {
  const { db, cleanup } = makeDb();
  const productId = dbm.uuid();
  const batchId = dbm.uuid();
  dbm.applyPulledOperation(db, 'product', 'create', { id: productId, name: 'Oil', sell_price: 100, cost_price: 0 });
  dbm.applyPulledOperation(db, 'stock_batch', 'create', { id: batchId, product_id: productId, batch_number: '', quantity_received: 10, quantity_remaining: CLOUD_FINAL, cost_price: 0, expiry_date: null });
  return { db, cleanup, productId, batchId };
}

function replay(db, steps) {
  for (const step of steps) for (const [type, payload] of step) dbm.applyPulledOperation(db, type, 'create', payload);
}

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest]));
}

test('a fresh till that gets all sales first, then all stock changes, matches the cloud', () => {
  const { db, cleanup, productId, batchId } = freshTill();
  try {
    const steps = history(productId, batchId);
    const sales = steps.filter((s) => s[0][0] === 'sale');
    const moves = steps.filter((s) => s[0][0] === 'stock_movement');
    replay(db, [...sales, ...moves]); // exactly the order a real first pull uses
    assert.equal(stockOf(db, productId), CLOUD_FINAL);
  } finally { cleanup(); }
});

test('every order of the same history ends at the cloud number', () => {
  // 6 steps -> 720 orders. Each is a fresh till.
  const template = freshTill();
  const steps = history(template.productId, template.batchId);
  template.cleanup();
  let checked = 0;
  for (const order of permutations(steps.map((_, i) => i))) {
    const till = freshTill();
    try {
      const mine = history(till.productId, till.batchId);
      replay(till.db, order.map((i) => mine[i]));
      assert.equal(stockOf(till.db, till.productId), CLOUD_FINAL, `order ${order.join(',')}`);
      checked += 1;
    } finally { till.cleanup(); }
  }
  assert.equal(checked, 720);
  assert.equal(steps.length, 6);
});

test("a sale the cloud could only partly cover takes off only what the cloud took", () => {
  const { db, cleanup, productId } = freshTill();
  try {
    const saleId = dbm.uuid();
    dbm.applyPulledOperation(db, 'sale', 'create', { id: saleId, invoice_number: 1, customer_name: 'Other till', payment_method: 'cash', status: 'completed', amount_paid: 1300, date: at(1) });
    // The cloud had 10; another till sold 13 offline; the cloud recorded a shortfall of 3.
    dbm.applyPulledOperation(db, 'sale_item', 'create', { id: dbm.uuid(), sale_id: saleId, product_id: productId, item_name: 'Oil', quantity: 13, unit_price: 100, unit_cost: 0, discount: 0, stock_shortfall: 3 });
    assert.equal(stockOf(db, productId), 0);
  } finally { cleanup(); }
});

test("this till's own sales are unchanged: it still never sells stock it does not have", () => {
  const { db, cleanup, productId } = freshTill();
  try {
    const sale = dbm.createSale(db)({ items: [{ product_id: productId, item_name: 'Oil', quantity: 12, unit_price: 100 }], amount_paid: 1200 });
    assert.equal(stockOf(db, productId), 0, 'local stock never goes below zero from a local sale');
    const line = db.prepare(`SELECT stock_shortfall FROM sale_items WHERE sale_id = ?`).get(sale.id || sale.sale_id);
    assert.equal(line.stock_shortfall, 2, 'the 2 it did not have are recorded as a shortfall, as before');
  } finally { cleanup(); }
});
