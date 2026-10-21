/*
 * A real browser as the kitchen screen (REST-07), against the hub's local server:
 *
 *   pair with a code (a wrong one first) -> a ticket sent on the hub appears live (kitchen items
 *   only) -> tap to start cooking -> the Wi-Fi drops; meanwhile an item is voided and a new order
 *   is sent -> the screen catches up by itself, without a reload -> an old ticket turns red ->
 *   "All ready" -> a second screen on the same station sees the same -> the owner removes the
 *   screen and it goes back to the pairing page.
 *
 *   E2E_PLAYWRIGHT=<path to playwright-core> E2E_CHROMIUM=<chrome binary> node e2e/kitchen-screen.cjs
 * Screenshots go to E2E_SHOTS (default: the OS temp folder).
 */
const D = require('path').resolve(__dirname, '..');
require(D + '/test/_setup');
const path = require('path');
const os = require('os');
const { chromium } = require(process.env.E2E_PLAYWRIGHT || 'playwright-core');
const engine = require(D + '/src/main/restaurant/engine');
const screens = require(D + '/src/main/restaurant/screens');
const { createHubServer } = require(D + '/src/main/restaurant/server');
const { hub, ID, owner } = require(D + '/test/restaurant.helpers');

const SHOTS = process.env.E2E_SHOTS || os.tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, label, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };
async function eventually(fn, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() > until) return false;
    await sleep(100);
  }
}

(async () => {
  const { db, cleanup } = hub();
  const server = createHubServer(db, { appVersion: 'e2e' });
  const port = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|net::/.test(m.text())) errors.push(m.text()); });

    // ---- pairing ----------------------------------------------------------------------------
    await page.goto(`${base}/kds`);
    check(await eventually(() => page.isVisible('#pairForm')), 'an unpaired screen shows the pairing page');
    const { code } = screens.createPairingCode(db, { name: 'Hot pass', station_ids: [ID.kitchen] }, owner);
    await page.fill('#code', code === '111111' ? '222222' : '111111');
    await page.click('#pairForm button');
    check(await eventually(async () => /wrong or has expired/.test(await page.textContent('#pairErr'))), 'a wrong code is refused in plain words');
    await page.fill('#code', code);
    await page.click('#pairForm button');
    check(await eventually(() => page.isVisible('#emptyMsg')), 'paired: an empty kitchen screen', await page.textContent('#screenName'));
    check(await eventually(async () => (await page.textContent('#connText')) === 'Live'), 'live connection to the hub');

    // ---- a ticket arrives live ----------------------------------------------------------------
    const o = engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t1 }, owner);
    engine.addItems(db, o.id, [{ menu_item_id: ID.jollof, quantity: 2, modifiers: [ID.large], notes: 'no pepper' }, { menu_item_id: ID.chapman }], owner);
    engine.sendToKitchen(db, o.id, owner);
    server.notify();
    check(await eventually(() => page.isVisible('#cooking .card')), 'the ticket appears without a reload');
    const card = await page.textContent('#cooking .card');
    check(/Table T1/.test(card) && /Jollof rice/.test(card) && /\+ Large/.test(card) && /no pepper/.test(card) && !/Chapman/.test(card),
      'kitchen items only, with the choice and the note', card.replace(/\s+/g, ' ').trim());
    await page.screenshot({ path: path.join(SHOTS, 'kds-1-ticket.png') });

    // ---- tap to start cooking --------------------------------------------------------------------
    await page.click('#cooking .item');
    const jollofTi = () => db.prepare(`SELECT ti.* FROM r_ticket_items ti JOIN r_order_items oi ON oi.id = ti.order_item_id WHERE oi.order_id = ? AND oi.menu_item_id = ?`).get(o.id, ID.jollof);
    check(await eventually(async () => jollofTi().state === 'preparing' && /COOKING/.test(await page.textContent('#cooking .card'))), 'a tap starts cooking, on the hub and on the screen');

    // ---- the Wi-Fi drops; things change meanwhile; the screen catches up by itself -----------
    await server.close();
    check(await eventually(async () => /Reconnecting|not reachable/.test(await page.textContent('#connText'))), 'the screen shows it lost the hub');
    const jollofItem = engine.orderView(db, o.id).items.find((i) => i.menu_item_id === ID.jollof);
    engine.voidItem(db, jollofItem.id, { quantity: 1, reason: 'Guest left' }, owner);
    const o2 = engine.openOrder(db, { service_type: 'takeaway' }, owner);
    engine.addItems(db, o2.id, [{ menu_item_id: ID.jollof, modifiers: [ID.regular] }], owner);
    engine.sendToKitchen(db, o2.id, owner);
    await server.listen(port, '127.0.0.1');
    check(await eventually(async () => (await page.$$('#cooking .card')).length === 2 && /TAKEAWAY/.test(await page.textContent('#cooking')), 8000),
      'back on the Wi-Fi: the new order is there, no reload');
    check(/1 voided: Guest left/.test(await page.textContent('#cooking .card')), 'and the void shows with its reason');
    check(await eventually(async () => (await page.textContent('#connText')) === 'Live'), 'live again');
    await page.screenshot({ path: path.join(SHOTS, 'kds-2-after-drop.png') });

    // ---- an old ticket turns red -------------------------------------------------------------
    db.prepare(`UPDATE r_tickets SET sent_at = ? WHERE order_id = ?`).run(new Date(Date.now() - 25 * 60_000).toISOString(), o.id);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    check(await eventually(async () => (await page.$$('#cooking .card.late')).length === 1, 35000), 'a ticket waiting over 20 minutes turns red');

    // ---- a second screen on the same station -------------------------------------------------
    const ctx2 = await browser.newContext({ viewport: { width: 1024, height: 700 } });
    const page2 = await ctx2.newPage();
    await page2.goto(`${base}/kds`);
    const second = screens.createPairingCode(db, { name: 'Grill side', station_ids: [ID.kitchen] }, owner);
    await page2.fill('#code', second.code);
    await page2.click('#pairForm button');
    check(await eventually(async () => (await page2.$$('#cooking .card')).length === 2), 'a second screen on the station shows the same tickets');

    // ---- all ready ---------------------------------------------------------------------------
    await page.click('#cooking .card.late .bump');
    check(await eventually(async () => jollofTi().state === 'ready'), '"All ready" marks the ticket ready on the hub');
    check(await eventually(async () => (await page2.$$('#ready .card')).length === 1 && (await page2.$$('#cooking .card')).length === 1),
      'both screens move it to "Ready — waiting for the waiter"');
    await page2.screenshot({ path: path.join(SHOTS, 'kds-3-ready.png') });

    // ---- removed by the owner ----------------------------------------------------------------
    const first = screens.listScreens(db).find((s) => s.name === 'Hot pass');
    screens.revokeScreen(db, first.id, owner);
    server.notify();
    check(await eventually(async () => (await page.isVisible('#pairForm')) && /removed/.test(await page.textContent('#pairErr'))),
      'a removed screen goes back to the pairing page');
    check(await eventually(async () => (await page2.$$('#cooking .card')).length === 1), 'the other screen carries on');

    check(errors.length === 0, 'no script errors in the page', errors.join(' | '));
  } finally {
    await browser.close();
    await server.close();
    cleanup();
  }
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
