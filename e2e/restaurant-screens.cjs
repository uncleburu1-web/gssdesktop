/*
 * The hub till's restaurant screens (REST-11), in a real browser, against the real restaurant engine:
 * the built renderer (renderer-dist) is served to Chromium and window.pos is bridged to the same
 * ipc.js handler the Electron app uses, on a configured hub database (test/restaurant.helpers).
 *
 *   floor -> open table T1 (guests) -> Jollof with a required choice and a note, Chapman twice ->
 *   send -> printer-only Chapman served from the pass; Jollof refused until the kitchen marks it
 *   ready -> a kitchen screen marks it ready -> the floor shows READY by itself -> serve -> print the
 *   bill -> cash with change -> receipt printed, table free -> kitchen tab shows unprinted tickets ->
 *   set-up: station printer, pair a kitchen screen with the code shown -> sold out -> a waiter sees
 *   no payment button -> a cook lands on the kitchen -> a till that is not the hub explains why.
 *   A restaurant branch's till is restaurant-first: it opens on the floor and its menu is the
 *   restaurant's (Floor, Kitchen, Sold out, Set-up, Stock, Shift, Day report, Printer), no shop selling.
 *
 *   npx vite build && E2E_PLAYWRIGHT=<playwright-core> E2E_CHROMIUM=<chrome> node e2e/restaurant-screens.cjs
 */
const D = require('path').resolve(__dirname, '..');
require(D + '/test/_setup');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require(process.env.E2E_PLAYWRIGHT || 'playwright-core');
const { dbm } = require(D + '/test/helpers');
const ipc = require(D + '/src/main/restaurant/ipc');
const engine = require(D + '/src/main/restaurant/engine');
const { hub, ID, kitchenScreen } = require(D + '/test/restaurant.helpers');

const SHOTS = process.env.E2E_SHOTS || os.tmpdir();
const DIST = path.join(D, 'renderer-dist');
let fails = 0;
const check = (ok, label, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() > until) return false; await sleep(100); }
}

const OWNER = { username: 'ada', full_name: 'Ada Owner', is_owner: true, role: 'owner', capabilities: {}, shop_name: 'Mama Put', shop_address: '12 Allen Avenue, Ikeja', modules: ['retail', 'restaurant'] };
const WAITER = { username: 'wale', full_name: 'Wale', is_owner: false, role: 'waiter', shop_name: 'Mama Put', modules: ['retail', 'restaurant'],
  capabilities: { take_orders: true, send_to_kitchen: true, move_table: true } };
const COOK = { username: 'tunde', full_name: 'Tunde', is_owner: false, role: 'kitchen', shop_name: 'Mama Put', modules: ['retail', 'restaurant'],
  capabilities: { mark_sold_out: true } };
