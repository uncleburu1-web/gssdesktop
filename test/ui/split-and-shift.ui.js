// Drives the REAL PosScreen (split payment), Receipt, and ShiftScreen / Z-report in headless Chromium.
//   node test/ui/split-and-shift.ui.js   (same prerequisites as the other *.ui.js checks)
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
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  await page.goto('file://' + path.join(work, `${name}.html`));
  return { page, errors };
}
const step = (msg) => console.log('  ✓ ' + msg);

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
  const browser = await chromium.launch();

  // =============================================================== split payment
  {
    const { page, errors } = await makePage(browser, work, 'pos', `import PosScreen from '${rend('PosScreen.jsx')}';\ncreateRoot(document.getElementById('root')).render(<PosScreen refreshKey={0} profile={{ username: 'alice', shop_name: 'Test Shop' }} onSaleComplete={() => {}} />);`);
    const tile = (n) => page.locator('.pos-tile', { hasText: n }).first();
    const modal = page.locator('.modal');
    const text = (l) => l.innerText();
    await page.waitForSelector('.pos-tile:has-text("Cola")');
    await tile('Cola').click(); await tile('Cola').click(); await tile('Charger').click();       // 100 + 100 + 2,500 = 2,700

    await page.locator('.pay-methods').getByRole('button', { name: 'Split', exact: true }).click();
    await modal.getByRole('heading', { name: 'Split payment' }).waitFor();
    const confirm = page.getByRole('button', { name: 'Use these payments' });
    assert.equal(await confirm.isDisabled(), true);
    step('Split opens a dialog; nothing can be confirmed until payments are added');

    await page.getByRole('button', { name: '+ Cash' }).click();
    assert.equal(await page.getByLabel('Amount for line 1').inputValue(), '2700', 'a new line is pre-filled with what is still to pay');
    await page.getByLabel('Amount for line 1').fill('1000');
    await page.getByLabel('Cash handed over for line 1').fill('2000');
    await page.getByRole('button', { name: '+ Transfer' }).click();
    assert.equal(await page.getByLabel('Amount for line 2').inputValue(), '1700', 'the next line is pre-filled with the REMAINING amount');
    await page.getByLabel('Reference for line 2').fill('TRF-9');
    assert.match(await text(modal), /Fully covered/);
    assert.equal(await confirm.isDisabled(), false);
    step('lines pre-fill with the remaining amount; once they add up the dialog says "Fully covered" and enables Confirm');

    await page.getByLabel('Amount for line 2').fill('1600');
    assert.match(await text(modal), /Still to pay/);
    assert.equal(await confirm.isDisabled(), true);
    await page.getByLabel('Amount for line 2').fill('1800');
    assert.match(await text(modal), /Over by/);
    assert.equal(await confirm.isDisabled(), true);
    await page.getByLabel('Amount for line 2').fill('1700');
    assert.equal(await confirm.isDisabled(), false);
    step('short or over by even one naira: Confirm stays disabled and the dialog says which');

    await page.getByLabel('Cash handed over for line 1').fill('500');
    assert.equal(await confirm.isDisabled(), true);
    assert.match(await text(modal), /less than the amount/);
    await page.getByLabel('Cash handed over for line 1').fill('2000');
    step('cash handed over less than the cash amount is caught');

    await confirm.click();
    const summary = page.locator('.split-summary');
    await summary.waitFor();
    assert.match(await text(summary), /Split:.*Cash.*1,000.*Transfer.*1,700/s);
    assert.equal(await page.locator('.pay-methods').count(), 0, 'single-method buttons are replaced by the split summary');
    assert.equal(await page.locator('.installment-toggle input').isDisabled(), true);
    step('confirmed: the cart shows "Split: Cash ... · Transfer ..." and installments are switched off');

    await tile('Cola').click();                                                       // total is now 2,800: the split no longer matches
    await page.waitForSelector('.pay-methods');
    assert.equal(await summary.count(), 0);
    step('changing the cart AFTER splitting drops the split (it can never be charged against a different total)');

    await page.locator('.pay-methods').getByRole('button', { name: 'Split', exact: true }).click();
    await page.getByRole('button', { name: '+ Cash' }).click();
    await page.getByLabel('Amount for line 1').fill('1000'); await page.getByLabel('Cash handed over for line 1').fill('2000');
    await page.getByRole('button', { name: '+ Transfer' }).click();
    await page.getByLabel('Reference for line 2').fill('TRF-9');
    await page.getByRole('button', { name: 'Use these payments' }).click();
    await page.locator('.charge-btn').click();
    await page.waitForFunction(() => window.__calls.includes('createSale'));
    const sent = (await page.evaluate(() => JSON.parse(localStorage.getItem('mock-till-db')).sales)).at(-1);
    assert.deepEqual(sent.payments, [{ method: 'cash', amount: 1000, tendered: 2000 }, { method: 'transfer', amount: 1800, reference: 'TRF-9' }]);
    assert.equal(sent.status, 'completed'); assert.equal(sent.amount_paid, undefined);
    step('charging sends exactly the split payments (with cash handed over and the transfer reference) to the till database');

    const receipt = await page.locator('.receipt-print').first().textContent();
    assert.match(receipt, /Receipt.*ABCDEF-000001/s);
    assert.match(receipt, /Cash.*1,000/s); assert.match(receipt, /Transfer \(TRF-9\).*1,800/s);
    assert.match(receipt, /Cash received.*2,000/s); assert.match(receipt, /Change.*1,000/s);
    step('the printed receipt shows the receipt number, one line per payment, the cash handed over and the change');
    assert.deepEqual(errors, [], errors.join(' | '));
    await page.close();
  }

  // =============================================================== shift + Z-report
  {
    const { page, errors } = await makePage(browser, work, 'shift', `import ShiftScreen from '${rend('ShiftScreen.jsx')}';\ncreateRoot(document.getElementById('root')).render(<ShiftScreen refreshKey={0} profile={{ is_owner: true, shop_name: 'Test Shop' }} />);`);
    const body = () => page.locator('body').innerText();
    const modal = page.locator('.modal');
    await page.waitForSelector('text=No shift is open');
    assert.match(await body(), /still sell, but those sales won't appear in any Z-report/);
    step('no shift: says so, and is honest that selling still works but won\'t be in a Z-report');

    await page.locator('.card').first().getByRole('button', { name: 'Open shift' }).click();
    await page.getByLabel('Opening cash float (₦)').fill('5000');
    await modal.getByRole('button', { name: 'Open shift' }).click();
    await page.waitForSelector('text=Opening float');
    assert.match(await body(), /opening float\s*₦5,000/i);
    assert.deepEqual((await page.evaluate(() => window.__shiftState.calls))[0], ['openShift', 5000]);
    step('opening a shift with a ₦5,000 float');

    await page.getByRole('button', { name: 'Cash out' }).click();
    await page.getByLabel('Amount (₦)').fill('150'); await page.getByLabel('Reason').fill('Bought sachet water');
    await modal.getByRole('button', { name: 'Record' }).click();
    await modal.waitFor({ state: 'detached' });
    assert.deepEqual((await page.evaluate(() => window.__shiftState.calls))[1], ['cashMovement', { kind: 'paid_out', amount: 150, reason: 'Bought sachet water' }]);
    step('cash out needs (and sends) an amount and a reason');

    await page.evaluate(() => { window.pos.cashMovement = async () => { throw new Error('There is no open shift. Open one before moving cash in or out.'); }; });
    await page.getByRole('button', { name: 'Cash in' }).click();
    await page.getByLabel('Amount (₦)').fill('10'); await page.getByLabel('Reason').fill('x');
    await modal.getByRole('button', { name: 'Record' }).click();
    await page.waitForSelector('.modal >> text=no open shift');
    await modal.getByRole('button', { name: 'Cancel' }).click();
    step('a refusal from the till database is shown in the dialog in plain words');

    assert.ok(!(await body()).includes('6,550'), 'expected cash must not be visible while the shift is open');
    await page.getByRole('button', { name: 'Close shift' }).first().click();
    assert.match(await body(), /Count the cash in the drawer/);
    assert.ok(!(await body()).includes('6,550'), 'BLIND COUNT: the expected figure must not be shown before the cashier counts');
    step('closing is a blind count: the expected cash (₦6,550) is nowhere on screen until the drawer has been counted');

    await page.getByLabel('Cash counted in the drawer (₦)').fill('6500');
    await modal.getByRole('button', { name: 'Close shift' }).click();
    await page.waitForSelector('text=Z-REPORT #1');
    const z = await body();
    assert.match(z, /Expected in drawer\s*₦6,550/); assert.match(z, /Counted\s*₦6,500/); assert.match(z, /SHORT by\s*₦50/);
    assert.match(z, /Cash received\s*₦1,500/); assert.match(z, /Transfer received\s*₦1,000/); assert.match(z, /POS\/Card received\s*₦500/);
    assert.match(z, /ABCDEF-000001 to ABCDEF-000004/);
    step('after counting, the Z-report shows expected vs counted, "SHORT by ₦50", payments by method and the receipt range');

    await modal.getByRole('button', { name: 'Print' }).click();
    assert.ok((await page.evaluate(() => window.__calls)).includes('printReceipt'));
    const slip = await page.locator('.receipt-print').textContent();
    assert.match(slip, /Z-REPORT #1/); assert.match(slip, /Signature/); assert.match(slip, /SHORT by/);
    step('Print uses the receipt printer path, and the printed slip has the same figures plus a signature line');

    await modal.getByRole('button', { name: 'Close' }).click();
    await page.waitForSelector('td.mono:has-text("#1")');
    assert.match(await body(), /Short\s*₦50/);
    await page.getByRole('button', { name: 'View' }).click();
    await page.waitForSelector('text=Z-REPORT #1');
    step('the closed shift appears in the history and its frozen report can be re-opened');
    assert.deepEqual(errors, [], errors.join(' | '));
    await page.close();
  }

  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log('\nSplit-payment + shift UI check: ALL PASSED');
})().catch((e) => { console.error('\nUI CHECK FAILED:', e.message); process.exit(1); });
