const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, login, seedQueue, queueCount, FakeCloud, settlePush, sleep } = require('./helpers');
const { startSyncEngine } = require('../src/main/sync');
const { getStoredTokens } = require('../src/main/auth');

// Every test: fresh DB, fresh fake cloud, engine started AFTER seeding, always stopped.
async function withEngine(setup, body) {
  const { db, cleanup } = makeDb();
  const cloud = new FakeCloud().install();
  login(db);
  setup && setup({ db, cloud });
  const engine = startSyncEngine(db, () => {});
  try { await body({ db, cloud, engine }); }
  finally { engine.stop(); cleanup(); await sleep(10); }
}

const rowsOf = (db, ids) => ids.map((id) => db.prepare(`SELECT * FROM sync_queue WHERE id = ?`).get(id));

test('D-05: overlapping pushNow() calls never run concurrently and never send a row twice', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `op-${i}`);
  await withEngine(({ db, cloud }) => { cloud.delayMs = 40; seedQueue(db, ids.map((id) => ({ id, entity_type: 'sale' }))); }, async ({ db, cloud, engine }) => {
    await Promise.all([engine.pushNow(), engine.pushNow(), engine.pushNow(), engine.pushNow(), engine.pushNow()]);
    await sleep(250);
    assert.equal(cloud.maxPushInFlight, 1);
    const sent = cloud.pushRequests.flat();
    assert.equal(new Set(sent).size, sent.length, 'a row was sent more than once');
    assert.equal(queueCount(db, 'synced'), 10);
  });
});

test('D-09: a 120-row backlog drains in ONE run (it used to take one 25-row batch per 15s tick)', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `bulk-${i}`);
  await withEngine(({ db }) => seedQueue(db, ids.map((id) => ({ id, entity_type: 'sale' }))), async ({ db, cloud, engine }) => {
    await settlePush(engine);
    assert.equal(queueCount(db, 'synced'), 120);
    assert.ok(cloud.pushRequests.length > 1, 'expected several batches');
  });
});

test('D-10: being offline does not burn attempts, and the very next push after recovery goes through', async () => {
  await withEngine(({ db, cloud }) => { cloud.networkDown = true; seedQueue(db, [{ id: 'a', entity_type: 'sale' }, { id: 'b', entity_type: 'sale' }]); }, async ({ db, cloud, engine }) => {
    await settlePush(engine);
    for (const row of rowsOf(db, ['a', 'b'])) {
      assert.equal(row.status, 'pending');
      assert.equal(row.retry_count, 0, 'offline must not count as a failed attempt');
      assert.equal(row.next_attempt_at, null, 'offline must not schedule a backoff');
    }
    assert.equal(engine.getStatus().cloudSync.state, 'offline');

    cloud.networkDown = false;
    await settlePush(engine);
    assert.equal(queueCount(db, 'synced'), 2);
    assert.equal(engine.getStatus().cloudSync.state, 'ok');
  });
});

test('a 5xx from the server IS a counted attempt with a backoff', async () => {
  await withEngine(({ db, cloud }) => { cloud.pushHttpStatus = 503; seedQueue(db, [{ id: 'a', entity_type: 'sale' }]); }, async ({ db, engine }) => {
    await settlePush(engine);
    const [row] = rowsOf(db, ['a']);
    assert.equal(row.status, 'pending');
    assert.equal(row.retry_count, 1);
    assert.ok(new Date(row.next_attempt_at) > new Date());
    assert.equal(engine.getStatus().cloudSync.state, 'degraded');
  });
});

test('a 404 (cloud not upgraded yet) is "unsupported": nothing is burned, nothing is lost', async () => {
  await withEngine(({ db, cloud }) => { cloud.pushHttpStatus = 404; seedQueue(db, [{ id: 'a', entity_type: 'sale' }]); }, async ({ db, engine }) => {
    await settlePush(engine);
    const [row] = rowsOf(db, ['a']);
    assert.equal(row.status, 'pending');
    assert.equal(row.retry_count, 0);
    assert.equal(engine.getStatus().cloudSync.state, 'unsupported');
  });
});

test('D-06: a rejection is kept as FAILED with the SERVER\'s real error text, and is surfaced in the status', async () => {
  const why = 'Only the shop owner can add or change products and stock.';
  await withEngine(({ db, cloud }) => {
    cloud.pushBehavior = (ops) => ops.map((o) => ({ id: o.id, status: 'rejected', error: why }));
    seedQueue(db, [{ id: 'a', entity_type: 'product' }]);
  }, async ({ db, engine }) => {
    await settlePush(engine);
    const [row] = rowsOf(db, ['a']);
    assert.equal(row.status, 'failed');
    assert.equal(row.last_error, why);
    assert.deepEqual(dbm.getSyncQueueStats(db), { pending: 0, failed: 1 });
    assert.equal(engine.getStatus().queue.failed, 1);
  });
});

test('D-04: ops the server defers cannot starve the queue behind them', async () => {
  const stuck = Array.from({ length: 30 }, (_, i) => ({ id: `stuck-${i}`, entity_type: 'sale_item' }));
  const good = Array.from({ length: 10 }, (_, i) => ({ id: `good-${i}`, entity_type: 'sale' }));
  await withEngine(({ db, cloud }) => {
    // Server omits a deferred op from `results` entirely (its legacy contract for "retry later").
    cloud.pushBehavior = (ops) => ops.filter((o) => o.entity_type !== 'sale_item').map((o) => ({ id: o.id, status: 'applied' }));
    seedQueue(db, [...stuck, ...good]);
  }, async ({ db, engine }) => {
    await settlePush(engine);
    assert.equal(queueCount(db, 'synced'), 10, 'healthy sales were stuck behind deferred rows');
    const sample = rowsOf(db, ['stuck-0'])[0];
    assert.equal(sample.status, 'pending');             // deferred, NOT failed: its parent may just be slow
    assert.ok(sample.retry_count >= 1 && new Date(sample.next_attempt_at) > new Date());
  });
});

