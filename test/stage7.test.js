// Stage 7: mobile money (offered only once the cloud is on protocol 5) and the sync-retry audit event.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb } = require('./helpers');

function withDb(body) { const { db, cleanup } = makeDb(); try { return body(db); } finally { cleanup(); } }
const queued = (db, type) => db.prepare(`SELECT * FROM sync_queue WHERE entity_type = ?`).all(type);

test('mobile money is only offered once the cloud understands it', () => withDb((db) => {
  dbm.setSetting(db, 'cloud_sync_protocol', '4');
  assert.ok(!dbm.paymentMethods(db).includes('mobile'));
  dbm.setSetting(db, 'cloud_sync_protocol', '5');
  assert.deepEqual(dbm.paymentMethods(db), ['cash', 'transfer', 'pos', 'mobile']);
}));

test('a sale paid by mobile money is recorded and counted on the shift report', () => withDb((db) => {
  dbm.setSetting(db, 'cloud_sync_protocol', '5');
  const shift = dbm.openShift(db, 'ada', 0);
  dbm.createSale(db)({ cart_owner: 'ada', payment_method: 'mobile', items: [{ item_name: 'Bread', quantity: 1, unit_price: 700 }], amount_paid: 700 });
  const report = dbm.getShiftReport(db, shift.id);
  assert.equal(report.payments.by_method.mobile, 700);
  assert.equal(report.payments.total, 700);
  assert.equal(report.cash.cash_sales, 0, 'mobile money is not cash in the drawer');
  const doc = JSON.parse(queued(db, 'sale_doc')[0].payload);
  assert.equal(doc.payments[0].method, 'mobile');
}));

test('retrying failed changes leaves an audit event for the owner (protocol 5 only)', () => withDb((db) => {
  dbm.setSetting(db, 'cloud_sync_protocol', '5');
  dbm.setSetting(db, 'user_profile', JSON.stringify({ username: 'ada' }));
  dbm.recordAuditEvent(db, 'sync.retry', { summary: 'Retried 2', data: { retried: 2 } });
  const [row] = queued(db, 'audit_event');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.action, 'sync.retry');
  assert.equal(payload.actor, 'ada');
  assert.deepEqual(payload.data, { retried: 2 });

  dbm.setSetting(db, 'cloud_sync_protocol', '4');
  dbm.recordAuditEvent(db, 'sync.retry');
  assert.equal(queued(db, 'audit_event').length, 1, 'never sent to a cloud that cannot take it');
}));
