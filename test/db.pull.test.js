const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, stockOf, seedProduct, markCatalogSynced, sellLocally, queueCount } = require('./helpers');

test('D-02: an owner stock correction on the cloud adjusts the till RELATIVELY and never erases offline sales', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product, batch } = seedProduct(db, { qty: 45 });
    markCatalogSynced(db);                                // the catalog reached the cloud long ago...
    sellLocally(db, product.id, 3);                       // ...only this offline sale is still queued: local 42
    assert.equal(stockOf(db, product.id), 42);

    // Cloud: owner counted stock and found 1 missing -> received 45 -> 44, remaining 45 -> 44.
    dbm.applyPulledOperation(db, 'stock_batch', 'update', {
      id: batch.id, product_id: product.id, batch_number: '', quantity_received: 44,
      quantity_remaining: 44, cost_price: 0, expiry_date: null,
    });

    // True stock = 45 - 3 sold - 1 missing = 41. (Old behaviour: absolute overwrite -> 44, sale erased.)
    assert.equal(stockOf(db, product.id), 41);
  } finally { cleanup(); }
});

test('D-02: an unchanged batch row never overwrites local quantity, but metadata still updates', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product, batch } = seedProduct(db, { qty: 45 });
    markCatalogSynced(db);
    sellLocally(db, product.id, 3);                       // local 42

    dbm.applyPulledOperation(db, 'stock_batch', 'update', {
      id: batch.id, product_id: product.id, batch_number: 'LOT-9', quantity_received: 45,
      quantity_remaining: 10, cost_price: 7, expiry_date: null,   // cloud's remaining differs: other tills sold more
    });

    assert.equal(stockOf(db, product.id), 42);
    const row = db.prepare(`SELECT batch_number, cost_price FROM stock_batches WHERE id = ?`).get(batch.id);
    assert.equal(row.batch_number, 'LOT-9');
    assert.equal(row.cost_price, 7);
  } finally { cleanup(); }
});

test('D-02: a NEW cloud batch plus the sale that consumed it deducts exactly once (no double deduction)', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product } = seedProduct(db, { qty: 0 });      // product, no local stock yet
    const batchId = dbm.uuid(); const saleId = dbm.uuid(); const itemId = dbm.uuid();
    // Cloud added 24 units and then sold 2 from them; the batch row arrives already net (22).
    dbm.applyPulledOperation(db, 'stock_batch', 'create', {
      id: batchId, product_id: product.id, batch_number: 'B2', quantity_received: 24,
      quantity_remaining: 22, cost_price: 0, expiry_date: null,
    });
    dbm.applyPulledOperation(db, 'sale', 'create', {
      id: saleId, invoice_number: 9, customer_name: 'Web', payment_method: 'cash',
      status: 'completed', amount_paid: 200, date: new Date().toISOString(),
    });
    dbm.applyPulledOperation(db, 'sale_item', 'create', {
      id: itemId, sale_id: saleId, product_id: product.id, item_name: 'Cola',
      quantity: 2, unit_price: 100, unit_cost: 0, discount: 0, stock_shortfall: 0,
    });
    assert.equal(stockOf(db, product.id), 22);            // old behaviour: 20
  } finally { cleanup(); }
});

