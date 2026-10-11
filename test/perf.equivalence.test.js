const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb } = require('./helpers');
const { isDeepStrictEqual } = require('node:util');
const legacy = require('./legacy-reference');

// Sales now also carry their `payments` (a feature added after the frozen reference below was taken).
// Everything ELSE must still be identical. isDeepStrictEqual + a short message, not assert.deepEqual: on
// a mismatch across hundreds of big objects, building assert's diff text can exhaust memory.
const withoutPayments = (sales) => sales.map(({ payments, ...rest }) => rest);
const sameAs = (actual, expected, label) => assert.ok(isDeepStrictEqual(actual, expected), `${label}: results differ from the original implementation`);

// Deterministic PRNG so a failure is reproducible.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Realistic mixed shop: products with 0-3 batches at awkward costs, customers, discounts,
// completed and installment ("outstanding") sales, a few deleted rows.
function seedShop(db, { products = 60, customers = 25, sales = 500, seed = 7 } = {}) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const categories = ['phones', 'accessories', 'drinks', 'other'];
  const productIds = [];
  for (let i = 0; i < products; i += 1) {
    const p = dbm.createProduct(db, { name: `Item ${String(i).padStart(3, '0')} ${pick(['Cola', 'Charger', 'Wine', 'Case'])}`, sell_price: 100 + Math.floor(rand() * 9000), category: pick(categories), barcode: i % 3 ? `BC${i}` : null });
    productIds.push(p.id);
    const batches = Math.floor(rand() * 4);
    for (let b = 0; b < batches; b += 1) {
      dbm.addStockBatch(db, { product_id: p.id, quantity_received: 1 + Math.floor(rand() * 60), cost_price: Math.round((20 + rand() * 4000) * 100) / 100, expiry_date: rand() < 0.5 ? null : `2027-0${1 + Math.floor(rand() * 9)}-15` });
    }
  }
  const customerIds = [];
  for (let i = 0; i < customers; i += 1) customerIds.push(dbm.createCustomer(db, { name: `Customer ${i}`, phone: `080${1000000 + i}` }).id);
  const make = dbm.createSale(db);
  const saleIds = [];
  for (let s = 0; s < sales; s += 1) {
    const lines = 1 + Math.floor(rand() * 4);
    const items = [];
    for (let l = 0; l < lines; l += 1) {
      const pid = pick(productIds);
      const unit = 100 + Math.floor(rand() * 9000);
      items.push({ product_id: pid, item_name: `line ${l}`, quantity: 1 + Math.floor(rand() * 5), unit_price: unit, discount: rand() < 0.3 ? Math.floor(rand() * 50) : 0 });
    }
    const installment = rand() < 0.25 && customerIds.length;
    const sale = make({
      items, customer_id: installment || rand() < 0.4 ? pick(customerIds) : null, customer_name: 'x',
      status: installment ? 'outstanding' : 'completed', amount_paid: installment ? Math.floor(rand() * 500) : 0,
    });
    saleIds.push(sale.id);
    // distinct, descending-friendly timestamps so ordering is unambiguous
    db.prepare(`UPDATE sales SET date = ? WHERE id = ?`).run(new Date(Date.UTC(2026, 0, 1) + s * 60_000).toISOString(), sale.id);
  }
  for (let i = 0; i < 12; i += 1) if (saleIds[i * 7]) db.prepare(`UPDATE sales SET is_deleted = 1 WHERE id = ?`).run(saleIds[i * 7]);
  return { productIds, customerIds, saleIds };
}

const countQueries = (db, fn) => {
  let n = 0; const real = db.prepare.bind(db);
  db.prepare = (sql) => { const st = real(sql); return { run: (...a) => { n += 1; return st.run(...a); }, get: (...a) => { n += 1; return st.get(...a); }, all: (...a) => { n += 1; return st.all(...a); } }; };
  try { return { result: fn(), queries: n }; } finally { db.prepare = real; }
};

test('listSales returns exactly what the old per-sale-query version returned (all / completed / outstanding)', () => {
  const { db, cleanup } = makeDb();
  try {
    seedShop(db);
    for (const status of [null, 'completed', 'outstanding']) {
      sameAs(withoutPayments(dbm.listSales(db, { status })), legacy.legacyListSales(db, { status }), `listSales status=${status}`);
    }
    assert.ok(dbm.listSales(db, {}).length > 400);
  } finally { cleanup(); }
});

