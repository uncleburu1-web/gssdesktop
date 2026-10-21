/*
 * Kitchen screens on the Wi-Fi (REST-07): pairing, the hub's local HTTP API, the live event stream
 * and catching up after a drop, station isolation, and the server starting only on the hub.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { dbm } = require('./helpers');
const engine = require('../src/main/restaurant/engine');
const screens = require('../src/main/restaurant/screens');
const { createHubServer, createLan } = require('../src/main/restaurant/server');
const { hub, ID, owner, waiter } = require('./restaurant.helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(fn, opts) {
  const h = hub(opts);
  screens.resetLock();
  const server = createHubServer(h.db, { appVersion: '9.9.9', cloudStatus: () => 'ok' });
  const port = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try { await fn({ ...h, server, port, base }); } finally { await server.close(); h.cleanup(); }
}

async function call(base, method, url, { body, token, cookie, type = 'application/json', key, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = type;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

/** A Server-Sent Events client that records every block it receives, including id-only ones. */
function stream(port, { token, lastEventId, after } = {}) {
  const out = { blocks: [], events: [], ended: false };
  const headers = { Authorization: `Bearer ${token}` };
  if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);
  const path = '/hub/v1/events' + (after !== undefined ? `?after=${after}` : '');
  let buf = '';
  const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
    out.status = res.statusCode;
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const fields = {};
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          const at = line.indexOf(':');
          fields[line.slice(0, at)] = line.slice(at + 1).trimStart();
        }
        out.blocks.push(fields);
        if (fields.event) out.events.push({ id: fields.id ? Number(fields.id) : null, type: fields.event, data: JSON.parse(fields.data || '{}') });
      }
    });
    res.on('end', () => { out.ended = true; });
  });
  req.on('error', () => { out.ended = true; });
  out.close = () => req.destroy();
  out.waitFor = async (pred, ms = 2000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (pred(out)) return true; await sleep(10); }
    return false;
  };
  return out;
}

function sendOrder(db) {
  const o = engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t1 }, owner);
  engine.addItems(db, o.id, [{ menu_item_id: ID.jollof, quantity: 2, modifiers: [ID.large] }, { menu_item_id: ID.chapman }], owner);
  engine.sendToKitchen(db, o.id, owner);
  return o;
}

async function pairKitchen(db, base, stations = [ID.kitchen]) {
  const { code } = screens.createPairingCode(db, { name: 'Pass', station_ids: stations }, owner);
  const r = await call(base, 'POST', '/hub/v1/pair', { body: { code } });
  assert.equal(r.status, 201, r.text);
  return r;
}

test('pairing: owner-only codes that work once, for 10 minutes; wrong codes lock pairing; only hashes stored', () => {
  const { db, cleanup } = hub();
  try {
    screens.resetLock();
    assert.throws(() => screens.createPairingCode(db, { name: 'Pass', station_ids: [ID.kitchen] }, waiter), { code: 'not_allowed' });
    assert.throws(() => screens.createPairingCode(db, { name: 'Pass', station_ids: ['nope'] }, owner), { code: 'unknown_station' });
    assert.throws(() => screens.createPairingCode(db, { name: 'Pass', station_ids: [ID.grill] }, owner), { code: 'unknown_station' }, 'an inactive station');

    const t0 = Date.parse('2026-10-21T12:00:00Z');
    const { code, expires_at: expires } = screens.createPairingCode(db, { name: 'Pass', station_ids: [ID.kitchen] }, owner, t0);
    assert.match(code, /^\d{6}$/);
    assert.equal(expires, '2026-10-21T12:10:00.000Z');
    const { token, screen } = screens.pair(db, code, t0 + 60_000);
    assert.equal(screen.name, 'Pass');
    assert.deepEqual(screen.station_ids, [ID.kitchen]);
    assert.throws(() => screens.pair(db, code, t0 + 61_000), { code: 'bad_code' }, 'a code works once');

    const late = screens.createPairingCode(db, { name: 'Late', station_ids: [ID.kitchen] }, owner, t0);
    assert.throws(() => screens.pair(db, late.code, t0 + 10 * 60_000 + 1), { code: 'bad_code' }, 'expired after 10 minutes');

    const dump = JSON.stringify(db.prepare(`SELECT * FROM r_screens`).all()) + JSON.stringify(db.prepare(`SELECT * FROM r_pairing_codes`).all());
    assert.ok(!dump.includes(token) && !dump.includes(code), 'neither the token nor the code is stored');
    assert.equal(screens.authenticate(db, token).id, screen.id);
    assert.equal(screens.authenticate(db, 'x'.repeat(43)), null);

    screens.resetLock();
    const good = screens.createPairingCode(db, { name: 'Bar', station_ids: [ID.bar] }, owner);
    for (let i = 0; i < screens.MAX_WRONG_CODES; i++) assert.throws(() => screens.pair(db, '000000' === good.code ? '000001' : '000000'), { code: 'bad_code' });
    assert.throws(() => screens.pair(db, good.code), { code: 'pairing_locked', status: 429 }, 'locked even for the right code');
    const afterLock = screens.pair(db, good.code, Date.now() + screens.LOCK_MS + 1000);
    assert.ok(afterLock.token, 'unlocked after a few minutes, and the right code works');

    assert.throws(() => screens.revokeScreen(db, screen.id, waiter), { code: 'not_allowed' });
    screens.revokeScreen(db, screen.id, owner);
    assert.equal(screens.authenticate(db, token), null, 'a removed screen is locked out at once');
    assert.deepEqual(db.prepare(`SELECT action FROM r_audit WHERE action LIKE 'restaurant.screen%' ORDER BY rowid`).all().map((r) => r.action),
      ['restaurant.screen_paired', 'restaurant.screen_paired', 'restaurant.screen_removed']);
  } finally { cleanup(); }
});

