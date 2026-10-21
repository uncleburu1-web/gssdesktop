/*
 * Release check: internet outage, offline sign-in, till restart and recovery, with two real tills
 * against a real server (see docs/RELEASE_CHECKLIST.md).
 *
 *   E2E_SERVER_CMD=/path/to/server.sh node e2e/till-outage.cjs
 *
 * E2E_SERVER_CMD must accept "start" and "stop" and control the local test backend on
 * 127.0.0.1:8000 (the test stops it to simulate the internet going down). E2E_PSQL as in the other
 * e2e scripts. Users "sade" (seller) and "coowner" come from gssfrontend/e2e/seed.py.
 */
const D = require('path').resolve(__dirname, '..');
const SERVER = process.env.E2E_API_URL || 'http://127.0.0.1:8000/api';
const SERVER_CMD = process.env.E2E_SERVER_CMD;
if (!SERVER_CMD) { console.error('Set E2E_SERVER_CMD to a script that takes start|stop for the local backend.'); process.exit(2); }
require(D + '/test/_setup'); // sets a fake cloud URL for unit tests, so point back at the real server after it
process.env.BENCHLINE_API_URL = SERVER;
const os = require('os'), fs = require('fs'), path = require('path');
const { execSync } = require('child_process');
const dbm = require(D + '/src/main/db'), auth = require(D + '/src/main/auth'), sync = require(D + '/src/main/sync');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execSync(`${process.env.E2E_PSQL || 'su postgres -c "psql -d benchline_e2e -tAc'} \\"${q}\\""`).toString().trim();
let fails = 0; const check = (ok, label, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };
async function openTill(file, user, online = true) {
  const db = dbm.openDb(file);
  if (online) await auth.login(db, user, 'pass12345');
  const engine = sync.startSyncEngine(db, () => {});
  const settle = async () => { for (let i = 0; i < 3; i++) { await engine.pushNow(); await engine.pullNow(); await sleep(300); } };
  return { db, engine, settle };
}
const tillQty = (db, id) => db.prepare(`SELECT COALESCE(SUM(quantity_remaining),0) n FROM stock_batches WHERE product_id = ? AND is_deleted = 0`).get(id).n;
(async () => {
  const fileA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tillA-')), 'pos.db');
  const fileB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tillB-')), 'pos.db');
  let a = await openTill(fileA, 'sade'); const b = await openTill(fileB, 'coowner');
  await a.settle(); await b.settle();
  const p = a.db.prepare(`SELECT p.* FROM products p WHERE p.is_deleted = 0 AND p.sold_by_weight = 0 AND (SELECT SUM(quantity_remaining) FROM stock_batches s WHERE s.product_id = p.id AND s.is_deleted = 0) >= 5 ORDER BY p.name LIMIT 1`).get();
  const cloudQty = () => Number(sql(`SELECT COALESCE(SUM(quantity_remaining),0) FROM inventory_stockbatch WHERE item_id = '${p.id}' AND is_deleted = false`));
  const start = cloudQty();
  check(tillQty(a.db, p.id) === start && tillQty(b.db, p.id) === start, 'both tills start equal to the cloud', `${p.name}: cloud ${start}, A ${tillQty(a.db, p.id)}, B ${tillQty(b.db, p.id)}`);

  execSync(`${SERVER_CMD} stop`, { stdio: 'ignore' });
  const s1 = dbm.createSale(a.db)({ cart_owner: 'sade', items: [{ product_id: p.id, item_name: p.name, quantity: 2, unit_price: p.sell_price }], amount_paid: 2 * p.sell_price });
  await a.engine.pushNow().catch(() => {});
  const waiting = a.db.prepare(`SELECT COUNT(*) n FROM sync_queue WHERE status = 'pending'`).get().n;
  check(waiting >= 1, 'with the server down the sale is saved and waiting', `${waiting} pending`);
  check(tillQty(a.db, p.id) === start - 2, 'the till already shows 2 fewer');

  // till A closes unexpectedly (no clean shutdown) and is reopened while still offline
  a.engine.stop(); a.db.close();
  const offlineLogin = dbm.openDb(fileA);
  let offlineOk = false;
  try { await auth.login(offlineLogin, 'sade', 'pass12345'); offlineOk = true; } catch (e) { console.log('   ', e.message); }
  check(offlineOk, 'sign-in works with no internet after a restart');
  let wrongRejected = false;
  try { await auth.login(offlineLogin, 'sade', 'wrong-password'); } catch { wrongRejected = true; }
  check(wrongRejected, 'a wrong password is still refused offline');
  offlineLogin.close();
  a = await openTill(fileA, 'sade', false);
  dbm.createSale(a.db)({ cart_owner: 'sade', items: [{ product_id: p.id, item_name: p.name, quantity: 1, unit_price: p.sell_price }], amount_paid: p.sell_price });
  check(a.db.prepare(`SELECT COUNT(*) n FROM sync_queue WHERE status = 'pending'`).get().n > waiting, 'a second offline sale after the restart is queued too');
 execSync(`${SERVER_CMD} start`, { stdio: 'ignore' });
  await auth.login(a.db, 'sade', 'pass12345');
  await a.settle(); await b.settle(); await a.settle();
  check(a.db.prepare(`SELECT COUNT(*) n FROM sync_queue WHERE status IN ('pending','failed')`).get().n === 0, 'everything uploaded once the server is back');
  const rcpt = a.db.prepare(`SELECT receipt_no FROM sales WHERE id = ?`).get(s1.id || s1.sale_id).receipt_no;
  check(Number(sql(`SELECT COUNT(*) FROM sales_sale WHERE receipt_no = '${rcpt}'`)) === 1, 'the cloud holds the first offline sale exactly once', rcpt);
  check(cloudQty() === start - 3, 'cloud stock fell by exactly 3', `${start} -> ${cloudQty()}`);
  check(tillQty(a.db, p.id) === cloudQty() && tillQty(b.db, p.id) === cloudQty(), 'both tills agree with the cloud', `${tillQty(a.db, p.id)} / ${tillQty(b.db, p.id)} / ${cloudQty()}`);

  // a duplicate resend of everything already applied must not create anything
  a.db.prepare(`UPDATE sync_queue SET status = 'pending', next_attempt_at = NULL WHERE entity_type IN ('sale_doc','sale','sale_item')`).run();
  await a.settle();
  check(Number(sql(`SELECT COUNT(*) FROM sales_sale WHERE receipt_no = '${rcpt}'`)) === 1 && cloudQty() === start - 3, 'resending the same sales creates no duplicates');
  a.engine.stop(); b.engine.stop();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
