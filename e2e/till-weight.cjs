/*
 * Stage 11 with two real tills against a real server: weighed product (Beans (loose), from
 * gssfrontend/e2e/seed.py + weight seed) comes down with its flag, is sold offline by the gram on one
 * till, and the cloud and the other till end with exactly the same kg.
 */
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
async function till(user) {
  const db = dbm.openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), `till-${user}-`)), 'pos.db'));
  await auth.login(db, user, 'pass12345');
  const engine = sync.startSyncEngine(db, () => {});
  const settle = async () => { for (let i = 0; i < 3; i++) { await engine.pushNow(); await engine.pullNow(); await sleep(300); } };
  await settle();
  return { db, engine, settle };
}
const serverKg = () => Number(sql("SELECT SUM(quantity_remaining) FROM inventory_stockbatch b JOIN inventory_inventoryitem i ON i.id = b.item_id WHERE i.name = 'Beans (loose)' AND b.is_deleted = false"));
const tillKg = (db, id) => db.prepare(`SELECT COALESCE(SUM(quantity_remaining),0) n FROM stock_batches WHERE product_id = ? AND is_deleted = 0`).get(id).n;

(async () => {
  const a = await till('sade');
  const b = await till('coowner');
  const beans = a.db.prepare(`SELECT * FROM products WHERE name = 'Beans (loose)'`).get();
  check('the weighed flag reached the till', beans && beans.sold_by_weight === 1);
  check('both tills hold the cloud kg exactly', tillKg(a.db, beans.id) === serverKg() && tillKg(b.db, beans.id) === serverKg(), `${tillKg(a.db, beans.id)} / ${serverKg()}`);
  const before = serverKg();
  dbm.createSale(a.db)({ cart_owner: 'sade', items: [{ product_id: beans.id, item_name: beans.name, quantity: 0.1, unit_price: 1500 }], amount_paid: 150 });
  dbm.createSale(a.db)({ cart_owner: 'sade', items: [{ product_id: beans.id, item_name: beans.name, quantity: 0.2, unit_price: 1500 }], amount_paid: 300 });
  dbm.recordDamage(a.db, { product_id: beans.id, quantity: 0.05, reason: 'Spilled' });
  await a.settle(); await b.settle(); await a.settle();
  check('the cloud took off exactly 0.35 kg (no float dust)', Math.round((before - serverKg()) * 1000) === 350, `${before} -> ${serverKg()}`);
  check('both tills agree with the cloud to the gram', tillKg(a.db, beans.id) === serverKg() && tillKg(b.db, beans.id) === serverKg(), `${tillKg(a.db, beans.id)} / ${tillKg(b.db, beans.id)} / ${serverKg()}`);
  a.engine.stop(); b.engine.stop();
  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