test('HTTP: the page, health, pairing sets a strict cookie, and a screen sees only its own stations', async () => {
  await withServer(async ({ db, base }) => {
    const page = await call(base, 'GET', '/kds');
    assert.equal(page.status, 200);
    assert.match(page.text, /Pair this screen/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);

    const health = await call(base, 'GET', '/hub/v1/health');
    assert.deepEqual([health.json.app, health.json.version, health.json.hub, health.json.cloud], ['benchline-hub', '9.9.9', true, 'ok']);
    assert.equal(health.json.tickets, undefined);

    assert.equal((await call(base, 'GET', '/hub/v1/kds/state')).json.code, 'not_paired');
    assert.equal((await call(base, 'POST', '/hub/v1/pair', { body: 'code=123456', type: 'application/x-www-form-urlencoded', raw: true })).status, 415, 'no form posts from other sites');
    assert.equal((await call(base, 'POST', '/hub/v1/pair', { body: '{nope', raw: true })).json.code, 'bad_json');

    const paired = await pairKitchen(db, base);
    const cookie = paired.headers.get('set-cookie');
    assert.match(cookie, /^bl_screen=[^;]+; Path=\/; HttpOnly; SameSite=Strict/);

    sendOrder(db);
    const s = await call(base, 'GET', '/hub/v1/kds/state', { cookie: cookie.split(';')[0] });
    assert.equal(s.status, 200);
    assert.deepEqual(s.json.screen.stations.map((x) => x.name), ['Kitchen']);
    assert.equal(s.json.tickets.length, 1, 'the bar ticket is not on the kitchen screen');
    assert.deepEqual(s.json.tickets[0].items.map((i) => [i.name, i.quantity, i.modifiers]), [['Jollof rice', 2, ['Large']]]);
    assert.ok(s.json.seq > 0);
    assert.equal((await call(base, 'GET', '/hub/v1/nothing-here')).status, 404);
  });
});

test('HTTP: changing items from a screen, with versions, idempotency keys and station isolation', async () => {
  await withServer(async ({ db, base }) => {
    const { json: { token } } = await pairKitchen(db, base);
    const o = sendOrder(db);
    const items = engine.orderView(db, o.id).items;
    const jollof = items.find((i) => i.menu_item_id === ID.jollof).tickets[0];
    const chapman = items.find((i) => i.menu_item_id === ID.chapman).tickets[0];

    const first = await call(base, 'POST', `/hub/v1/ticket-items/${jollof.ticket_item_id}/state`, { token, key: 'k-1', body: { to: 'preparing', version: 1 } });
    assert.equal(first.status, 200, first.text);
    const again = await call(base, 'POST', `/hub/v1/ticket-items/${jollof.ticket_item_id}/state`, { token, key: 'k-1', body: { to: 'preparing', version: 1 } });
    assert.deepEqual(again.json, first.json, 'the same key gives the first answer again');
    const stale = await call(base, 'POST', `/hub/v1/ticket-items/${jollof.ticket_item_id}/state`, { token, body: { to: 'ready', version: 1 } });
    assert.deepEqual([stale.status, stale.json.code, stale.json.current], [409, 'version_mismatch', { state: 'preparing', version: 2 }],
      'two cooks tapping at once: the second is told what changed');

    const bar = await call(base, 'POST', `/hub/v1/ticket-items/${chapman.ticket_item_id}/state`, { token, body: { to: 'ready' } });
    assert.deepEqual([bar.status, bar.json.code], [403, 'not_your_station']);
    const barTicket = db.prepare(`SELECT ticket_id FROM r_ticket_items WHERE id = ?`).get(chapman.ticket_item_id).ticket_id;
    assert.equal((await call(base, 'POST', `/hub/v1/tickets/${barTicket}/bump`, { token, body: {} })).json.code, 'not_your_station');

    const kitchenTicket = db.prepare(`SELECT ticket_id FROM r_ticket_items WHERE id = ?`).get(jollof.ticket_item_id).ticket_id;
    const bump = await call(base, 'POST', `/hub/v1/tickets/${kitchenTicket}/bump`, { token, body: {} });
    assert.deepEqual([bump.status, bump.json.bumped], [200, 1]);
    assert.equal(db.prepare(`SELECT state FROM r_ticket_items WHERE id = ?`).get(jollof.ticket_item_id).state, 'ready');
    assert.equal(db.prepare(`SELECT state FROM r_ticket_items WHERE id = ?`).get(chapman.ticket_item_id).state, 'queued', 'the bar item untouched');
  });
});