test('D-02a: a local, not-yet-pushed product edit survives a pull; once synced, the cloud value applies', () => {
  const { db, cleanup } = makeDb();
  try {
    const product = dbm.createProduct(db, { name: 'Local name', sell_price: 100 });   // pending 'create' op
    // The edit was made a minute ago (a real till, not a same-millisecond test): the old
    // "local is newer" guard compared against a field the cloud never sends, so it only
    // ever "worked" when the clocks happened to tie.
    db.prepare(`UPDATE products SET updated_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), product.id);
    const cloud = { id: product.id, name: 'CLOUD NAME', short_code: '', barcode: null, category: 'other', unit: 'PIECE', sell_price: '999.00', min_stock: 2, image_url: null };

    dbm.applyPulledOperation(db, 'product', 'update', cloud);
    assert.equal(dbm.getProduct(db, product.id).name, 'Local name');

    db.prepare(`UPDATE sync_queue SET status = 'synced' WHERE entity_id = ?`).run(product.id);
    dbm.applyPulledOperation(db, 'product', 'update', cloud);
    assert.equal(dbm.getProduct(db, product.id).name, 'CLOUD NAME');
  } finally { cleanup(); }
});

test('D-02a: same protection for customers', () => {
  const { db, cleanup } = makeDb();
  try {
    const customer = dbm.createCustomer(db, { name: 'Local Ada' });
    db.prepare(`UPDATE customers SET updated_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), customer.id);
    dbm.applyPulledOperation(db, 'customer', 'update', { id: customer.id, name: 'Cloud Ada', phone: '', email: '', address: '', notes: '' });
    assert.equal(dbm.getCustomer(db, customer.id).name, 'Local Ada');
  } finally { cleanup(); }
});

test('D-06: failed outbox rows are never pruned (they are unsynced sales), synced ones still are', () => {
  const { db, cleanup } = makeDb();
  try {
    const ins = db.prepare(`INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, client_timestamp, status) VALUES (?, 'sale', ?, 'create', '{}', ?, ?)`);
    const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
    ins.run('failed-old', 'e1', daysAgo(30), 'failed');
    ins.run('synced-old', 'e2', daysAgo(3), 'synced');
    dbm.pruneSyncQueue(db);
    assert.equal(queueCount(db, 'failed'), 1);
    assert.equal(queueCount(db, 'synced'), 0);
  } finally { cleanup(); }
});

test('D-06: queue stats expose failed rows, and retryFailedSync puts them back in line', () => {
  const { db, cleanup } = makeDb();
  try {
    db.prepare(`INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, client_timestamp, status, retry_count, next_attempt_at, last_error) VALUES ('f1','sale','e1','create','{}',?,'failed',4,?, 'boom')`)
      .run(new Date().toISOString(), new Date(Date.now() + 999_999).toISOString());
    db.prepare(`INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, client_timestamp, status) VALUES ('p1','sale','e2','create','{}',?,'pending')`)
      .run(new Date().toISOString());

    assert.deepEqual(dbm.getSyncQueueStats(db), { pending: 1, failed: 1 });
    assert.equal(dbm.retryFailedSync(db), 1);
    assert.deepEqual(dbm.getSyncQueueStats(db), { pending: 2, failed: 0 });
    const row = db.prepare(`SELECT retry_count, next_attempt_at FROM sync_queue WHERE id = 'f1'`).get();
    assert.equal(row.retry_count, 0);
    assert.equal(row.next_attempt_at, null);
  } finally { cleanup(); }
});

test('the pull-time "is there an unpushed edit?" lookup is indexed', () => {
  const { db, cleanup } = makeDb();
  try {
    const names = db.prepare(`PRAGMA index_list(sync_queue)`).all().map((r) => r.name);
    assert.ok(names.includes('idx_sync_queue_entity'), `indexes: ${names.join(', ')}`);
  } finally { cleanup(); }
});

test('a batch this till created but has not pushed yet is not touched by a pull', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product, batch } = seedProduct(db, { qty: 45 });      // batch 'create' op still PENDING
    db.prepare(`UPDATE stock_batches SET updated_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), batch.id); // created a minute ago, like a real till
    dbm.applyPulledOperation(db, 'stock_batch', 'update', {
      id: batch.id, product_id: product.id, batch_number: 'X', quantity_received: 1,
      quantity_remaining: 1, cost_price: 0, expiry_date: null,
    });
    assert.equal(stockOf(db, product.id), 45);
    assert.equal(db.prepare(`SELECT quantity_received AS n FROM stock_batches WHERE id = ?`).get(batch.id).n, 45);
  } finally { cleanup(); }
});