const nav = (page) => page.$$eval('button[data-nav]', (bs) => bs.map((b) => b.textContent.trim()).join(','));

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('Run `npx vite build` first.'); process.exit(2); }
  const { db, cleanup } = hub();
  dbm.setSetting(db, 'user_profile', JSON.stringify(OWNER));
  dbm.openShift(db, 'ada', 5000);
  const profile = { current: OWNER };
  let handler;
  const { lan } = ipc.register({
    ipcMain: { handle: (ch, fn) => { handler = fn; } }, database: db, auth: { getUserProfile: () => profile.current },
    BrowserWindow: class { constructor() { this.webContents = { once: () => {}, print: () => {} }; } loadURL() { return Promise.resolve(); } isDestroyed() { return true; } destroy() {} },
    appVersion: 'e2e', lanOptions: { port: 0, host: '127.0.0.1', checkEveryMs: 200 },
  });

  // The app's other window.pos calls, answered as a quiet, online till would.
  const STUBS = {
    isLoggedIn: () => true, getProfile: () => profile.current, pendingSyncCount: () => 0, paymentMethods: () => ['cash', 'transfer', 'pos', 'mobile'],
    syncStatus: () => ({ liveConnected: true, lastPullAt: new Date().toISOString(), queue: { pending: 0, failed: 0 }, cloudSync: { state: 'ok' } }),
    listPrinters: () => [{ name: 'XP-80 Kitchen', displayName: 'XP-80 Kitchen' }, { name: 'EPSON TM-T20', displayName: 'EPSON TM-T20', isDefault: true }],
    restaurant: (...args) => handler(null, ...args),
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/rpc') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const { name, args } = JSON.parse(body);
        const fn = STUBS[name];
        let out = fn ? await fn(...args) : (name.startsWith('list') ? [] : null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out === undefined ? null : out));
      });
      return;
    }
    const file = path.join(DIST, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(fs.readFileSync(file));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
    page.on('response', (r) => { if (r.status() === 404 && !/favicon/.test(r.url())) errors.push(`404: ${r.url()}`); });
    await page.addInitScript(() => {
      window.__prints = [];
      const call = (name, args) => fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }) }).then((r) => r.json());
      window.pos = new Proxy({}, {
        get: (_, name) => {
          if (name === 'onDataChanged') return () => () => {};
          if (name === 'printReceipt') return () => { const el = document.querySelector('.receipt-print'); window.__prints.push(el ? el.innerText : ''); return Promise.resolve({ ok: true }); };
          return (...args) => call(name, args);
        },
      });
    });
    const text = (sel) => page.textContent(sel);
    const prints = () => page.evaluate(() => window.__prints);
    page.setDefaultTimeout(8000);
    try {

    // ---- floor ----------------------------------------------------------------------------------
    await page.goto(base + '/');
    check(await eventually(async () => (await nav(page)) === 'Floor,Kitchen,Sold out,Set-up,Stock,Shift,Day report,Printer'),
      'a restaurant branch\'s till has the restaurant\'s own menu (no Sell, Customers or Sales history)', await nav(page));
    check(await eventually(() => page.isVisible('[data-table="T1"]')) && (await text('.r-title')) === 'Floor', 'it opens on the floor, showing the tables');
    await page.click('[data-table="T1"]');
    await page.click('.modal .r-option:has-text("3")');
    await page.click('.modal button:has-text("Open table")');
    check(await eventually(() => page.isVisible('.r-panel-head:has-text("Table T1")')), 'opening table T1 for 3 guests opens its order', await text('.r-panel-head'));

    // ---- ordering ---------------------------------------------------------------------------------
    await page.click('[data-item="Jollof rice"]');
    check(await eventually(() => page.isVisible('.modal >> text=Size')), 'Jollof asks for its choices');
    check(await page.isDisabled('.modal button:has-text("Add")'), 'cannot add it until the required size is chosen');
    await page.click('.modal .r-option:has-text("Large")');
    await page.fill('.modal input', 'no pepper');
    await page.click('.modal button:has-text("Add")');
    await page.click('.r-cat:has-text("Drinks")');
    await page.click('[data-item="Chapman"]');
    await eventually(async () => (await text('.r-panel-body')).includes('Chapman'));
    await page.click('[data-item="Chapman"]');
    check(await eventually(async () => /Chapman[\s\S]*2/.test(await text('.r-panel-body')) && (await page.$$('.r-panel-body .r-line')).length === 2),
      'tapping Chapman twice makes one line of 2, Jollof with Large and the note');
    await page.screenshot({ path: path.join(SHOTS, 'hub-1-order.png') });
    await page.click('button:has-text("Send 3 to the kitchen")');
    check(await eventually(async () => (await text('.r-panel-body')).includes('Sent') && !(await text('.r-panel-body')).includes('Not sent yet')), 'sent to the kitchen');

    // ---- serving ---------------------------------------------------------------------------------
    await page.click('[data-line="Jollof rice"] button:has-text("Served")');
    check(await eventually(async () => (await text('.r-error')).includes('kitchen has not finished')), 'Jollof cannot be served before the kitchen marks it ready');
    await page.click('[data-line="Chapman"] button:has-text("Served")');
    check(await eventually(async () => (await text('[data-line="Chapman"]')).includes('Served')), 'the Bar only prints: Chapman is served straight from the pass');
    await page.click('button:has-text("← Floor")');
    const order = engine.tablesView(db).find((t) => t.label === 'T1');
    const ti = engine.orderView(db, order.order_id).items.find((i) => i.name === 'Jollof rice').tickets[0];
    engine.setTicketItemState(db, ti.ticket_item_id, { to: 'ready' }, kitchenScreen); // the kitchen screen taps "ready"
    check(await eventually(() => page.isVisible('[data-table="T1"] .r-flag.ready')), 'the floor shows READY on T1 by itself');
    await page.screenshot({ path: path.join(SHOTS, 'hub-2-floor-ready.png') });
    await page.click('[data-table="T1"]');
    await page.click('[data-line="Jollof rice"] button:has-text("Served")');
    check(await eventually(async () => (await text('.r-panel-head')).includes('Served')), 'Jollof served; the order shows everything served');

    // ---- bill and payment -------------------------------------------------------------------------
    await page.click('button:has-text("Print bill")');
    check(await eventually(async () => (await prints()).some((p) => /BILL/.test(p) && /TOTAL\s*₦8,225\.00/.test(p))),
      'the bill prints: 4,000 + 3,000 + service 700 + VAT 525 = ₦8,225.00', ((await prints()).slice(-1)[0] || '').replace(/\s+/g, ' ').slice(0, 160));
    check(await eventually(async () => (await text('[data-total]')) === '₦8,225.00'), 'the pad shows the bill total');
    await page.click('button:has-text("Take payment")');
    await page.fill('.modal input[placeholder="e.g. 12000"]', '10000');
    check(await eventually(async () => (await text('.modal')).includes('₦1,775.00')), 'cash: the change is shown before taking it (₦1,775.00)');
    await page.screenshot({ path: path.join(SHOTS, 'hub-3-payment.png') });
    await page.click('.modal button:has-text("Take ₦")');
    check(await eventually(async () => (await page.isVisible('text=paid and closed')) && (await text('.r-notice')).includes('₦1,775.00')), 'paid: order closed, change to give shown');
    check(await eventually(async () => (await prints()).some((p) => /RECEIPT/.test(p) && /Change\s*₦1,775\.00/.test(p))), 'the receipt prints with the change');
    await page.click('text=Back to the floor');
    check(await eventually(async () => (await page.getAttribute('[data-table="T1"]', 'class')).includes('free')), 'T1 is free again');

    // ---- kitchen tab: tickets that did not print -------------------------------------------------
    await page.click('button[data-nav]:has-text("Kitchen")');
    check(await eventually(async () => (await text('.section')).includes('Not printed') && (await text('.section')).includes('No printer chosen')),
      'the Kitchen tab lists tickets that did not print (no printer chosen yet) with a reprint button');

    // ---- set-up: station printer and a kitchen screen ------------------------------------------
    await page.click('button[data-nav]:has-text("Set-up")');
    await page.selectOption('select[aria-label="Printer for Kitchen"]', 'XP-80 Kitchen');
    check(await eventually(async () => dbm.getSetting(db, `station_printer:${ID.kitchen}`) === 'XP-80 Kitchen'), 'the Kitchen station now prints to XP-80 on this PC');
    await lan.check();
    await page.click('button:has-text("Add a kitchen screen")');
    await page.fill('.modal input', 'Hot pass tablet');
    await page.click('.modal .r-option:has-text("Kitchen")');
    await page.click('button:has-text("Get a pairing code")');
    check(await eventually(async () => /^\d{6}$/.test((await text('[data-code]')).trim())), 'a 6-digit pairing code is shown');
    const code = (await text('[data-code]')).trim();
    const url = (await text('.modal .r-url')).trim();
    // The address shown is this PC's network address; this test's server listens on 127.0.0.1 only, same port.
    const kds = await fetch(url.replace(/^http:\/\/[^:/]+/, 'http://127.0.0.1').replace('/kds', '/hub/v1/pair'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    check(kds.status === 201, 'a kitchen screen pairs with that code at the address shown', url);
    await page.screenshot({ path: path.join(SHOTS, 'hub-4-pairing.png') });
    await page.click('.modal button:has-text("Done")');
    check(await eventually(async () => (await text('.section:has-text("Kitchen screens")')).includes('Hot pass tablet')), 'the paired screen is listed and can be removed');

    // ---- sold out ------------------------------------------------------------------------------------
    await page.click('button[data-nav]:has-text("Sold out")');
    await page.click('.r-list-row:has-text("Chapman") button');
    await page.click('button[data-nav]:has-text("Floor")');
    await page.click('button:has-text("New takeaway")');
    await page.click('.r-cat:has-text("Drinks")');
    check(await eventually(async () => (await page.isDisabled('[data-item="Chapman"]')) && (await text('[data-item="Chapman"]')).includes('Sold out')), 'Chapman marked sold out cannot be ordered');

    // ---- a waiter ------------------------------------------------------------------------------------
    profile.current = WAITER;
    await page.reload();
    check(await eventually(async () => (await nav(page)) === 'Floor,Kitchen,Stock,Shift,Day report,Printer'), 'a waiter\'s menu: no Sold out or Set-up', await nav(page));
    check((await text('.nav-footer')).includes('Waiter'), 'the till shows the role as Waiter');
    await page.click('.r-order-row');
    await page.click('.r-cat:has-text("Mains")');
    await page.click('[data-item="Suya"]');
    check(await eventually(async () => (await text('.r-panel-body')).includes('Suya')), 'a waiter takes the order');
    check(!(await page.isVisible('button:has-text("Take payment")')) && !(await page.isVisible('button:has-text("Discount")')), 'a waiter sees no payment or discount buttons');

    // ---- a cook ----------------------------------------------------------------------------------------
    profile.current = COOK;
    await page.reload();
    check(await eventually(async () => (await text('.r-title')) === 'Kitchen'), 'a cook lands on the kitchen');

    // ---- not the hub ---------------------------------------------------------------------------------
    profile.current = OWNER;
    db.prepare(`UPDATE r_settings SET hub_device_id = 'another-till'`).run();
    await page.reload();
    check(await eventually(() => page.isVisible('text=Orders are taken on the restaurant hub')), 'a till that is not the hub explains where orders are taken');

    // ---- the branch stops being a restaurant: the shop till comes back -------------------------------
    const shop = JSON.parse(dbm.getSetting(db, 'shop_settings') || '{}');
    dbm.setSetting(db, 'shop_settings', JSON.stringify({ ...shop, modules: ['retail'] }));
    profile.current = { ...OWNER, modules: ['retail'] };
    await page.reload();
    check(await eventually(async () => (await nav(page)) === 'Sell,Products,Customers,Sales history,Shift,Day report,Printer'),
      'a shop\'s till keeps the shop menu', await nav(page));

    check(errors.length === 0, 'no script errors in the app', errors.join(' | ').slice(0, 300));
    } catch (e) {
      fails++;
      console.log('FAIL  stopped:', e.message.split('\n')[0]);
      console.log('      page errors:', errors.join(' | ').slice(0, 600));
      console.log('      page text:', (await page.textContent('body')).replace(/\s+/g, ' ').slice(0, 600));
      await page.screenshot({ path: path.join(SHOTS, 'hub-fail.png') });
    }
  } finally {
    await browser.close();
    server.close();
    await lan.stop();
    cleanup();
  }
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
