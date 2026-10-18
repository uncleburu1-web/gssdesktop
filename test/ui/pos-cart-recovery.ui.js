// Drives the REAL PosScreen.jsx in headless Chromium. Optional dev check (not part of `npm test`):
//   needs `playwright` (with a browser), `esbuild`, `react`, `react-dom` resolvable from NODE_PATH.
//   node test/ui/pos-cart-recovery.ui.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const esbuild = require('esbuild');

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
  const entry = path.join(work, 'entry.jsx');
  const screen = path.resolve(__dirname, '../../src/renderer/PosScreen.jsx').replace(/\\/g, '/');
  fs.writeFileSync(entry, `
    import { createRoot } from 'react-dom/client';
    import PosScreen from '${screen}';
    createRoot(document.getElementById('root')).render(<PosScreen refreshKey={0} profile={{ username: 'alice' }} onSaleComplete={() => {}} />);
  `);
  await esbuild.build({ entryPoints: [entry], bundle: true, outfile: path.join(work, 'bundle.js'), jsx: 'automatic', loader: { '.jsx': 'jsx' }, define: { 'process.env.NODE_ENV': '"development"' }, nodePaths: (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean), logLevel: 'error' });
  fs.writeFileSync(path.join(work, 'index.html'), `<!doctype html><html><body><div id="root"></div><script>${fs.readFileSync(path.join(__dirname, 'mock-pos.js'), 'utf8')}</script><script src="bundle.js"></script></body></html>`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = 'file://' + path.join(work, 'index.html');
  const cartTitle = () => page.locator('.cart-head h3').innerText();
  const storeNow = () => page.evaluate(() => JSON.parse(localStorage.getItem('mock-till-db') || '{}'));
  const settle = () => page.waitForTimeout(700);                       // > the 400 ms autosave debounce
  const step = (msg) => console.log('  ✓ ' + msg);

  await page.goto(url);
  await page.waitForSelector('.pos-tile:has-text("Cola")');

  // 1. Ringing up a cart saves it without any button press.
  await page.locator('.pos-tile', { hasText: 'Cola' }).click();
  await page.locator('.pos-tile', { hasText: 'Cola' }).click();
  await page.locator('.pos-tile', { hasText: 'Charger' }).click();
  assert.equal(await cartTitle(), 'Cart (3)');
  await settle();
  let db = await storeNow();
  assert.equal(db.draft.lines.length, 2); assert.equal(db.draft.lines.find((l) => l.product_id === 'p1').quantity, 2);
  step('adding items autosaves the cart (no button needed)');

  // 2. POWER CUT: the page dies; only the saved "database" survives.
  await page.reload();
  await page.waitForSelector('.pos-tile:has-text("Cola")');
  await page.waitForSelector('text=Restored the sale you were in the middle of');
  assert.equal(await cartTitle(), 'Cart (3)');
  await settle();
  assert.equal((await storeNow()).draft.lines.length, 2, 'restoring must not wipe or alter the saved draft');
  step('after a crash the cart comes back exactly (Cola x2, Charger x1) with a notice, and the draft is intact');

  // 3. The empty starting cart must never overwrite a saved draft: reload twice without touching anything.
  await page.reload(); await page.waitForSelector('text=Restored the sale'); await settle();
  await page.reload(); await page.waitForSelector('text=Restored the sale'); await settle();
  assert.equal((await storeNow()).draft.lines.length, 2);
  step('reloading repeatedly without touching anything never loses the draft');

  // 4. Park it, serve someone else.
  await page.getByRole('button', { name: 'Park', exact: true }).click();
  await page.waitForSelector('button:has-text("Parked (1)")');
  assert.equal(await cartTitle(), 'Cart (0)');
  db = await storeNow(); assert.equal(db.draft, null); assert.equal(db.parked.length, 1);
  step('Park clears the screen and the active draft; one cart is parked');

  // 5. Next customer is mid-checkout when the first returns: resuming must PARK the current cart, not destroy it.
  await page.locator('.pos-tile', { hasText: 'Charger' }).click();
  await settle();
  await page.getByRole('button', { name: /Parked \(1\)/ }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.waitForSelector('.cart-head h3:has-text("Cart (3)")');
  await page.waitForSelector('button:has-text("Parked (1)")');
  db = await storeNow();
  assert.equal(db.parked.length, 1); assert.equal(db.parked[0].cart.lines[0].item_name, 'Charger');
  step('resuming swaps carts: the in-progress Charger sale was parked, not lost');

  // 6. Completing the sale must not resurrect it after a crash (the duplicate-sale hazard).
  await page.getByRole('button', { name: /exact/i }).click();
  await page.locator('.charge-btn').click();
  await page.waitForFunction(() => window.__calls.includes('createSale'));
  await settle();
  assert.equal((await storeNow()).draft, null);
  await page.reload(); await page.waitForSelector('.pos-tile:has-text("Cola")'); await settle();
  assert.equal(await cartTitle(), 'Cart (0)');
  assert.equal(await page.locator('text=Restored the sale').count(), 0);
  step('after charging, a crash and restart offers nothing to restore (no double-ringing)');

  // 7. Emptying the cart on purpose removes the draft too.
  await page.locator('.pos-tile', { hasText: 'Cola' }).click(); await settle();
  assert.ok((await storeNow()).draft);
  await page.locator('.cart-head').getByRole('button', { name: 'Clear', exact: true }).click(); await settle();
  assert.equal((await storeNow()).draft, null);
  step('clearing the cart deliberately also clears the saved draft');

  assert.deepEqual(errors, [], 'browser console/page errors: ' + errors.join(' | '));
  step('no console errors or React warnings during the whole run');
  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log('\nUI cart-recovery check: ALL PASSED');
})().catch((e) => { console.error('\nUI CHECK FAILED:', e.message); process.exit(1); });
