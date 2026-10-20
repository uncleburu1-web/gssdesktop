// Stage 9: stock moved to another branch leaves this till's stock once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, stockOf, seedProduct } = require('./helpers');

test('a transfer out pulled from the cloud is deducted once', () => {
  const { db, cleanup } = makeDb();
  try {
    const { product, batch } = seedProduct(db, { qty: 14 });
    const move = { id: dbm.uuid(), kind: 'transfer', product_id: product.id, batch_id: batch.id, quantity: '-6.000', reason: 'Moved to Lekki' };
    dbm.applyPulledOperation(db, 'stock_movement', 'update', move);
    dbm.applyPulledOperation(db, 'stock_movement', 'update', move);
    assert.equal(stockOf(db, product.id), 8);
    assert.equal(dbm.listStockMovements(db, { productId: product.id })[0].reason, 'Moved to Lekki');
  } finally { cleanup(); }
});
