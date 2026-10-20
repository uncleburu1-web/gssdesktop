// Stage 11: products sold by weight (kg, to the gram); everything else stays whole units.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { dbm, makeDb, stockOf } = require('./helpers');

function withDb(body) { const { db, cleanup } = makeDb(); try { return body(db); } finally { cleanup(); } }
function rice(db) {
  dbm.setSetting(db, 'cloud_sync_protocol', '5');
  dbm.setSetting(db, 'user_profile', JSON.stringify({ username: 'boss' }));
  const product = dbm.createProduct(db, { name: 'Rice (loose)', sell_price: 1500, sold_by_weight: true });
  dbm.addStockBatch(db, { product_id: product.id, quantity_received: 25.5, cost_price: 1000 });
  return product;
}

test('kg are sold to the gram with no float dust, priced per kg', () => withDb((db) => {
  const p = rice(db);
  assert.equal(p.unit, 'KG');
  for (const kg of [0.1, 0.2, 1.25]) {
    dbm.createSale(db)({ items: [{ product_id: p.id, item_name: 'Rice', quantity: kg, unit_price: 1500 }], amount_paid: Math.round(kg * 1500 * 100) / 100 });
  }
  assert.equal(stockOf(db, p.id), 23.95);
  const sale = dbm.createSale(db)({ items: [{ product_id: p.id, item_name: 'Rice', quantity: 0.7, unit_price: 1500 }], amount_paid: 1050 });
  assert.equal(sale.total, 1050);
  assert.equal(sale.items[0].by_weight, 1, 'the receipt knows to print kg');
  assert.throws(() => dbm.createSale(db)({ items: [{ product_id: p.id, item_name: 'Rice', quantity: 0.0005, unit_price: 1500 }], amount_paid: 1 }), /3 decimals/);
}));

test('whole-unit products still refuse fractions everywhere', () => withDb((db) => {
  const tin = dbm.createProduct(db, { name: 'Milk tin', sell_price: 900 });
  assert.throws(() => dbm.addStockBatch(db, { product_id: tin.id, quantity_received: 2.5 }), /whole number/);
  dbm.addStockBatch(db, { product_id: tin.id, quantity_received: 10 });
  assert.throws(() => dbm.createSale(db)({ items: [{ product_id: tin.id, item_name: 'Milk', quantity: 1.5, unit_price: 900 }], amount_paid: 0, status: 'outstanding' }), /whole number/);
  assert.throws(() => dbm.recordDamage(db, { product_id: tin.id, quantity: 0.5, reason: 'x' }), /whole number/);
}));

test('damage, counts and returns take kg for weighed products', () => withDb((db) => {
  const p = rice(db);
  dbm.recordDamage(db, { product_id: p.id, quantity: 0.35, reason: 'Wet' });
  dbm.recordStockCount(db, { product_id: p.id, counted_quantity: 24, reason: 'Weighed' });
  assert.equal(stockOf(db, p.id), 24);
  const sale = dbm.createSale(db)({ items: [{ product_id: p.id, item_name: 'Rice', quantity: 2, unit_price: 1500 }], amount_paid: 3000 });
  const r = dbm.createReturn(db, { sale_id: sale.id, lines: [{ sale_item_id: sale.items[0].id, quantity: 0.5 }], reason: 'Too much' }, 'boss');
  assert.equal(r.refund_amount, 750);
  assert.equal(stockOf(db, p.id), 22.5);
}));

test('the weight flag comes down from the cloud', () => withDb((db) => {
  const id = dbm.uuid();
  dbm.applyPulledOperation(db, 'product', 'update', { id, name: 'Beans', sell_price: '1200', sold_by_weight: true });
  assert.equal(db.prepare(`SELECT sold_by_weight FROM products WHERE id = ?`).get(id).sold_by_weight, 1);
}));

test('scale labels: product code + grams', async () => {
  // PosScreen.jsx is JSX; the label reader is plain logic, re-checked here on the same rule.
  const read = (code, catalog) => {
    if (!/^2\d{12}$/.test(code)) return null;
    const plu = code.slice(1, 6); const grams = Number(code.slice(6, 11));
    const product = catalog.find((i) => i.sold_by_weight && (i.barcode === plu || i.short_code === plu || i.barcode === String(Number(plu)) || i.short_code === String(Number(plu))));
    return product && grams > 0 ? { product, kg: Math.round((grams / 1000) * 1000) / 1000 } : null;
  };
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'PosScreen.jsx'), 'utf8');
  assert.ok(src.includes("const grams = Number(code.slice(6, 11));"), 'the screen uses the same rule');
  const catalog = [{ id: 'r', sold_by_weight: 1, short_code: '00042' }, { id: 't', sold_by_weight: 0, barcode: '00042' }];
  assert.deepEqual(read('2000420125003', catalog), { product: catalog[0], kg: 1.25 });
  assert.equal(read('2000990125003', catalog), null, 'unknown product code');
  assert.equal(read('5000420125003', catalog), null, 'not a scale label');
});
