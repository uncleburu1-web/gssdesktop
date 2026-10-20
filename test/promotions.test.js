// Stage 10: the till's promotion evaluator gives exactly the server's answers (shared cases).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'promotion_vectors.json'), 'utf8'));
const loadEngine = () => import(path.join(__dirname, '..', 'src', 'renderer', 'promotions.js'));

test('every shared promotion case matches the server', async () => {
  const { bestDiscounts } = await loadEngine();
  const now = new Date(vectors.now);
  for (const c of vectors.cases) {
    const got = bestDiscounts(c.lines, c.promotions, now).map((g) => ({ discount: g.discount.toFixed(2), promotion_id: g.promotion_id }));
    assert.deepEqual(got, c.expected, c.name);
  }
});

const { dbm, makeDb, seedProduct } = require('./helpers');

test('promotions pulled from the cloud are stored, and a sale keeps the discount and which promotion gave it', () => {
  const { db, cleanup } = makeDb();
  try {
    dbm.applyPulledOperation(db, 'promotion', 'update', { id: 'p1', name: '10% off', kind: 'percent_off', value: '10', applies_to: 'all', is_active: true });
    dbm.applyPulledOperation(db, 'promotion', 'update', { id: 'p2', name: 'gone', kind: 'percent_off', value: '50', applies_to: 'all', is_active: true });
    dbm.applyPulledOperation(db, 'promotion', 'delete', { id: 'p2' });
    assert.deepEqual(dbm.listPromotions(db).map((p) => p.id), ['p1']);

    dbm.setSetting(db, 'cloud_sync_protocol', '5');
    const { product } = seedProduct(db, { qty: 5 });
    const sale = dbm.createSale(db)({ items: [{ product_id: product.id, item_name: 'Cola', quantity: 2, unit_price: 100, discount: 20, promotion_id: 'p1' }], amount_paid: 180 });
    assert.equal(sale.total, 180);
    const doc = JSON.parse(db.prepare(`SELECT payload FROM sync_queue WHERE entity_type = 'sale_doc'`).get().payload);
    assert.equal(doc.items[0].promotion_id, 'p1');
    assert.equal(doc.items[0].discount, 20);

    const capped = dbm.createSale(db)({ items: [{ product_id: product.id, item_name: 'Cola', quantity: 1, unit_price: 100, discount: 500 }], amount_paid: 0, status: 'outstanding' });
    assert.equal(capped.items[0].discount, 100, 'a discount can never exceed the line');
  } finally { cleanup(); }
});