test('D-15: a rotated refresh token is stored, and the retried push uses the new access token', async () => {
  await withEngine(({ db, cloud }) => {
    cloud.unauthorizedOnce = true;
    cloud.refreshBody = { access: 'access-NEW', refresh: 'refresh-NEW' };
    seedQueue(db, [{ id: 'a', entity_type: 'sale' }]);
  }, async ({ db, cloud, engine }) => {
    await settlePush(engine);
    assert.equal(getStoredTokens(db).refresh, 'refresh-NEW');
    assert.equal(cloud.authHeaders.at(-1), 'Bearer access-NEW');
    assert.equal(queueCount(db, 'synced'), 1);
  });
});

test('D-15: when the session can no longer be refreshed the till says so, and burns nothing', async () => {
  await withEngine(({ db, cloud }) => { cloud.pushHttpStatus = 401; cloud.refreshStatus = 401; seedQueue(db, [{ id: 'a', entity_type: 'sale' }]); }, async ({ db, engine }) => {
    await settlePush(engine);
    const [row] = rowsOf(db, ['a']);
    assert.equal(row.retry_count, 0);
    assert.equal(row.status, 'pending');
    assert.equal(engine.getStatus().cloudSync.state, 'auth_required');
  });
});

test('D-09/D-11: concurrent pulls are single-flight', async () => {
  await withEngine(({ cloud }) => { cloud.pullDelayMs = 50; }, async ({ cloud, engine }) => {
    await sleep(120);                                   // let the startup pull finish
    cloud.maxPullInFlight = 0;
    await Promise.all([engine.pullNow(), engine.pullNow(), engine.pullNow()]);
    await sleep(200);
    assert.equal(cloud.maxPullInFlight, 1);
  });
});

test('D-11: one bad pulled row cannot freeze the pull forever', async () => {
  await withEngine(({ db, cloud }) => {
    const { product } = require('./helpers').seedProduct(db, { qty: 0 });
    cloud.pullBody = {
      server_time: '2026-10-04T12:00:00.000Z',
      operations: [
        { entity_type: 'sale_item', operation: 'create', payload: null },                       // poison: payload.id throws
        { entity_type: 'product', operation: 'create', payload: { id: dbm.uuid(), name: 'Good product', sell_price: '5.00' } },
      ],
    };
  }, async ({ db, engine }) => {
    await engine.pullNow(); await sleep(100);
    assert.equal(dbm.getLastPullAt(db), '2026-10-04T12:00:00.000Z', 'cursor must advance past a poison row');
    assert.ok(db.prepare(`SELECT 1 FROM products WHERE name = 'Good product'`).get(), 'the good row after it must still apply');
  });
});

test('Scenario 3: the server applied the batch but the response was lost; the retry is acknowledged, nothing is applied twice', async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `sale-${i}`);
  await withEngine(({ db, cloud }) => { cloud.dropResponseOnce = true; seedQueue(db, ids.map((id) => ({ id, entity_type: 'sale' }))); }, async ({ db, cloud, engine }) => {
    // The engine starts, pushes (server applies the batch, the response is lost), notices the next
    // pull works, and re-sends the SAME rows straight away; no waiting for a backoff.
    await settlePush(engine);
    await sleep(200);

    assert.ok(cloud.pushRequests.length >= 2, 'expected a retry after the lost response');
    assert.deepEqual([...cloud.pushRequests[1]].sort(), [...cloud.pushRequests[0]].sort(), 'the retry must re-send the same rows');
    assert.equal(cloud.applied.size, 6, 'a row was applied a second time');
    assert.equal(queueCount(db, 'synced'), 6);
    for (const row of rowsOf(db, ids)) assert.equal(row.retry_count, 0, 'a lost response is not the rows\' fault');
  });
});

test('Scenario 5: 500 sales (2,000 operations) queued offline all drain in one run after reconnect', async () => {
  const specs = [];
  for (let i = 0; i < 500; i += 1) {
    specs.push({ id: `sale-${i}`, entity_type: 'sale' });
    for (let j = 0; j < 3; j += 1) specs.push({ id: `line-${i}-${j}`, entity_type: 'sale_item' });
  }
  await withEngine(({ db, cloud }) => { cloud.networkDown = true; seedQueue(db, specs); }, async ({ db, cloud, engine }) => {
    await settlePush(engine);
    assert.equal(queueCount(db, 'pending'), 2000);               // offline: everything waits, nothing is burned
    assert.equal(db.prepare(`SELECT MAX(retry_count) AS n FROM sync_queue`).get().n, 0);

    cloud.networkDown = false;
    const started = Date.now();
    await settlePush(engine);
    assert.equal(queueCount(db, 'synced'), 2000);
    assert.ok(cloud.pushRequests.length <= 40, `took ${cloud.pushRequests.length} requests`);
    assert.ok(cloud.pushRequests.every((batch) => batch.length <= 100));
    assert.ok(Date.now() - started < 15_000);
  });
});
