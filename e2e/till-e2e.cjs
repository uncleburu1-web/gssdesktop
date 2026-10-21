/*
 * Two real tills (this repo's code) against a real Django server + Postgres, seeded with
 * gssfrontend/e2e/seed.py (+ a second branch and a 'coowner' owner account for stages 7-10).
 *   node e2e/till-e2e.cjs      stages 1-6: sales, damage, counts, shifts, day reports
 *   node e2e/till-e2e2.cjs     stages 7-10: promotions, mobile money, returns, branch moves
 */
// Two real tills (new code) against the real Django server on :8000 + Postgres.
const D = require('path').resolve(__dirname, '..');
const SERVER = process.env.E2E_API_URL || 'http://127.0.0.1:8000/api';
require(D + '/test/_setup'); // sets a fake cloud URL for unit tests, so point back at the real server after it
process.env.BENCHLINE_API_URL = SERVER;
const os = require('os'); const fs = require('fs'); const path = require('path');
const { execSync } = require('child_process');
const dbm = require(D + '/src/main/db'); const auth = require(D + '/src/main/auth'); const sync = require(D + '/src/main/sync');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`${process.env.E2E_PSQL || 'su postgres -c "psql -d benchline_e2e -tAc'} \\"${q}\\""`).toString().trim();
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function till(user) {
  const db = dbm.openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), `till-${user}-`)), 'pos.db'));
  await auth.login(db, user, 'pass12345');
  const engine = sync.startSyncEngine(db, () => {});
  const settle = async () => { for (let i = 0; i < 3; i++) { await engine.pushNow(); await engine.pullNow(); await sleep(300); } };
  await settle();
  return { db, engine, settle };
}
const stock = (db) => db.prepare(`SELECT COALESCE(SUM(quantity_remaining),0) n FROM stock_batches WHERE is_deleted = 0`).get().n;
const serverStock = () => Number(sql(`SELECT SUM(quantity_remaining) FROM inventory_stockbatch WHERE is_deleted = false`));

(async () => {
  const a = await till('sade');
  const b = await till('ceo');
  check('both tills learn protocol 4', dbm.cloudSyncProtocol(a.db) >= 4 && dbm.cloudSyncProtocol(b.db) >= 4);
  check('a fresh till derives the same stock as the cloud (sales + damage + count from the web)', stock(a.db) === serverStock(), `${stock(a.db)} vs ${serverStock()}`);
  const product = a.db.prepare(`SELECT id FROM products LIMIT 1`).get();

  dbm.openShift(a.db, 'sade', 1000);
  dbm.createSale(a.db)({ cart_owner: 'sade', staff_name: 'Sade Seller', items: [{ product_id: product.id, item_name: 'Palm Oil 1L', quantity: 2, unit_price: 2500 }], amount_paid: 5000 });
  dbm.recordDamage(a.db, { product_id: product.id, quantity: 1, reason: 'Fell off the shelf' });
  dbm.addCashMovement(a.db, 'sade', { kind: 'paid_out', amount: 300, reason: 'Nylon bags' });
  dbm.closeShift(a.db, 'sade', { countedCash: 5700 });
  const before = serverStock();
  await a.settle();
  check('the till sale + damage reach the cloud stock exactly once', serverStock() === before - 3, `${before} -> ${serverStock()}`);
  check('the cloud records sade as the seller', sql(`SELECT u.username FROM sales_sale s JOIN staff_worker w ON w.id = s.worker_id JOIN auth_user u ON u.id = w.user_id WHERE s.receipt_no IS NOT NULL ORDER BY s.date DESC LIMIT 1`) === 'sade');
  check('the till damage is in the ledger with its till document id', sql(`SELECT COUNT(*) FROM inventory_stockmovement WHERE kind = 'damage' AND source = 'till' AND client_ref IS NOT NULL`) === '1');
  check('the closed shift and its variance are in the audit log', sql(`SELECT COUNT(*) FROM audit_auditlog WHERE action = 'shift.closed'`) === '1');
  check('the cash out reached the cloud', sql(`SELECT reason FROM shifts_cashmovement`) === 'Nylon bags');

  await a.settle(); await b.settle();
  check("the seller's own damage coming back is not applied twice on her till", stock(a.db) === serverStock(), `${stock(a.db)} vs ${serverStock()}`);
  check('the other till applies the sale and the damage once', stock(b.db) === serverStock(), `${stock(b.db)} vs ${serverStock()}`);
  check('the other till knows sade sold it', b.db.prepare(`SELECT COUNT(*) n FROM sales WHERE seller = 'sade'`).get().n >= 1);

  dbm.recordStockCount(b.db, { product_id: product.id, counted_quantity: 10, reason: 'Recount' });
  await b.settle(); await a.settle();
  check("the owner's till count sets cloud stock", serverStock() === 10, String(serverStock()));
  check("and the seller's till follows it", stock(a.db) === 10, String(stock(a.db)));

  dbm.recordStockCount(a.db, { product_id: product.id, counted_quantity: 3, reason: 'sneaky' }); // bypassing the UI check
  await a.settle();
  const failed = a.db.prepare(`SELECT last_error FROM sync_queue WHERE entity_type = 'stock_movement' AND status = 'failed'`).get();
  check("a seller's till cannot push a stock count (cloud refuses it, visibly)", Boolean(failed) && serverStock() === 10, failed && failed.last_error);

  const all = dbm.getDayReport(b.db, { date: today() });
  const mine = dbm.getDayReport(a.db, { date: today(), seller: 'sade' });
  check("the owner's day report shows sade's sales", all.by_seller.some((s) => s.seller === 'sade' && s.total >= 5000));
  check("sade's own day report shows her cash out", mine.cash.paid_out === 300 && mine.sales.count >= 1);

  a.engine.stop(); b.engine.stop();
  const bad = results.filter((r) => !r).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