test('live events: only its stations, resume after a drop with Last-Event-ID, resync when too far behind, cut off when removed', async () => {
  await withServer(async ({ db, base, port, server }) => {
    const { json: { token, screen } } = await pairKitchen(db, base);
    const startSeq = (await call(base, 'GET', '/hub/v1/kds/state', { token })).json.seq;

    const live = stream(port, { token, after: startSeq });
    await live.waitFor((s) => s.status === 200);
    const o = sendOrder(db);
    server.notify();
    assert.ok(await live.waitFor((s) => s.events.some((e) => e.type === 'ticket.created')), 'a new kitchen ticket arrives live');
    const created = live.events.filter((e) => e.type === 'ticket.created');
    assert.equal(created.length, 1, 'not the bar ticket');
    assert.equal(created[0].data.type, 'ticket.created');
    assert.equal(created[0].data.data.number !== undefined, true);
    assert.equal(JSON.stringify(created[0].data).includes('1500'), false, 'events carry no prices');
    assert.ok(await live.waitFor((s) => s.blocks.length && Number(s.blocks[s.blocks.length - 1].id) >= created[0].id));
    const lastId = Number(live.blocks.filter((b) => b.id).pop().id);
    const top = db.prepare(`SELECT MAX(seq) n FROM r_events`).get().n;
    assert.equal(lastId, top, 'other stations\' events still move the resume point on (id-only message)');
    live.close();

    // While the screen is away (Wi-Fi drop), the kitchen ticket changes and a new order is sent.
    const ti = engine.orderView(db, o.id).items.find((i) => i.menu_item_id === ID.jollof).tickets[0];
    engine.setTicketItemState(db, ti.ticket_item_id, { to: 'preparing' }, owner);
    engine.addItems(db, o.id, [{ menu_item_id: ID.jollof, modifiers: [ID.regular] }], owner);
    engine.sendToKitchen(db, o.id, owner);
    const back = stream(port, { token, lastEventId: lastId });
    assert.ok(await back.waitFor((s) => s.events.filter((e) => e.type === 'ticket.created').length === 1 && s.events.some((e) => e.type === 'ticket.item_changed')),
      'everything missed is replayed on reconnect, in order');
    assert.ok(back.events.every((e, i, a) => i === 0 || e.id > a[i - 1].id));
    back.close();

    const ahead = stream(port, { token, lastEventId: top + 1000 });
    assert.ok(await ahead.waitFor((s) => s.events.some((e) => e.type === 'resync')), 'a hub log reset: the screen reloads everything');
    ahead.close();
    db.prepare(`DELETE FROM r_events WHERE seq < ?`).run(top); // the log only keeps 7 days
    const old = stream(port, { token, lastEventId: 1 });
    assert.ok(await old.waitFor((s) => s.events.some((e) => e.type === 'resync')), 'away longer than the log keeps: resync');
    old.close();

    const watching = stream(port, { token, after: top });
    await watching.waitFor((s) => s.status === 200);
    screens.revokeScreen(db, screen.id, owner);
    server.notify();
    assert.ok(await watching.waitFor((s) => s.events.some((e) => e.type === 'unpaired') && s.ended), 'a removed screen is cut off at once');
    assert.equal((await call(base, 'GET', '/hub/v1/kds/state', { token })).status, 401);
  });
});

test('the server runs only on the hub, only while a station shows on a screen; a busy port is reported', async () => {
  const notHub = hub({ hubDevice: 'another-till' });
  const lan1 = createLan(notHub.db, { port: 0, host: '127.0.0.1', checkEveryMs: 50 });
  try {
    await lan1.check();
    assert.equal(lan1.status().listening, false, 'not the hub: nothing listens');
  } finally { await lan1.stop(); notHub.cleanup(); }

  const h = hub();
  const lan = createLan(h.db, { port: 0, host: '127.0.0.1', checkEveryMs: 50 });
  try {
    await lan.check();
    assert.equal(lan.status().listening, true);
    dbm.applyPulledOperation(h.db, 'kitchen_station', 'update', { id: ID.kitchen, name: 'Kitchen', prints: true, shows_on_screen: false, is_active: true });
    await lan.check();
    assert.equal(lan.status().listening, false, 'no station shows on a screen any more: the server stops');
  } finally { await lan.stop(); h.cleanup(); }

  const blocker = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const h2 = hub();
  const lan2 = createLan(h2.db, { port: blocker.address().port, host: '127.0.0.1', checkEveryMs: 50 });
  try {
    await lan2.check();
    assert.match(lan2.status().error, /already used by another program/);
  } finally { await lan2.stop(); h2.cleanup(); blocker.close(); }
});
