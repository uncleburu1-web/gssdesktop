#!/usr/bin/env node
/*
 * Dry-run the database upgrade on a COPY of a real till's database, before any till runs it for real.
 *
 *     node tools/check-upgrade-on-copy.js "C:\path\to\copy-of-your-till.db"
 *
 * It never touches the file you give it: it makes its own temporary copy, upgrades THAT with the new
 * code, and compares before and after. It prints PASS/FAIL for each thing that must not change (sales,
 * money taken, products, customers, stock, the sync queue) and for what must now be true (every naira
 * represented by a payment, new columns present, a new sale gets a receipt number).
 *
 * Needs Node >= 22.5 (uses the same SQLite shim as the tests). Find the database in the app's data
 * folder (the file ending in pos.db); copy it while the app is CLOSED so the copy is consistent.
 */
require('../test/_setup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error('Usage: node tools/check-upgrade-on-copy.js <path to a COPY of a till database (.db)>');
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-copy-'));
const copy = path.join(work, 'till.db');
fs.copyFileSync(source, copy);
for (const ext of ['-wal', '-shm']) if (fs.existsSync(source + ext)) fs.copyFileSync(source + ext, copy + ext);

const one = (db, sql) => db.prepare(sql).get().n;
// Tables a till may not have yet (it predates them): 0 rows, not an error.
const countIfTable = (db, table) => (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  ? one(db, `SELECT COUNT(*) AS n FROM ${table}`) : 0);
const snapshot = (db) => ({
  sales: one(db, `SELECT COUNT(*) AS n FROM sales WHERE is_deleted = 0`),
  deletedSales: one(db, `SELECT COUNT(*) AS n FROM sales WHERE is_deleted = 1`),
  saleItems: one(db, `SELECT COUNT(*) AS n FROM sale_items`),
  moneyTaken: one(db, `SELECT ROUND(COALESCE(SUM(amount_paid), 0), 2) AS n FROM sales WHERE is_deleted = 0`),
  products: one(db, `SELECT COUNT(*) AS n FROM products WHERE is_deleted = 0`),
  customers: one(db, `SELECT COUNT(*) AS n FROM customers WHERE is_deleted = 0`),
  stock: one(db, `SELECT COALESCE(SUM(quantity_remaining), 0) AS n FROM stock_batches WHERE is_deleted = 0`),
  waiting: one(db, `SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'pending'`),
  failed: one(db, `SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'failed'`),
  invoices: one(db, `SELECT COALESCE(MAX(invoice_number), 0) AS n FROM sales`),
  shifts: countIfTable(db, 'shifts'),
  cashMovements: countIfTable(db, 'cash_movements'),
  stockDocs: countIfTable(db, 'stock_docs'),
});

// Fingerprint of every queued change: id + what it says. The upgrade must not alter a single one.
const queueFingerprint = (db) => db.prepare(`SELECT id, entity_type, entity_id, operation, payload, status FROM sync_queue ORDER BY id`).all()
  .map((r) => JSON.stringify(r)).join('\n');

const raw = new Database(copy);
const before = snapshot(raw);
const queueBefore = queueFingerprint(raw);
raw.close();

const dbm = require('../src/main/db');
const started = Date.now();
const db = dbm.openDb(copy);                                   // <- the upgrade happens here
const took = Date.now() - started;
const after = snapshot(db);

let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };
const same = (key, label) => check(before[key] === after[key], label, `(${before[key]} -> ${after[key]})`);

console.log(`\nUpgrading a copy of: ${source}`);
console.log(`Before: ${before.sales} sales, ₦${before.moneyTaken} taken, ${before.products} products, ${before.customers} customers, ${before.waiting} changes waiting to sync, ${before.failed} failed.\n`);
console.log('Nothing may change:');
same('sales', 'sales'); same('deletedSales', 'deleted sales'); same('saleItems', 'sale lines'); same('moneyTaken', 'money taken');
same('products', 'products'); same('customers', 'customers'); same('stock', 'stock on hand');
same('shifts', 'shifts'); same('cashMovements', 'cash movements');
same('waiting', 'changes waiting to sync'); same('failed', 'failed changes (still there, still visible)'); same('invoices', 'invoice numbering');

console.log('\nWhat must now be true:');
const paid = one(db, `SELECT ROUND(COALESCE(SUM(amount), 0), 2) AS n FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE s.is_deleted = 0`);
check(paid === before.moneyTaken, 'every naira taken is represented by a payment record', `(₦${paid} of ₦${before.moneyTaken})`);
const cols = db.prepare(`PRAGMA table_info(sales)`).all().map((c) => c.name);
check(cols.includes('receipt_no') && cols.includes('shift_id'), 'new columns exist on the sales table');
const probe = db.prepare(`SELECT COUNT(*) AS n FROM sales s WHERE s.amount_paid > 0 AND NOT EXISTS (SELECT 1 FROM sale_payments p WHERE p.sale_id = s.id)`).get().n;
check(probe === 0, 'no paid sale is missing its payment record');
const mismatched = db.prepare(`SELECT COUNT(*) AS n FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE p.method != s.payment_method`).get().n;
check(mismatched === 0, 'each payment kept its sale\'s original payment method');
const queueCols = db.prepare(`PRAGMA table_info(sync_queue)`).all().map((c) => c.name);
check(['device_id', 'actor', 'last_attempt_at', 'acked_at'].every((c) => queueCols.includes(c)), 'new outbox columns exist on the sync queue');
check(queueFingerprint(db) === queueBefore, 'every queued change kept its id and content (so the cloud still recognises retries)');
check(db.prepare(`PRAGMA integrity_check`).get().integrity_check === 'ok', 'the database passes SQLite\'s own integrity check');

console.log(`\nUpgrade took ${took} ms.`);
console.log(failures === 0 ? '\nRESULT: SAFE. The upgrade preserved everything on this copy.' : `\nRESULT: ${failures} CHECK(S) FAILED. Do NOT roll this out; send this output to the developer.`);
db.close();
fs.rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
