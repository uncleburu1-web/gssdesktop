// Drives the REAL App.jsx sidebar and SalesHistoryScreen.jsx in headless Chromium.
//   node test/ui/sidebar-and-history.ui.js   (same prerequisites as pos-cart-recovery.ui.js)
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const esbuild = require('esbuild');

const rend = (f) => path.resolve(__dirname, '../../src/renderer', f).replace(/\\/g, '/');
async function makePage(browser, work, name, body) {
  const entry = path.join(work, `${name}.jsx`);
  fs.writeFileSync(entry, `import { createRoot } from 'react-dom/client';\n${body}`);
  await esbuild.build({ entryPoints: [entry], bundle: true, outfile: path.join(work, `${name}.js`), jsx: 'automatic', loader: { '.jsx': 'jsx' }, define: { 'process.env.NODE_ENV': '"development"' }, nodePaths: (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean), logLevel: 'error' });
  const mocks = ['mock-pos.js', 'mock-app.js'].map((f) => `<script>${fs.readFileSync(path.join(__dirname, f), 'utf8')}</script>`).join('');
  fs.writeFileSync(path.join(work, `${name}.html`), `<!doctype html><html><body><div id="root"></div>${mocks}<script src="${name}.js"></script></body></html>`);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + path.join(work, `${name}.html`));
  return { page, errors };
}
const step = (msg) => console.log('  ✓ ' + msg);

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
  const browser = await chromium.launch();

  // ------------------------------------------------------------------ sidebar
  {
    const { page, errors } = await makePage(browser, work, 'app', `import App from '${rend('App.jsx')}';\ncreateRoot(document.getElementById('root')).render(<App />);`);
    const setSync = (patch) => page.evaluate((p) => Object.assign(window.__sync, p), patch);
    await page.waitForSelector('text=All changes synced');
    step('healthy till: "All changes synced", no warnings');
    assert.equal(await page.locator('text=Offline. Sales are saved').count(), 0);

    await setSync({ queue: { pending: 3, failed: 0 } });
    await page.waitForSelector('text=3 changes waiting to sync');
    assert.equal(await page.locator('text=All changes synced').count(), 0);
    step('3 pending: says "3 changes waiting to sync" (never "All changes synced")');

    await setSync({ queue: { pending: 0, failed: 2 }, lastPushError: { last_error: 'Only the shop owner can add or change products and stock.' } });
    const retry = page.getByRole('button', { name: /2 changes could not sync/ });
    await retry.waitFor();
    assert.equal(await page.locator('text=All changes synced').count(), 0, 'failed changes must NEVER read as "All changes synced"');
    assert.match(await retry.getAttribute('title'), /Only the shop owner/);
    step('2 failed, 0 pending: red retry button, reason in tooltip, and NOT "All changes synced" (the old bug)');

    await retry.click();
    await page.waitForSelector('text=2 changes waiting to sync');
    assert.equal(await page.getByRole('button', { name: /could not sync/ }).count(), 0);
    assert.ok((await page.evaluate(() => window.__calls)).includes('retryFailedSync'));
    step('tapping retry re-queues them: button disappears, "2 changes waiting to sync"');

    await setSync({ queue: { pending: 0, failed: 0 }, cloudSync: { state: 'offline', message: 'No internet connection.' } });
    await page.waitForSelector('text=Offline. Sales are saved on this till');
    step('offline: explains that sales are safe on the till and will upload automatically');
    await setSync({ cloudSync: { state: 'auth_required', message: 'Your session expired. Sign in while online to resume syncing.' } });
    await page.waitForSelector('text=Sign in while online to resume syncing');
    step('expired session: tells the cashier exactly what to do');
    await setSync({ cloudSync: { state: 'ok', message: '' } });
    await page.waitForFunction(() => !document.body.innerText.includes('Sign in while online'));
    step('recovered: the warning goes away on its own');
    assert.deepEqual(errors, [], errors.join(' | '));
    await page.close();
  }

  // ------------------------------------------------------------- sales history
  {
    const { page, errors } = await makePage(browser, work, 'history', `import SalesHistoryScreen from '${rend('SalesHistoryScreen.jsx')}';\ncreateRoot(document.getElementById('root')).render(<SalesHistoryScreen refreshKey={0} profile={{ capabilities: {} }} />);`);
    await page.waitForSelector('tbody tr');
    assert.equal(await page.locator('tbody tr').count(), 100);
    const more = page.getByRole('button', { name: 'Load more' });
    await more.waitFor();
    step('250 sales exist but only the first page of 100 is fetched and drawn');
    await more.click(); await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 200);
    await more.click(); await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 250);
    assert.equal(await more.count(), 0, '"Load more" must vanish once the last (short) page arrives');
    const calls = await page.evaluate(() => window.__historyCalls);
    assert.deepEqual(calls.map((c) => [c.limit, c.offset]), [[100, 0], [100, 100], [100, 200]]);
    step('Load more fetches pages at offsets 0/100/200, appends rows, and the button disappears after the last page');
    const ids = await page.$$eval('tbody tr td.mono', (tds) => tds.map((t) => t.textContent));
    assert.equal(new Set(ids).size, 250, 'no row should appear twice');
    step('all 250 rows are distinct (no overlap between pages)');
    assert.deepEqual(errors, [], errors.join(' | '));
    await page.close();
  }

  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log('\nSidebar + sales-history UI check: ALL PASSED');
})().catch((e) => { console.error('\nUI CHECK FAILED:', e.message); process.exit(1); });