test('listProducts returns exactly what the old per-product-query version returned (incl. category and search)', () => {
  const { db, cleanup } = makeDb();
  try {
    seedShop(db);
    for (const params of [{}, { category: 'phones' }, { search: 'cola' }, { search: 'bc1' }, { category: 'drinks', search: 'wine' }]) {
      sameAs(dbm.listProducts(db, params), legacy.legacyListProducts(db, params), `listProducts ${JSON.stringify(params)}`);
    }
  } finally { cleanup(); }
});

test('listCustomers returns exactly what the old nested-query version returned, balances included', () => {
  const { db, cleanup } = makeDb();
  try {
    seedShop(db);
    for (const params of [{}, { search: 'customer 1' }]) {
      const fast = dbm.listCustomers(db, params);
      sameAs(fast, legacy.legacyListCustomers(db, params), `listCustomers ${JSON.stringify(params)}`);
      assert.ok(fast.some((c) => c.balance_due > 0), 'seed should include customers who owe money');
    }
  } finally { cleanup(); }
});

test('pagination: pages are newest-first, never overlap, and stitch back into the full list', () => {
  const { db, cleanup } = makeDb();
  try {
    seedShop(db, { sales: 260 });
    const all = dbm.listSales(db, { status: 'completed' });
    const pages = [];
    for (let offset = 0; ; offset += 50) {
      const page = dbm.listSales(db, { status: 'completed', limit: 50, offset });
      if (page.length === 0) break;
      assert.ok(page.length <= 50);
      pages.push(...page);
    }
    assert.deepEqual(pages.map((s) => s.id), all.map((s) => s.id));
    assert.equal(new Set(pages.map((s) => s.id)).size, pages.length);
    assert.ok(all.every((s, i) => i === 0 || all[i - 1].date >= s.date), 'newest first');
  } finally { cleanup(); }
});

test('query budget: lists cost a handful of queries, not one or two per row', () => {
  const { db, cleanup } = makeDb();
  try {
    seedShop(db, { products: 40, customers: 20, sales: 300 });
    assert.ok(countQueries(db, () => dbm.listSales(db, {})).queries <= 4, 'listSales');
    assert.ok(countQueries(db, () => dbm.listSales(db, { status: 'outstanding', limit: 100 })).queries <= 4, 'listSales page');
    assert.ok(countQueries(db, () => dbm.listProducts(db, {})).queries <= 3, 'listProducts');
    assert.ok(countQueries(db, () => dbm.listCustomers(db, {})).queries <= 4, 'listCustomers');
  } finally { cleanup(); }
});

test('with 20,000 sales on the till, the first page and the product list stay fast', () => {
  const { db, cleanup } = makeDb();
  try {
    const { productIds } = seedShop(db, { products: 400, customers: 50, sales: 5, seed: 3 });
    const base = Date.UTC(2025, 0, 1);
    db.transaction(() => {
      const sale = db.prepare(`INSERT INTO sales (id, invoice_number, customer_id, customer_name, staff_name, payment_method, status, amount_paid, date, created_at, updated_at, is_deleted) VALUES (?, ?, NULL, 'Walk-in', '', 'cash', 'completed', 0, ?, ?, ?, 0)`);
      const item = db.prepare(`INSERT INTO sale_items (id, sale_id, product_id, item_name, category, quantity, unit_price, unit_cost, discount, created_at, updated_at, is_deleted) VALUES (?, ?, ?, 'bulk', '', 2, 500, 300, 0, ?, ?, 0)`);
      for (let i = 0; i < 20_000; i += 1) {
        const id = `bulk-sale-${i}`; const ts = new Date(base + i * 30_000).toISOString();
        sale.run(id, 1000 + i, ts, ts, ts);
        for (let l = 0; l < 3; l += 1) item.run(`${id}-${l}`, id, productIds[(i + l) % productIds.length], ts, ts);
      }
    })();
    const time = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
    const page = time(() => dbm.listSales(db, { status: 'completed', limit: 100 }));
    const products = time(() => dbm.listProducts(db, {}));
    console.log(`  [perf] 20k sales: first page of 100 = ${page.ms.toFixed(0)} ms, product list (400) = ${products.ms.toFixed(0)} ms`);
    assert.equal(page.r.length, 100);
    assert.ok(page.ms < 500, `first page took ${page.ms} ms`);
    assert.ok(products.ms < 500, `product list took ${products.ms} ms`);
  } finally { cleanup(); }
});
