/*
 * Two real tills (this repo's code) against a real Django server + Postgres, seeded with
 * gssfrontend/e2e/seed.py (+ a second branch and a 'coowner' owner account for stages 7-10).
 *   node e2e/till-e2e.cjs      stages 1-6: sales, damage, counts, shifts, day reports
 *   node e2e/till-e2e2.cjs     stages 7-10: promotions, mobile money, returns, branch moves
 */
// Stages 7-10 with two real tills (new code) against the real Django server on :8000 + Postgres.
const D = require('path').resolve(__dirname, '..');
require(D + '/test/_setup');
process.env.BENCHLINE_API_URL = process.env.BENCHLINE_API_URL || 'http://127.0.0.1:8000/api';
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
const PALM = "i.name = 'Palm Oil 1L' AND s.name = 'E2E Store'";
const serverStock = () => Number(sql(`SELECT SUM(b.quantity_remaining) FROM inventory_stockbatch b JOIN inventory_inventoryitem i ON i.id = b.item_id JOIN core_shop s ON s.id = i.shop_id WHERE ${PALM} AND b.is_deleted = false`));
const tillStock = (db, pid) => db.prepare(`SELECT COALESCE(SUM(quantity_remaining),0) n FROM stock_batches WHERE product_id = ? AND is_deleted = 0`).get(pid).n;

(async () => {
  const { bestDiscounts } = await import(D + '/src/renderer/promotions.js');
  const a = await till('sade');
  const b = await till('coowner');
  const product = a.db.prepare(`SELECT * FROM products WHERE name = 'Palm Oil 1L'`).get();
  check('both tills are on protocol 5', dbm.cloudSyncProtocol(a.db) >= 5 && dbm.cloudSyncProtocol(b.db) >= 5);
  check('mobile money is offered', dbm.paymentMethods(a.db).includes('mobile'));
  check('fresh tills derive the cloud stock (incl. web returns and the move to Lekki)', tillStock(a.db, product.id) === serverStock() && tillStock(b.db, product.id) === serverStock(), `${tillStock(a.db, product.id)} / ${tillStock(b.db, product.id)} / ${serverStock()}`);
  const promos = dbm.listPromotions(a.db);
  check('the promotion reached the till', promos.some((p) => p.name === 'Palm 10% off'));

  // Seller rings up 3 with the promotion, paid by mobile money (offline-first, then pushed).
  const lines = [{ product_id: product.id, item_name: product.name, category: product.category, quantity: 3, unit_price: product.sell_price }];
  const [d] = bestDiscounts(lines, promos, new Date());
  const sale = dbm.createSale(a.db)({ cart_owner: 'sade', staff_name: 'Sade Seller', payment_method: 'mobile',
    items: [{ ...lines[0], discount: d.discount, promotion_id: d.promotion_id }], amount_paid: 3 * product.sell_price - d.discount });
  const before = serverStock();
  await a.settle();
  check('till applied the promotion the same way the server would', d.discount === 750 && Boolean(d.promotion_id), String(d.discount));
  check('the cloud line keeps the promotion and the mobile money payment',
    sql(`SELECT promotion_id IS NOT NULL FROM sales_saleitem WHERE sale_id = '${sale.id}'`) === 't' && sql(`SELECT method FROM sales_salepayment WHERE sale_id = '${sale.id}'`) === 'mobile');
  check('stock reached the cloud once', serverStock() === before - 3);

  // A seller's till cannot take returns; the owner's till can.
  dbm.createReturn(a.db, { sale_id: sale.id, lines: [{ sale_item_id: sale.items[0].id, quantity: 1 }], reason: 'sneaky' }, 'sade');
  await a.settle();
  const refused = a.db.prepare(`SELECT last_error FROM sync_queue WHERE entity_type = 'sale_return' AND status = 'failed'`).get();
  check("a seller's till return is refused by the cloud (visibly)", Boolean(refused), refused && refused.last_error);

  await b.settle();
  const r = dbm.createReturn(b.db, { sale_id: sale.id, lines: [{ sale_item_id: sale.items[0].id, quantity: 1 }], reason: 'Seal broken', refund_method: 'mobile' }, 'coowner');
  const beforeReturn = serverStock();
  await b.settle();
  check("the owner's till return reaches the cloud with the till's id", sql(`SELECT source || '/' || refund_method || '/' || refund_amount FROM sales_salereturn WHERE id = '${r.id}'`) === 'till/mobile/2250.00');
  check('the returned bottle is back in cloud stock once', serverStock() === beforeReturn + 1);
  await b.settle(); await a.settle();
  check("the owner's till does not apply its own return twice", tillStock(b.db, product.id) === serverStock(), `${tillStock(b.db, product.id)} vs ${serverStock()}`);
  check("the seller's till follows the owner's return", tillStock(a.db, product.id) === serverStock() + 1, `${tillStock(a.db, product.id)} vs ${serverStock()} (+1 from its own refused return, still local)`);

  dbm.retryFailedSync(a.db);
  dbm.recordAuditEvent(a.db, 'sync.retry', { summary: 'Retried 1', data: { retried: 1 } });
  await a.settle();
  check("the seller's sync retry is in the owner's audit log", Number(sql("SELECT COUNT(*) FROM audit_auditlog WHERE action = 'sync.retry' AND source = 'till'")) >= 1);

  a.engine.stop(); b.engine.stop();
  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
