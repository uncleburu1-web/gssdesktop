// Stage 1 regression tests (architecture analysis G3, G4, G6 + outbox attribution columns).
//   G3  every sync call names this till's device, so the cloud scopes it to the paired branch
//   G4  the pull cursor is the cloud's overlapping next_since; re-delivered rows apply once
//   G6  a "reused operation id" rejection is visible and a retry gets a fresh id
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, login, seedQueue, queueCount, FakeCloud, settlePush, sleep, seedProduct, stockOf, markCatalogSynced } = require('./helpers');
const { startSyncEngine } = require('../src/main/sync');
const { getOrCreateDeviceId } = require('../src/main/device');

async function withEngine(setup, body, onDataChanged = () => {}) {
  const { db, cleanup } = makeDb();
  const cloud = new FakeCloud().install();
  login(db);
  setup && setup({ db, cloud });
  const engine = startSyncEngine(db, onDataChanged);
  try { await body({ db, cloud, engine }); }
  finally { engine.stop(); cleanup(); await sleep(10); }
}

const row = (db, id) => db.prepare(`SELECT * FROM sync_queue WHERE id = ?`).get(id);

// ---- G3 ---------------------------------------------------------------------------------------

test('G3: push, pull and reconcile all carry this till\'s device id', async () => {
  await withEngine(({ db }) => seedQueue(db, [{ id: 'op-1', entity_type: 'customer' }]), async ({ db, cloud, engine }) => {
    await settlePush(engine);
    await engine.pullNow(); await sleep(50);
    const deviceId = getOrCreateDeviceId(db);
    const sync = cloud.requests.filter((r) => /\/sync\/(push|pull)\//.test(r.url));
    assert.ok(sync.some((r) => r.url.endsWith('/sync/push/')), 'expected a push');
    assert.ok(sync.some((r) => r.url.includes('/sync/pull/')), 'expected a pull');
    for (const r of sync) assert.equal(r.headers['X-Device-ID'], deviceId, `${r.url} lacks the device header`);
  });
});

test('G3: a 410 (till removed from the shop) keeps every row, burns nothing, and asks for a sign-in', async () => {
  await withEngine(({ db, cloud }) => { cloud.pushHttpStatus = 410; seedQueue(db, [{ id: 'a', entity_type: 'sale' }]); }, async ({ db, engine }) => {
    await settlePush(engine);
    const r = row(db, 'a');
    assert.equal(r.status, 'pending');
    assert.equal(r.retry_count, 0);
    assert.equal(r.next_attempt_at, null);
    const status = engine.getStatus().cloudSync;
    assert.equal(status.state, 'auth_required');
    assert.match(status.message, /removed/);
  });
});

// ---- G4 ---------------------------------------------------------------------------------------

test('G4: the cloud\'s next_since becomes the cursor; the sidebar still shows when the pull happened', async () => {
  await withEngine(({ cloud }) => {
    cloud.pullBody = { operations: [], server_time: '2026-10-18T12:00:00+00:00', next_since: '2026-10-18T11:58:00+00:00' };
  }, async ({ db, engine }) => {
    await engine.pullNow(); await sleep(50);
    assert.equal(dbm.getLastPullAt(db), '2026-10-18T11:58:00+00:00');
    assert.equal(engine.getStatus().lastPullAt, '2026-10-18T12:00:00+00:00');
  });
});

test('G4: an older cloud without next_since still works exactly as before', async () => {
  await withEngine(({ cloud }) => { cloud.pullBody = { operations: [], server_time: '2026-10-18T12:00:00+00:00' }; }, async ({ db, engine }) => {
    await engine.pullNow(); await sleep(50);
    assert.equal(dbm.getLastPullAt(db), '2026-10-18T12:00:00+00:00');
  });
});

test('G4: the next pull asks from next_since, so a late-committed row is fetched', async () => {
  await withEngine(({ cloud }) => {
    cloud.pullBody = { operations: [], server_time: '2026-10-18T12:00:00+00:00', next_since: '2026-10-18T11:58:00+00:00' };
  }, async ({ cloud, engine }) => {
    await engine.pullNow(); await sleep(50);
    cloud.requests = [];
    await engine.pullNow(); await sleep(50);
    const pull = cloud.requests.find((r) => r.url.includes('/sync/pull/'));
    assert.ok(pull.url.includes(`since=${encodeURIComponent('2026-10-18T11:58:00+00:00')}`), pull.url);
  });
});

test('G4: a sale another till made, delivered by two overlapping pulls, deducts local stock ONCE', async () => {
  let product;
  const saleId = dbm.uuid(); const itemId = dbm.uuid();
  const at = '2026-10-18T11:59:00+00:00';
  const changes = [];
  await withEngine(({ db, cloud }) => {
    ({ product } = seedProduct(db, { qty: 10 }));
    markCatalogSynced(db);
    cloud.pullBody = {
      server_time: '2026-10-18T12:00:00+00:00', next_since: '2026-10-18T11:58:00+00:00',
      operations: [
        { entity_type: 'sale', entity_id: saleId, operation: 'update', updated_at: at,
          payload: { id: saleId, invoice_number: 4, customer_name: 'Other till', payment_method: 'cash', status: 'completed', amount_paid: 300, date: at } },
        { entity_type: 'sale_item', entity_id: itemId, operation: 'update', updated_at: at,
          payload: { id: itemId, sale_id: saleId, product_id: product.id, item_name: 'Cola', quantity: 3, unit_price: 100, unit_cost: 0, discount: '0', stock_shortfall: 0 } },
      ],
    };
  }, async ({ db, engine }) => {
    await engine.pullNow(); await sleep(50);
    await engine.pullNow(); await sleep(50);      // same rows again, inside the overlap window
    await engine.pullNow(); await sleep(50);
    assert.equal(stockOf(db, product.id), 7);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sale_items WHERE id = ?`).get(itemId).n, 1);
    const announced = changes.filter((ops) => ops.some((o) => o.entity_id === itemId));
    assert.equal(announced.length, 1, 'screens should hear about the unchanged row once, not on every pull');
  }, (ops) => changes.push(ops));
});

test('G4: a row that CHANGED inside the overlap window is applied again', async () => {
  const customerId = dbm.uuid();
  let version = 1;
  await withEngine(({ cloud }) => {
    cloud.pullBody = () => ({
      server_time: '2026-10-18T12:00:00+00:00', next_since: '2026-10-18T11:58:00+00:00',
      operations: [{ entity_type: 'customer', entity_id: customerId, operation: 'update',
        updated_at: version === 1 ? '2026-10-18T11:59:00+00:00' : '2026-10-18T11:59:30+00:00',
        payload: { id: customerId, name: version === 1 ? 'Ada' : 'Ada Obi' } }],
    });
  }, async ({ db, engine }) => {
    await engine.pullNow(); await sleep(50);
    version = 2;
    await engine.pullNow(); await sleep(50);
    assert.equal(db.prepare(`SELECT name FROM customers WHERE id = ?`).get(customerId).name, 'Ada Obi');
  });
});

// ---- G6 ---------------------------------------------------------------------------------------

const REUSED = 'This operation id was already used for different content; it was not applied.';

test('G6: a reused-id rejection is FAILED and visible; retrying gives that row a fresh id, others keep theirs', async () => {
  await withEngine(({ db, cloud }) => {
    seedQueue(db, [{ id: 'reused', entity_type: 'customer', entity_id: 'cust-1' }, { id: 'plain', entity_type: 'customer', entity_id: 'cust-2' }]);
    cloud.pushBehavior = (ops) => ops.map((o) => (o.id === 'reused'
      ? { id: o.id, status: 'rejected', error: REUSED }
      : { id: o.id, status: 'rejected', error: 'Only the shop owner can add or change products and stock.' }));
  }, async ({ db, engine }) => {
    await settlePush(engine);
    assert.equal(row(db, 'reused').status, 'failed');
    assert.equal(row(db, 'reused').last_error, REUSED);
    assert.equal(engine.getStatus().queue.failed, 2);

    engine.stop();                                  // keep the retry below from being pushed straight away
    assert.equal(dbm.retryFailedSync(db), 2);
    assert.equal(row(db, 'reused'), undefined, 'the reused id must not be sent again');
    const renamed = db.prepare(`SELECT * FROM sync_queue WHERE entity_id = 'cust-1'`).get();
    assert.equal(renamed.status, 'pending');
    assert.notEqual(renamed.id, 'reused');
    assert.equal(row(db, 'plain').status, 'pending', 'an ordinary rejection keeps its id');
  });
});

// ---- outbox columns -----------------------------------------------------------------------------

test('outbox rows record the till and the signed-in user; acks and attempts are timestamped', async () => {
  await withEngine(({ db }) => {
    dbm.setSetting(db, 'user_profile', JSON.stringify({ username: 'ada', full_name: 'Ada' }));
    dbm.createCustomer(db, { name: 'Bola' });
  }, async ({ db, engine }) => {
    await settlePush(engine);
    const r = db.prepare(`SELECT * FROM sync_queue WHERE entity_type = 'customer'`).get();
    assert.equal(r.device_id, getOrCreateDeviceId(db));
    assert.equal(r.actor, 'ada');
    assert.equal(r.status, 'synced');
    assert.ok(r.acked_at && r.last_attempt_at, 'ack and attempt times recorded');
  });
});

test('outbox: no answer from the cloud is not an attempt (last_attempt_at stays empty)', async () => {
  await withEngine(({ db, cloud }) => { cloud.networkDown = true; seedQueue(db, [{ id: 'x', entity_type: 'sale' }]); }, async ({ db, engine }) => {
    await settlePush(engine);
    assert.equal(row(db, 'x').last_attempt_at, null);
    assert.equal(row(db, 'x').acked_at, null);
  });
});

test('outbox: an existing till database gains the new columns on open, keeping its queued rows', () => {
  const { db, dir, cleanup } = makeDb();
  try {
    seedQueue(db, [{ id: 'old-row', entity_type: 'sale' }]);
    for (const c of ['device_id', 'actor', 'last_attempt_at', 'acked_at']) db.exec(`ALTER TABLE sync_queue DROP COLUMN ${c}`);
    db.close();
    const reopened = dbm.openDb(require('path').join(dir, 'pos.db'));
    try {
      const cols = reopened.prepare(`PRAGMA table_info(sync_queue)`).all().map((c) => c.name);
      for (const c of ['device_id', 'actor', 'last_attempt_at', 'acked_at']) assert.ok(cols.includes(c), `missing ${c}`);
      const kept = reopened.prepare(`SELECT * FROM sync_queue WHERE id = 'old-row'`).get();
      assert.equal(kept.status, 'pending');
      assert.equal(kept.device_id, null);
    } finally { reopened.close(); }
  } finally { cleanup(); }
});
