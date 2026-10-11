const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { dbm, makeDb, seedProduct } = require('./helpers');

const cartOf = (productId, qty = 2) => ({
  lines: [{ key: `stock-${productId}`, product_id: productId, item_name: 'Cola', category: '', quantity: qty, unit_price: 100, unit_cost: 40, maxQty: 45 }],
  customer: null, customerName: 'Ada',
});

test('a cart in progress is saved and comes back exactly as it was', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    dbm.saveDraft(db, 'alice', cartOf(product.id, 3));
    assert.deepEqual(dbm.loadDraft(db, 'alice'), cartOf(product.id, 3));
  } finally { cleanup(); }
});

test('POWER CUT: the draft survives the process dying and the database being reopened', () => {
  const { db, dir, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    dbm.saveDraft(db, 'alice', cartOf(product.id, 4));
    db.close();                                              // no clean shutdown, nothing flushed by the app
    const reopened = dbm.openDb(path.join(dir, 'pos.db'));
    assert.equal(dbm.loadDraft(reopened, 'alice').lines[0].quantity, 4);
    reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an emptied cart removes the draft (nothing stale to "restore" next time)', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    dbm.saveDraft(db, 'alice', cartOf(product.id));
    dbm.saveDraft(db, 'alice', { lines: [], customer: null, customerName: '' });
    assert.equal(dbm.loadDraft(db, 'alice'), null);
  } finally { cleanup(); }
});

test('cashiers never see each other\'s carts', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    dbm.saveDraft(db, 'alice', cartOf(product.id, 1));
    dbm.saveDraft(db, 'bob', cartOf(product.id, 7));
    dbm.parkCart(db, 'alice', cartOf(product.id, 2));
    assert.equal(dbm.loadDraft(db, 'bob').lines[0].quantity, 7);
    assert.equal(dbm.listParked(db, 'bob').length, 0);
    assert.equal(dbm.listParked(db, 'alice').length, 1);
  } finally { cleanup(); }
});

test('NO DUPLICATE SALE: a completed sale clears the draft in the SAME transaction', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    dbm.saveDraft(db, 'alice', cartOf(product.id, 2));
    const sale = dbm.createSale(db)({ cart_owner: 'alice', items: [{ product_id: product.id, item_name: 'Cola', quantity: 2, unit_price: 100 }], amount_paid: 200 });
    assert.ok(sale.id);
    assert.equal(dbm.loadDraft(db, 'alice'), null, 'a restart after this point must not offer the same cart again');
  } finally { cleanup(); }
});

test('a sale that FAILS leaves the draft untouched so nothing is lost', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    dbm.saveDraft(db, 'alice', cartOf(product.id, 2));
    assert.throws(() => dbm.createSale(db)({ cart_owner: 'alice', items: [{ product_id: product.id, item_name: null, quantity: 2, unit_price: 100 }] }));
    assert.equal(dbm.loadDraft(db, 'alice').lines[0].quantity, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sales`).get().n, 0, 'the failed sale must leave nothing behind');
  } finally { cleanup(); }
});

test('park a cart for a moment, serve someone else, then resume it', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    dbm.saveDraft(db, 'alice', cartOf(product.id, 3));
    const parked = dbm.parkCart(db, 'alice', cartOf(product.id, 3));
    assert.equal(dbm.loadDraft(db, 'alice'), null, 'parking clears the active cart');
    const list = dbm.listParked(db, 'alice');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, parked.id);
    assert.equal(list[0].item_count, 3);
    assert.equal(list[0].total, 300);

    const back = dbm.resumeParked(db, 'alice', parked.id);
    assert.equal(back.lines[0].quantity, 3);
    assert.equal(dbm.listParked(db, 'alice').length, 0);
    assert.equal(dbm.loadDraft(db, 'alice').lines[0].quantity, 3, 'resumed cart is the active draft again');
  } finally { cleanup(); }
});

test('resuming while a cart is active parks the active one instead of losing it', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    const first = dbm.parkCart(db, 'alice', cartOf(product.id, 1));
    dbm.saveDraft(db, 'alice', cartOf(product.id, 9));         // customer #2 is mid-checkout
    const resumed = dbm.resumeParked(db, 'alice', first.id);
    assert.equal(resumed.lines[0].quantity, 1);
    const parkedNow = dbm.listParked(db, 'alice');
    assert.equal(parkedNow.length, 1, 'the 9-unit cart must now be parked, not destroyed');
    assert.equal(dbm.resumeParked(db, 'alice', parkedNow[0].id).lines[0].quantity, 9);
  } finally { cleanup(); }
});

test('discarding a parked cart removes only that one, and only for its owner', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    const a = dbm.parkCart(db, 'alice', cartOf(product.id, 1));
    const b = dbm.parkCart(db, 'alice', cartOf(product.id, 2));
    dbm.discardParked(db, 'bob', a.id);                         // wrong owner: no effect
    assert.equal(dbm.listParked(db, 'alice').length, 2);
    dbm.discardParked(db, 'alice', a.id);
    assert.deepEqual(dbm.listParked(db, 'alice').map((p) => p.id), [b.id]);
  } finally { cleanup(); }
});

test('carts are local scratch space: they never enter the sync outbox', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db);
    const before = db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n;
    dbm.saveDraft(db, 'alice', cartOf(product.id));
    dbm.parkCart(db, 'alice', cartOf(product.id));
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sync_queue`).get().n, before);
  } finally { cleanup(); }
});

test('absurd input cannot bloat the database', () => {
  const { db, cleanup } = makeDb();
  try {
    const huge = { lines: Array.from({ length: 5000 }, (_, i) => ({ key: `k${i}`, item_name: 'x', quantity: 1, unit_price: 1 })), customer: null, customerName: '' };
    assert.throws(() => dbm.saveDraft(db, 'alice', huge), /too large/i);
  } finally { cleanup(); }
});
