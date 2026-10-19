// Stage 1b regression tests: paged pull (G11), recovery after a server error (G10), paused sync on an
// ended subscription (402), the device id on the live socket, and the lighter heartbeat.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, login, seedQueue, FakeCloud, settlePush, sleep } = require('./helpers');
const { startSyncEngine } = require('../src/main/sync');
const { startHeartbeat } = require('../src/main/heartbeat');
const { getOrCreateDeviceId } = require('../src/main/device');

async function withEngine(setup, body) {
  const { db, cleanup } = makeDb();
  const cloud = new FakeCloud().install();
  login(db);
  setup && setup({ db, cloud });
  const engine = startSyncEngine(db, () => {});
  try { await body({ db, cloud, engine }); } finally { engine.stop(); cleanup(); await sleep(10); }
}
const row = (db, id) => db.prepare(`SELECT * FROM sync_queue WHERE id = ?`).get(id);

function pagedCloud(cloud, customers, pageSize) {
  cloud.pullBody = (url) => {
    const params = new URL(url).searchParams;
    const start = Number(params.get('cursor') || 0);
    const page = customers.slice(start, start + pageSize);
    const more = start + pageSize < customers.length;
    return {
      operations: page.map((c) => ({ entity_type: 'customer', entity_id: c.id, operation: 'update', updated_at: '2026-10-19T08:00:00+00:00', payload: c })),
      server_time: '2026-10-19T08:00:00+00:00', next_since: '2026-10-19T07:58:00+00:00', sync_protocol: 2,
      has_more: more, next_cursor: more ? String(start + pageSize) : null,
    };
  };
}

test('G11: a pull follows every page and only then moves its cursor', async () => {
  const customers = Array.from({ length: 23 }, (_, i) => ({ id: dbm.uuid(), name: `C${i}` }));
  await withEngine(({ cloud }) => pagedCloud(cloud, customers, 5), async ({ db, cloud, engine }) => {
    await sleep(150);                                              // let the startup pull finish
    cloud.requests = [];
    await engine.pullNow(); await sleep(80);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM customers`).get().n, 23);
    const pulls = cloud.requests.filter((r) => r.url.includes('/sync/pull/'));
    assert.equal(pulls.length, 5, 'five pages of five');
    assert.ok(pulls.every((r) => r.url.includes('limit=500')));
    assert.equal(dbm.getLastPullAt(db), '2026-10-19T07:58:00+00:00');
  });
});

test('G11: a pull that fails part-way does not advance the cursor', async () => {
  const customers = Array.from({ length: 10 }, (_, i) => ({ id: dbm.uuid(), name: `C${i}` }));
  await withEngine(({ cloud, db }) => { pagedCloud(cloud, customers, 4); dbm.setLastPullAt(db, '2026-10-01T00:00:00+00:00'); }, async ({ db, cloud, engine }) => {
    await engine.pullNow(); await sleep(50);                       // startup pull completes
    dbm.setLastPullAt(db, '2026-10-01T00:00:00+00:00');
    const original = cloud.pullBody;
    let calls = 0;
    cloud.pullBody = (url) => { calls += 1; if (calls === 2) { cloud.pullHttpStatus = 500; } return original(url); };
    await engine.pullNow(); await sleep(80);
    cloud.pullHttpStatus = 200;
    assert.equal(dbm.getLastPullAt(db), '2026-10-01T00:00:00+00:00', 'cursor untouched after a broken run');
  });
});

test('G10: after the cloud recovers, rows it had backed off are sent again at once', async () => {
  await withEngine(({ db, cloud }) => { cloud.pushHttpStatus = 503; seedQueue(db, [{ id: 'a', entity_type: 'sale' }]); }, async ({ db, cloud, engine }) => {
    await settlePush(engine);
    assert.ok(row(db, 'a').next_attempt_at, 'backed off after the 503');
    cloud.pushHttpStatus = 200;
    seedQueue(db, [{ id: 'new-sale', entity_type: 'sale' }]);       // the next sale rung up goes through...
    await settlePush(engine);
    await settlePush(engine);                                       // ...and the backed-off one follows straight away
    assert.equal(row(db, 'a').status, 'synced');
  });
});

test('402 (subscription ended) pauses sync: nothing counted, nothing lost, a clear message', async () => {
  await withEngine(({ db, cloud }) => { cloud.pushHttpStatus = 402; seedQueue(db, [{ id: 'a', entity_type: 'sale' }]); }, async ({ db, engine }) => {
    await settlePush(engine);
    const r = row(db, 'a');
    assert.equal(r.status, 'pending');
    assert.equal(r.retry_count, 0);
    assert.equal(r.next_attempt_at, null);
    assert.equal(engine.getStatus().cloudSync.state, 'paused');
  });
});

test('the live socket carries this till\'s device id', async () => {
  const urls = [];
  const Original = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor(url) { urls.push(url); throw new Error('no sockets in tests'); } };
  try {
    await withEngine(null, async ({ db }) => {
      await sleep(30);
      assert.ok(urls.length > 0);
      assert.ok(urls[0].includes(`&device=${getOrCreateDeviceId(db)}`), urls[0]);
    });
  } finally { globalThis.WebSocket = Original; }
});

test('heartbeat: skipped while the socket is live and nothing changed; sent when counts change or the socket drops', async () => {
  const { db, cleanup } = makeDb();
  const cloud = new FakeCloud().install();
  login(db);
  let live = true;
  let counts = { pending: 0, failed: 0 };
  const hb = startHeartbeat(db, { deviceName: 'T', isLiveConnected: () => live, queueStats: () => counts });
  const beats = () => cloud.requests.filter((r) => r.url.endsWith('/devices/heartbeat/')).length;
  try {
    await sleep(30);
    assert.equal(beats(), 1, 'first tick always reports');
    await hb.tick(); await sleep(10);
    assert.equal(beats(), 1, 'live + unchanged = no request');
    counts = { pending: 3, failed: 0 };
    await hb.tick(); await sleep(10);
    assert.equal(beats(), 2, 'counts changed = report them');
    live = false;
    await hb.tick(); await sleep(10);
    assert.equal(beats(), 3, 'socket down = heartbeat over HTTP');
  } finally { hb.stop(); cleanup(); await sleep(10); }
});
