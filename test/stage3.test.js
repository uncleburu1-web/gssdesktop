// Stage 3: shifts, cash movements and Z-reports go to the cloud (only a protocol-3 cloud).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { dbm, makeDb, login, FakeCloud, sleep } = require('./helpers');
const { startSyncEngine } = require('../src/main/sync');

const queued = (db, type) => db.prepare(`SELECT * FROM sync_queue WHERE entity_type = ? ORDER BY rowid`).all(type);
function withDb(body) { const { db, cleanup } = makeDb(); try { return body(db); } finally { cleanup(); } }
const v3 = (db) => dbm.setSetting(db, 'cloud_sync_protocol', '3');

test('protocol 2 cloud: shifts stay local exactly as before', () => withDb((db) => {
  dbm.setSetting(db, 'cloud_sync_protocol', '2');
  dbm.openShift(db, 'ada', 1000);
  dbm.addCashMovement(db, 'ada', { kind: 'paid_out', amount: 200, reason: 'Fuel' });
  dbm.closeShift(db, 'ada', { countedCash: 800 });
  assert.equal(queued(db, 'shift').length + queued(db, 'cash_movement').length, 0);
}));

test('protocol 3: open, cash movement and close are each queued, the close carrying the frozen Z-report', () => withDb((db) => {
  v3(db);
  const shift = dbm.openShift(db, 'ada', 1000);
  dbm.addCashMovement(db, 'ada', { kind: 'paid_out', amount: 200, reason: 'Fuel' });
  const z = dbm.closeShift(db, 'ada', { countedCash: 750 });
  const shifts = queued(db, 'shift');
  assert.deepEqual(shifts.map((r) => r.operation), ['create', 'update']);
  const closed = JSON.parse(shifts[1].payload);
  assert.equal(closed.id, shift.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.variance, -50);                               // 1000 - 200 = 800 expected, 750 counted
  assert.deepEqual(JSON.parse(closed.report_json), z);
  const move = JSON.parse(queued(db, 'cash_movement')[0].payload);
  assert.equal(move.shift_id, shift.id);
  assert.equal(move.reason, 'Fuel');
}));

test('a refused cash movement queues nothing', () => withDb((db) => {
  v3(db);
  dbm.openShift(db, 'ada', 0);
  assert.throws(() => dbm.addCashMovement(db, 'ada', { kind: 'paid_out', amount: 100, reason: '' }));
  assert.equal(queued(db, 'cash_movement').length, 0);
}));

test('shift history kept before the upgrade goes up once when the cloud reaches protocol 3', async () => {
  const { db, cleanup } = makeDb();
  const cloud = new FakeCloud().install();
  login(db);
  try {
    dbm.setSetting(db, 'cloud_sync_protocol', '2');
    dbm.openShift(db, 'ada', 1000);
    dbm.closeShift(db, 'ada', { countedCash: 1000 });
    dbm.openShift(db, 'ada', 500);                                 // still open
    cloud.pullBody = { operations: [], server_time: new Date().toISOString(), sync_protocol: 3 };
    const engine = startSyncEngine(db, () => {});
    await sleep(150); await engine.pushNow(); await sleep(100); engine.stop();
    const sent = cloud.pushRequests.flat();
    const shiftRows = db.prepare(`SELECT id, synced_at FROM shifts`).all();
    for (const s of shiftRows) assert.ok(s.synced_at, 'acknowledged shifts are stamped');
    assert.equal(queued(db, 'shift').length, 2);
    assert.equal(dbm.reconcileUnsyncedRows(db), 0, 'and never queued again');
    assert.ok(sent.length >= 2);
  } finally { cleanup(); await sleep(10); }
});

test('an older till database gains the synced_at columns and keeps its shifts', () => {
  const { db, dir, cleanup } = makeDb();
  try {
    dbm.openShift(db, 'ada', 300);
    db.exec('ALTER TABLE shifts DROP COLUMN synced_at');
    db.exec('ALTER TABLE cash_movements DROP COLUMN synced_at');
    db.close();
    const reopened = dbm.openDb(path.join(dir, 'pos.db'));
    try {
      assert.ok(reopened.prepare(`PRAGMA table_info(shifts)`).all().some((c) => c.name === 'synced_at'));
      assert.equal(reopened.prepare(`SELECT COUNT(*) n FROM shifts`).get().n, 1);
    } finally { reopened.close(); }
  } finally { cleanup(); }
});
