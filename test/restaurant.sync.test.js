// The hub downloads restaurant configuration only on a restaurant branch, with its own cursor.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb, login, FakeCloud, sleep } = require('./helpers');
const { startSyncEngine } = require('../src/main/sync');

function cloudAnswer(url) {
  const restaurant = url.includes('entity_types=restaurant_settings');
  return {
    operations: restaurant ? [
      { entity_type: 'kitchen_station', entity_id: 'st-1', operation: 'update', updated_at: '2026-10-21T10:00:00Z',
        payload: { id: 'st-1', name: 'Kitchen', prints: true, shows_on_screen: false, sort: 0, is_active: true } },
      { entity_type: 'menu_item', entity_id: 'it-1', operation: 'update', updated_at: '2026-10-21T10:00:00Z',
        payload: { id: 'it-1', category_id: null, name: 'Jollof rice', price: '3500.00', tax_class: 'food', is_available: true, is_active: true } },
    ] : [],
    server_time: '2026-10-21T10:00:05Z', next_since: '2026-10-21T09:58:05Z', sync_protocol: 5, has_more: false,
  };
}

async function run(modules) {
  const { db, cleanup } = makeDb();
  const cloud = new FakeCloud().install();
  cloud.pullBody = cloudAnswer;
  login(db);
  dbm.setSetting(db, 'shop_settings', JSON.stringify({ modules }));
  const engine = startSyncEngine(db, () => {});
  try {
    await engine.pullNow();
    await sleep(20);
    return {
      restaurantUrls: cloud.requests.filter((r) => r.url.includes('entity_types=restaurant_settings')).map((r) => r.url),
      restaurantRequests: cloud.requests.filter((r) => r.url.includes('entity_types=restaurant_settings')).length,
      stations: db.prepare(`SELECT name FROM r_stations`).all().map((r) => r.name),
      items: db.prepare(`SELECT name, price FROM r_items`).all().map((r) => ({ ...r })),
      cursor: dbm.getSetting(db, 'restaurant_last_pull_at'),
    };
  } finally { engine.stop(); cleanup(); await sleep(10); }
}

test('a restaurant branch pulls its menu and kitchen set-up', async () => {
  const r = await run(['restaurant', 'retail']);
  assert.ok(r.restaurantRequests >= 1);
  assert.ok(!r.restaurantUrls[0].includes('since='), 'the first restaurant pull takes everything');
  for (const later of r.restaurantUrls.slice(1)) assert.ok(later.includes('since=2026-10-21T09%3A58%3A05Z'), 'later ones resume from the saved cursor');
  assert.deepEqual(r.stations, ['Kitchen']);
  assert.deepEqual(r.items, [{ name: 'Jollof rice', price: '3500.00' }]);
  assert.equal(r.cursor, '2026-10-21T09:58:05Z', 'its own cursor, from the server clock with the overlap');
});

test('a supermarket till never asks for restaurant data', async () => {
  const r = await run(['retail']);
  assert.equal(r.restaurantRequests, 0);
  assert.deepEqual(r.stations, []);
});

test('a restaurant row that will not apply is skipped, counted in the sync status, and does not stop the rest', async () => {
  const { db, cleanup } = makeDb();
  const cloud = new FakeCloud().install();
  cloud.pullBody = (url) => {
    const body = cloudAnswer(url);
    if (url.includes('entity_types=restaurant_settings')) {
      // No group: the hub's table refuses it (NOT NULL).
      body.operations.unshift({ entity_type: 'modifier_option', entity_id: 'mo-1', operation: 'update', updated_at: '2026-10-21T10:00:00Z',
        payload: { id: 'mo-1', group_id: null, name: 'Large', price_delta: '500', is_available: true, is_active: true } });
    }
    return body;
  };
  login(db);
  dbm.setSetting(db, 'shop_settings', JSON.stringify({ modules: ['retail', 'restaurant'] }));
  const engine = startSyncEngine(db, () => {});
  try {
    await engine.pullNow();
    await sleep(20);
    assert.equal(engine.getStatus().lastPullSkipped, 1);
    assert.deepEqual(db.prepare(`SELECT name FROM r_items`).all().map((r) => r.name), ['Jollof rice']);
  } finally { engine.stop(); cleanup(); await sleep(10); }
});
