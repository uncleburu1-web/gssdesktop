const Database = require('better-sqlite3');
const { getOrCreateDeviceId } = require('./device');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Opens (creating if needed) the local SQLite database and applies the
 * schema. This is the ONLY database the POS reads from and writes to for
 * every normal operation — see repository functions below. The sync
 * engine (separate module) is the only thing that ever talks to the
 * cloud, and it only ever *reads* from here (the outbox) and *writes*
 * back confirmations — it never sits in the path of a sale being rung up.
 */
function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

/**
 * schema.sql only uses `CREATE TABLE IF NOT EXISTS`, so a column added to
 * an existing table's definition there is silently a no-op for any
 * database file that already exists (e.g. whatever's already on a shop's
 * machine) — SQLite never had a chance to see the new column. There's no
 * migration framework here (overkill for a handful of columns so far), so
 * new columns get a one-line ALTER TABLE guarded by a PRAGMA check,
 * appended to this function as they're added. Safe to run on every open:
 * each ALTER is skipped once the column exists.
 */
function migrate(db) {
  const hasColumn = (table, column) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

  if (!hasColumn('products', 'barcode')) {
    db.exec('ALTER TABLE products ADD COLUMN barcode TEXT');
  }
  // Always attempted (IF NOT EXISTS makes it a safe no-op once it
  // exists), and deliberately NOT inside the guard above: this used to
  // also live directly in schema.sql, which ran BEFORE this function on
  // every open — fine for a brand new database (CREATE TABLE already
  // included the column), but for anyone with an existing database
  // predating barcodes, that premature CREATE INDEX crashed with
  // "no such column: barcode" before migrate() ever got the chance to
  // add it. Now the column is guaranteed to exist by this line
  // regardless of which path got it there.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL');
  if (!hasColumn('sync_queue', 'next_attempt_at')) {
    db.exec('ALTER TABLE sync_queue ADD COLUMN next_attempt_at TEXT');
  }
  if (!hasColumn('sales', 'invoice_number')) {
    db.exec('ALTER TABLE sales ADD COLUMN invoice_number INTEGER');
  }
  if (!hasColumn('customers', 'email')) {
    db.exec('ALTER TABLE customers ADD COLUMN email TEXT');
    db.exec('ALTER TABLE customers ADD COLUMN address TEXT');
    db.exec('ALTER TABLE customers ADD COLUMN notes TEXT');
  }
  if (!hasColumn('sales', 'customer_id')) {
    db.exec('ALTER TABLE sales ADD COLUMN customer_id TEXT REFERENCES customers(id)');
  }
  if (!hasColumn('sale_items', 'stock_shortfall')) {
    db.exec('ALTER TABLE sale_items ADD COLUMN stock_shortfall INTEGER NOT NULL DEFAULT 0');
  }

  // Receipt numbers, shifts, split payments (all additive; safe to run on every open).
  if (!hasColumn('sales', 'receipt_no')) db.exec('ALTER TABLE sales ADD COLUMN receipt_no TEXT');
  if (!hasColumn('sales', 'shift_id')) db.exec('ALTER TABLE sales ADD COLUMN shift_id TEXT');
  // Partial: sales from before receipt numbers (NULL) never collide with each other. Created here,
  // not in schema.sql, for the same reason as idx_products_barcode above.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_receipt_no ON sales(receipt_no) WHERE receipt_no IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sales_shift ON sales(shift_id)');
  // Outbox attribution and acknowledgement (Stage 1). Additive only: old rows keep NULLs.
  for (const column of ['device_id', 'actor', 'last_attempt_at', 'acked_at']) {
    if (!hasColumn('sync_queue', column)) db.exec(`ALTER TABLE sync_queue ADD COLUMN ${column} TEXT`);
  }
  backfillSyncedAt(db);
  backfillPayments(db);
}

/**
 * The next sequential invoice number, scoped to this desktop's local
 * database only (see Sale.invoice_number's help_text on the Django model
 * for why it's not a globally-coordinated number). Reads-then-writes a
 * single app_settings row; safe without extra locking because it only
 * ever runs inside createSale's db.transaction(), which better-sqlite3
 * executes synchronously — nothing else can interleave.
 */
function nextInvoiceNumber(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'next_invoice_number'`).get();
  const next = row ? Number(row.value) : 1;
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('next_invoice_number', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(next + 1));
  return next;
}

/** The cursor sync.js's pull loop uses so `/sync/pull/?since=` only ever
 * asks for what's actually changed since last time, not the whole shop's
 * data on every tick. */
function getLastPullAt(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'last_pull_at'`).get();
  return row ? row.value : null;
}

function setLastPullAt(db, iso) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('last_pull_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(iso);
}

/**
 * Generic per-device key/value read on the same app_settings table
 * next_invoice_number/last_pull_at already live in. Used for local-only
 * preferences that have no business meaning to sync to the cloud — right
 * now just which physical printer THIS till's receipts go to (see
 * printers:getSelected/printers:setSelected in main.js). Deliberately
 * not synced: a shop with 3 tills can have 3 different printers, and the
 * cloud/other devices have no business knowing or caring which.
 */
function getSetting(db, key) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value == null ? '' : value);
}

/**
 * Appends one outbox row. Every write to shop data goes through this so
 * the sync engine has something to push later. Deliberately NOT called
 * for stock_batch quantity_remaining deductions caused by a sale — per
 * the architecture's conflict-resolution design, inventory is never
 * synced as a snapshot number. The cloud derives stock by independently
 * applying the same 'sale'/'sale_item' create operations this queue
 * already carries, via its own FEFO logic — syncing the batch row too
 * would double-apply the deduction and could never be reconciled if two
 * devices sold from the same batch while both offline.
 */
function enqueueSync(db, { entityType, entityId, operation, payload }) {
  db.prepare(
    `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, client_timestamp, status, retry_count, device_id, actor)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
  ).run(uuid(), entityType, entityId, operation, JSON.stringify(payload), nowIso(), getOrCreateDeviceId(db), currentActor(db));
}

/**
 * The sync protocol the cloud last said it understands (sync.js stores it from every pull).
 *   1: a sale travels as 'sale' + one 'sale_item' per line; an installment as a 'sale' update
 *   2: a sale travels as ONE 'sale_doc' (header, lines, payments); an installment as a 'sale_payment'
 * A till never sends protocol-2 operations to a cloud that has not announced it.
 */
function cloudSyncProtocol(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'cloud_sync_protocol'`).get();
  const n = row ? Number(row.value) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Username of whoever is signed in on this till right now (auth.js keeps it in app_settings), or null. */
function currentActor(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'user_profile'`).get();
  if (!row) return null;
  try { return JSON.parse(row.value).username || null; } catch { return null; }
}

// ---------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------

function createProduct(db, { name, short_code = '', barcode = null, category = 'other', unit = 'PIECE', sell_price = 0, min_stock = 2 }) {
  const id = uuid();
  const ts = nowIso();
  const cleanBarcode = barcode && barcode.trim() ? barcode.trim() : null; // '' -> null, see idx_products_barcode
  try {
    db.prepare(
      `INSERT INTO products (id, name, short_code, barcode, category, unit, sell_price, min_stock, created_at, updated_at, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(id, name, short_code, cleanBarcode, category, unit, sell_price, min_stock, ts, ts);
  } catch (err) {
    if (cleanBarcode && /UNIQUE constraint failed: products\.barcode/.test(err.message)) {
      throw new Error(`Barcode "${cleanBarcode}" is already used by another product.`);
    }
    throw err;
  }
  const row = getProduct(db, id);
  enqueueSync(db, { entityType: 'product', entityId: id, operation: 'create', payload: row });
  return row;
}

function getProduct(db, id) {
  const row = db.prepare(`SELECT * FROM products WHERE id = ?`).get(id);
  if (!row) return null;
  return { ...row, ...computeStockFields(db, id) };
}

function computeStockFields(db, productId) {
  const batches = db.prepare(
    `SELECT * FROM stock_batches WHERE product_id = ? AND is_deleted = 0`
  ).all(productId);
  const quantity = batches.reduce((sum, b) => sum + b.quantity_remaining, 0);
  const remainingWithStock = batches.filter((b) => b.quantity_remaining > 0);
  const totalQty = remainingWithStock.reduce((s, b) => s + b.quantity_remaining, 0);
  const costPrice = totalQty
    ? remainingWithStock.reduce((s, b) => s + b.quantity_remaining * b.cost_price, 0) / totalQty
    : 0;
  return { quantity, cost_price: Math.round(costPrice * 100) / 100 };
}

/**
 * Stock quantity and average cost for EVERY product in one query (computeStockFields does the
 * same sums for one product and costs one query per call, which made the product list a query
 * per product). The fold below is the same arithmetic in the same batch order as
 * computeStockFields, so results are identical (test/perf.equivalence.test.js proves it).
 */
function stockFieldsForAllProducts(db) {
  const batches = db.prepare(
    // expiry_date, rowid: the order idx_batches_product (product_id, expiry_date) hands rows back
    `SELECT product_id, quantity_remaining, cost_price FROM stock_batches WHERE is_deleted = 0 ORDER BY product_id, expiry_date, rowid`
  ).all();
  const byProduct = new Map();
  for (const b of batches) {
    let acc = byProduct.get(b.product_id);
    if (!acc) { acc = { quantity: 0, totalQty: 0, weightedCost: 0 }; byProduct.set(b.product_id, acc); }
    acc.quantity += b.quantity_remaining;
    if (b.quantity_remaining > 0) { acc.totalQty += b.quantity_remaining; acc.weightedCost += b.quantity_remaining * b.cost_price; }
  }
  return (productId) => {
    const acc = byProduct.get(productId);
    if (!acc) return { quantity: 0, cost_price: 0 };
    const costPrice = acc.totalQty ? acc.weightedCost / acc.totalQty : 0;
    return { quantity: acc.quantity, cost_price: Math.round(costPrice * 100) / 100 };
  };
}

function listProducts(db, { category = null, search = '' } = {}) {
  let rows = db.prepare(`SELECT * FROM products WHERE is_deleted = 0 ORDER BY name`).all();
  if (category && category !== 'all') rows = rows.filter((r) => r.category === category);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => `${r.name} ${r.short_code || ''} ${r.barcode || ''}`.toLowerCase().includes(q));
  }
  const stockOf = stockFieldsForAllProducts(db);
  return rows.map((r) => ({ ...r, ...stockOf(r.id) }));
}

function createCustomer(db, { name, phone = '', email = '', address = '', notes = '' }) {
  const id = uuid();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO customers (id, name, phone, email, address, notes, created_at, updated_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(id, name, phone, email, address, notes, ts, ts);
  const row = getCustomer(db, id);
  enqueueSync(db, { entityType: 'customer', entityId: id, operation: 'create', payload: row });
  return row;
}

function getCustomer(db, id) {
  return db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
}

function listCustomers(db, { search = '' } = {}) {
  let rows = db.prepare(`SELECT * FROM customers WHERE is_deleted = 0 ORDER BY name`).all();
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => `${r.name} ${r.phone || ''} ${r.email || ''}`.toLowerCase().includes(q));
  }
  // What each customer currently owes across their own not-yet-fully-paid
  // sales — computed locally so it works offline, same reasoning as
  // CustomerViewSet.balance on the cloud side (sales/../customers/views.py).
  // All installment sales in one query, their items in a batched one, then grouped per customer
  // (this used to run a query for every customer plus two for each of their open sales).
  const open = db.prepare(
    `SELECT * FROM sales WHERE status = 'outstanding' AND is_deleted = 0 AND customer_id IS NOT NULL ORDER BY rowid`
  ).all();
  const openItems = loadItemsBySale(db, open.map((s) => s.id));
  const owed = new Map();
  for (const s of open) {
    const entry = owed.get(s.customer_id) || { balance: 0, count: 0 };
    entry.balance += buildSale(s, openItems.get(s.id) || []).balance_due;
    entry.count += 1;
    owed.set(s.customer_id, entry);
  }
  return rows.map((r) => {
    const entry = owed.get(r.id);
    return { ...r, balance_due: entry ? entry.balance : 0, outstanding_sale_count: entry ? entry.count : 0 };
  });
}

function addStockBatch(db, { product_id, batch_number = '', quantity_received, cost_price = 0, expiry_date = null }) {
  const id = uuid();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO stock_batches
       (id, product_id, batch_number, quantity_received, quantity_remaining, cost_price, expiry_date, received_date, created_at, updated_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(id, product_id, batch_number, quantity_received, quantity_received, cost_price, expiry_date, ts, ts, ts);
  const row = db.prepare(`SELECT * FROM stock_batches WHERE id = ?`).get(id);
  // Batch CREATION (new stock arriving) is genuinely new business data the
  // cloud needs — unlike deductions from a sale, this isn't derivable from
  // anything else, so it does get its own sync op.
  enqueueSync(db, { entityType: 'stock_batch', entityId: id, operation: 'create', payload: row });
  return row;
}

// ---------------------------------------------------------------------
// Sales (cart header + line items), FEFO allocation — mirrors the cloud
// Django implementation in sales/views.py exactly, so behavior is
// identical whether a sale happens offline or online.
// ---------------------------------------------------------------------

function allocateStock(db, saleItemId, productId, quantity) {
  if (!productId) return { unitCost: 0 };
  const batches = db.prepare(
    `SELECT * FROM stock_batches
     WHERE product_id = ? AND quantity_remaining > 0 AND is_deleted = 0
     ORDER BY (expiry_date IS NULL), expiry_date, received_date`
  ).all(productId);

  let remaining = quantity;
  let totalCost = 0;
  let totalTaken = 0;
  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity_remaining, remaining);
    db.prepare(`UPDATE stock_batches SET quantity_remaining = quantity_remaining - ?, updated_at = ? WHERE id = ?`)
      .run(take, nowIso(), batch.id);
    db.prepare(`INSERT INTO sale_allocations (id, sale_item_id, batch_id, quantity) VALUES (?, ?, ?, ?)`)
      .run(uuid(), saleItemId, batch.id, take);
    totalCost += take * batch.cost_price;
    totalTaken += take;
    remaining -= take;
  }
  return { unitCost: totalTaken ? Math.round((totalCost / totalTaken) * 100) / 100 : 0, shortfall: remaining };
}

function restoreStock(db, saleItemId) {
  const allocations = db.prepare(`SELECT * FROM sale_allocations WHERE sale_item_id = ?`).all(saleItemId);
  for (const alloc of allocations) {
    if (alloc.batch_id) {
      db.prepare(`UPDATE stock_batches SET quantity_remaining = quantity_remaining + ?, updated_at = ? WHERE id = ?`)
        .run(alloc.quantity, nowIso(), alloc.batch_id);
    }
  }
  db.prepare(`DELETE FROM sale_allocations WHERE sale_item_id = ?`).run(saleItemId);
}

// ---------------------------------------------------------------------
// Applying PULLED changes from the cloud — a product the CEO added on
// the web, a sale rung up on another device, a customer created
// elsewhere. This is the other half of sync that only ever existed on
// paper until now: sync.js pushed local changes up, but nothing ever
// pulled anything down, so this desktop never learned about changes
// made anywhere else. See sync.js's pullTick for what calls these.
//
// Two different conflict rules, deliberately:
//  - Master data (product/stock_batch/customer): last-write-wins by
//    updated_at — if THIS desktop has a more recent unpushed edit than
//    what the cloud is offering, keep the local one; the next push will
//    make the cloud catch up instead.
//  - Sales/sale_items: apply ONCE. If the row already exists locally
//    (this desktop created it, or already pulled it before), touch
//    nothing — re-running FEFO allocation on an update would double-
//    deduct stock for a sale that already deducted it. A genuinely new
//    field change (e.g. an installment sale completed via the web) still
//    updates the header fields, just never re-touches stock/allocations.
// ---------------------------------------------------------------------

/**
 * True while THIS till has an edit of this exact row that the cloud has not
 * acknowledged yet. A pull must not overwrite such a row: the pending push is
 * what will bring the cloud up to date. (The old guard compared updated_at
 * against `payload.updated_at`, a field the cloud never sends, so it never
 * fired and every pull overwrote unpushed local edits.)
 */
function hasPendingLocalChange(db, entityType, entityId) {
  return !!db.prepare(
    `SELECT 1 FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND status = 'pending' LIMIT 1`
  ).get(entityType, entityId);
}

function applyPulledProduct(db, entityId, operation, payload) {
  const ts = nowIso();
  if (operation === 'delete') {
    db.prepare(`UPDATE products SET is_deleted = 1, updated_at = ?, synced_at = ? WHERE id = ?`).run(ts, ts, entityId);
    return;
  }
  const existing = db.prepare(`SELECT updated_at FROM products WHERE id = ?`).get(entityId);
  if (existing && hasPendingLocalChange(db, 'product', entityId)) return; // unpushed local edit — keep it, its push updates the cloud
  const fields = [payload.name, payload.short_code || '', payload.barcode || null, payload.category || 'other',
    payload.unit || 'PIECE', payload.sell_price || 0, payload.min_stock ?? 2];
  if (existing) {
    db.prepare(
      `UPDATE products SET name=?, short_code=?, barcode=?, category=?, unit=?, sell_price=?, min_stock=?, updated_at=?, synced_at=? WHERE id=?`
    ).run(...fields, ts, ts, entityId);
  } else {
    db.prepare(
      `INSERT INTO products (id, name, short_code, barcode, category, unit, sell_price, min_stock, created_at, updated_at, is_deleted, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`
    ).run(entityId, ...fields, ts, ts, ts);
  }
}

function applyPulledStockBatch(db, entityId, operation, payload) {
  const ts = nowIso();
  if (operation === 'delete') {
    db.prepare(`UPDATE stock_batches SET is_deleted = 1, updated_at = ?, synced_at = ? WHERE id = ?`).run(ts, ts, entityId);
    return;
  }
  if (!db.prepare(`SELECT id FROM products WHERE id = ?`).get(payload.product_id)) return; // product hasn't arrived yet — retry next pull
  const existing = db.prepare(`SELECT quantity_received, quantity_remaining FROM stock_batches WHERE id = ?`).get(entityId);
  if (existing && hasPendingLocalChange(db, 'stock_batch', entityId)) return; // this till created it and the cloud hasn't seen it yet

  // A QUANTITY NEVER ARRIVES AS AN ABSOLUTE VALUE. The cloud's quantity_remaining already
  // reflects sales this till has not pushed yet (and sales other tills made, which arrive
  // separately as sale lines and are deducted by applyPulledSaleItem). Overwriting local stock
  // with it silently erased offline sales or deducted sales twice. Instead:
  //   - an EXISTING batch keeps its local quantity; if the cloud's quantity_received changed
  //     (an owner's stock correction) the SAME delta is applied locally;
  //   - a NEW batch starts at quantity_received, and the pulled sale lines that consumed it
  //     deduct from it exactly once.
  const received = payload.quantity_received || 0;
  if (existing) {
    const delta = received - existing.quantity_received;
    const remaining = Math.max(0, existing.quantity_remaining + delta);
    db.prepare(
      `UPDATE stock_batches SET product_id=?, batch_number=?, quantity_received=?, quantity_remaining=?, cost_price=?, expiry_date=?, updated_at=?, synced_at=? WHERE id=?`
    ).run(payload.product_id, payload.batch_number || '', received, remaining, payload.cost_price || 0, payload.expiry_date || null, ts, ts, entityId);
  } else {
    db.prepare(
      `INSERT INTO stock_batches (id, product_id, batch_number, quantity_received, quantity_remaining, cost_price, expiry_date, received_date, created_at, updated_at, is_deleted, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`
    ).run(entityId, payload.product_id, payload.batch_number || '', received, received, payload.cost_price || 0, payload.expiry_date || null, ts, ts, ts, ts);
  }
}

function applyPulledCustomer(db, entityId, operation, payload) {
  const ts = nowIso();
  if (operation === 'delete') {
    db.prepare(`UPDATE customers SET is_deleted = 1, updated_at = ?, synced_at = ? WHERE id = ?`).run(ts, ts, entityId);
    return;
  }
  const existing = db.prepare(`SELECT updated_at FROM customers WHERE id = ?`).get(entityId);
  if (existing && hasPendingLocalChange(db, 'customer', entityId)) return; // unpushed local edit — keep it
  const fields = [payload.name, payload.phone || '', payload.email || '', payload.address || '', payload.notes || ''];
  if (existing) {
    db.prepare(`UPDATE customers SET name=?, phone=?, email=?, address=?, notes=?, updated_at=?, synced_at=? WHERE id=?`)
      .run(...fields, ts, ts, entityId);
  } else {
    db.prepare(
      `INSERT INTO customers (id, name, phone, email, address, notes, created_at, updated_at, is_deleted, synced_at)
       VALUES (?,?,?,?,?,?,?,?,0,?)`
    ).run(entityId, ...fields, ts, ts, ts);
  }
}

function applyPulledSale(db, entityId, operation, payload) {
  const ts = nowIso();
  const existing = db.prepare(`SELECT id FROM sales WHERE id = ?`).get(entityId);

  if (operation === 'delete') {
    if (!existing) return;
    for (const item of db.prepare(`SELECT id FROM sale_items WHERE sale_id = ?`).all(entityId)) {
      restoreStock(db, item.id);
    }
    db.prepare(`UPDATE sales SET is_deleted = 1, updated_at = ?, synced_at = ? WHERE id = ?`).run(ts, ts, entityId);
    return;
  }

  const fields = [payload.customer_id || null, payload.customer_name || 'Walk-in', payload.staff_name || '',
    payload.payment_method || 'cash', payload.status || 'completed', payload.amount_paid || 0, payload.invoice_number ?? null];
  if (existing) {
    // Field updates only (e.g. an installment paid off via the web) —
    // NEVER re-touch stock/allocations for a sale that was already applied.
    db.prepare(
      `UPDATE sales SET customer_id=?, customer_name=?, staff_name=?, payment_method=?, status=?, amount_paid=?, invoice_number=?, updated_at=?, synced_at=? WHERE id=?`
    ).run(...fields, ts, ts, entityId);
  } else {
    // receipt_no is only present once the cloud stores it (older clouds leave it out: NULL, which the
    // unique index ignores). A receipt number already used by ANOTHER local sale is dropped rather than
    // allowed to make the whole pull fail.
    const receiptNo = payload.receipt_no && !db.prepare(`SELECT 1 FROM sales WHERE receipt_no = ?`).get(payload.receipt_no)
      ? payload.receipt_no : null;
    db.prepare(
      `INSERT INTO sales (id, invoice_number, receipt_no, customer_id, customer_name, staff_name, payment_method, status, amount_paid, date, created_at, updated_at, is_deleted, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(entityId, payload.invoice_number ?? null, receiptNo, payload.customer_id || null, payload.customer_name || 'Walk-in',
      payload.staff_name || '', payload.payment_method || 'cash', payload.status || 'completed', payload.amount_paid || 0,
      payload.date || ts, ts, ts, ts);
  }
  if (Array.isArray(payload.payments)) mergePulledPayments(db, entityId, payload.payments, payload.status);
}

/**
 * A cloud on sync protocol 2 sends every payment with the sale. Payments are merged by id, never
 * replaced, and amount_paid is then the sum of what this till holds: its own payments (even ones
 * not uploaded yet) plus any taken elsewhere, e.g. an installment paid on the web.
 *
 * A "legacy" cloud payment is one lump standing in for an amount recorded before payments were
 * itemised. When this till already has its own itemised payments for the sale, that lump is the
 * SAME money again, so it is not added (it would count twice).
 */
function mergePulledPayments(db, saleId, payments, pulledStatus) {
  const ts = nowIso();
  const localIds = new Set(db.prepare(`SELECT id FROM sale_payments WHERE sale_id = ?`).all(saleId).map((r) => r.id));
  const hasOwnPayments = (legacyId) => [...localIds].some((id) => id !== legacyId);
  const insert = db.prepare(
    `INSERT INTO sale_payments (id, sale_id, shift_id, method, amount, tendered, change_given, reference, paid_at, created_at, is_deleted)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0)`
  );
  for (const p of payments) {
    if (!p || !p.id) continue;
    const amount = money2(p.amount);
    if (localIds.has(p.id)) {
      // Only a legacy lump can change (an older till re-sent its total); itemised payments never do.
      if (p.source === 'legacy') db.prepare(`UPDATE sale_payments SET amount = ? WHERE id = ?`).run(amount, p.id);
      continue;
    }
    if (p.source === 'legacy' && hasOwnPayments(p.id)) continue;
    insert.run(p.id, saleId, PAYMENT_METHODS.includes(p.method) ? p.method : 'cash', amount,
      p.tendered == null ? null : money2(p.tendered), money2(p.change_given || 0), String(p.reference || ''), p.paid_at || ts, ts);
    localIds.add(p.id);
  }
  const paid = money2(db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM sale_payments WHERE sale_id = ? AND is_deleted = 0`).get(saleId).n);
  const sale = getSale(db, saleId);
  const status = sale.items.length > 0 && paid >= sale.total - 0.005 ? 'completed' : (pulledStatus || sale.status);
  db.prepare(`UPDATE sales SET amount_paid = ?, status = ? WHERE id = ?`).run(paid, status, saleId);
}

function applyPulledSaleItem(db, entityId, operation, payload) {
  const ts = nowIso();
  if (operation === 'delete') {
    db.prepare(`UPDATE sale_items SET is_deleted = 1, updated_at = ?, synced_at = ? WHERE id = ?`).run(ts, ts, entityId);
    return;
  }
  if (db.prepare(`SELECT id FROM sale_items WHERE id = ?`).get(entityId)) {
    // Already applied — never re-deduct stock for it. BUT stock_shortfall
    // is purely informational (never touches quantity/stock), and the
    // cloud's own independent allocation (sales/views.py's
    // _allocate_stock, run with real cross-till knowledge via Postgres
    // row locks) is the authoritative shortfall figure — more trustworthy
    // than whatever this till guessed locally when it first created the
    // row. Let that one authoritative number overwrite the local guess;
    // nothing else about the row changes.
    if (payload.stock_shortfall != null) {
      db.prepare(`UPDATE sale_items SET stock_shortfall = ?, updated_at = ?, synced_at = ? WHERE id = ?`)
        .run(payload.stock_shortfall, ts, ts, entityId);
    }
    return;
  }
  if (!db.prepare(`SELECT id FROM sales WHERE id = ?`).get(payload.sale_id)) return; // sale header hasn't arrived yet — retry next pull

  db.prepare(
    `INSERT INTO sale_items (id, sale_id, product_id, item_name, category, quantity, unit_price, unit_cost, discount, stock_shortfall, created_at, updated_at, is_deleted, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(entityId, payload.sale_id, payload.product_id || null, payload.item_name || '', payload.category || '',
    payload.quantity || 1, payload.unit_price || 0, payload.unit_cost || 0, payload.discount || 0,
    payload.stock_shortfall || 0, ts, ts, ts);

  // The one case pulling a sale item actually changes something besides
  // the sales tables: deduct THIS desktop's own local stock so it stays
  // accurate for a sale that happened somewhere else entirely. This can
  // ALSO come up short (this till's own locally-known stock wasn't
  // enough either) — if so, that's a SEPARATE local shortfall on top of
  // whatever the cloud already recorded above, so add rather than
  // overwrite it.
  if (payload.product_id) {
    const { shortfall } = allocateStock(db, entityId, payload.product_id, payload.quantity || 1);
    if (shortfall > 0) {
      db.prepare(`UPDATE sale_items SET stock_shortfall = stock_shortfall + ? WHERE id = ?`).run(shortfall, entityId);
    }
  }
}

const PULL_HANDLERS = {
  product: applyPulledProduct,
  stock_batch: applyPulledStockBatch,
  customer: applyPulledCustomer,
  sale: applyPulledSale,
  sale_item: applyPulledSaleItem,
};

function applyPulledOperation(db, entityType, operation, payload) {
  const handler = PULL_HANDLERS[entityType];
  if (handler) handler(db, payload.id, operation, payload);
}

function computeItemTotals(item) {
  const subtotal = item.unit_price * item.quantity;
  const total = subtotal - item.discount;
  const profit = (item.unit_price - item.unit_cost) * item.quantity - item.discount;
  return { subtotal, total, profit };
}

/**
 * A sale row plus its live items -> the shape every caller receives. The ONE place totals, profit
 * and balance are computed, shared by getSale (one sale) and the list functions (many sales), so
 * a number can never differ depending on which screen you look at it from.
 */
function buildSale(sale, items, payments = []) {
  const itemsWithTotals = items.map((i) => ({ ...i, ...computeItemTotals(i) }));
  const total = itemsWithTotals.reduce((s, i) => s + i.total, 0);
  const profit = itemsWithTotals.reduce((s, i) => s + i.profit, 0);
  const balance_due = sale.status === 'completed' ? 0 : Math.max(total - sale.amount_paid, 0);
  return { ...sale, items: itemsWithTotals, payments, total: Math.round(total * 100) / 100, profit: Math.round(profit * 100) / 100, balance_due };
}

function getSale(db, saleId) {
  const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(saleId);
  if (!sale) return null;
  const items = db.prepare(`SELECT * FROM sale_items WHERE sale_id = ? AND is_deleted = 0 ORDER BY rowid`).all(saleId);
  const payments = db.prepare(`SELECT * FROM sale_payments WHERE sale_id = ? AND is_deleted = 0 ORDER BY rowid`).all(saleId);
  return buildSale(sale, items, payments);
}

/** Live payments for many sales at once (same batching as loadItemsBySale). */
function loadPaymentsBySale(db, saleIds) {
  const bySale = new Map();
  for (let i = 0; i < saleIds.length; i += 500) {
    const chunk = saleIds.slice(i, i + 500);
    const rows = db.prepare(
      `SELECT * FROM sale_payments WHERE is_deleted = 0 AND sale_id IN (${chunk.map(() => '?').join(',')}) ORDER BY rowid`
    ).all(...chunk);
    for (const row of rows) {
      let list = bySale.get(row.sale_id);
      if (!list) { list = []; bySale.set(row.sale_id, list); }
      list.push(row);
    }
  }
  return bySale;
}

/** Live items for many sales at once (one query per 500 sale ids; SQLite limits bound parameters). */
function loadItemsBySale(db, saleIds) {
  const bySale = new Map();
  for (let i = 0; i < saleIds.length; i += 500) {
    const chunk = saleIds.slice(i, i + 500);
    const rows = db.prepare(
      `SELECT * FROM sale_items WHERE is_deleted = 0 AND sale_id IN (${chunk.map(() => '?').join(',')}) ORDER BY rowid`
    ).all(...chunk);
    for (const row of rows) {
      let list = bySale.get(row.sale_id);
      if (!list) { list = []; bySale.set(row.sale_id, list); }
      list.push(row);
    }
  }
  return bySale;
}

/**
 * Rings up a cart. Fully offline-capable: nothing here touches the
 * network. Wrapped in a single SQLite transaction so a crash mid-sale
 * can never leave stock half-deducted with no sale row to explain it.
 */
const createSale = (db) => db.transaction((input) => {
  const saleId = uuid();
  const ts = nowIso();
  const status = input.status || 'completed';
  const invoiceNumber = nextInvoiceNumber(db);
  // <till code>-<counter>: the counter never repeats on this till and the till code differs between
  // tills, so two tills can never print the same receipt number (the plain invoice number restarts
  // at 1 on every till, so those DO collide).
  const receiptNo = `${deviceCode(db)}-${String(invoiceNumber).padStart(6, '0')}`;
  const shift = input.cart_owner ? getOpenShift(db, input.cart_owner) : null;

  db.prepare(
    `INSERT INTO sales (id, invoice_number, receipt_no, shift_id, customer_id, customer_name, staff_name, payment_method, status, amount_paid, date, created_at, updated_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(saleId, invoiceNumber, receiptNo, shift ? shift.id : null, input.customer_id || null, input.customer_name || 'Walk-in', input.staff_name || '', input.payment_method || 'cash', status, 0, ts, ts, ts);

  for (const item of input.items) {
    const itemId = uuid();
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, product_id, item_name, category, quantity, unit_price, unit_cost, discount, created_at, updated_at, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(itemId, saleId, item.product_id || null, item.item_name, item.category || '', item.quantity, item.unit_price, item.unit_cost || 0, item.discount || 0, ts, ts);

    if (item.product_id) {
      const { unitCost, shortfall } = allocateStock(db, itemId, item.product_id, item.quantity);
      if (unitCost) db.prepare(`UPDATE sale_items SET unit_cost = ? WHERE id = ?`).run(unitCost, itemId);
      // shortfall > 0 means THIS till's own locally-known stock ran out
      // mid-sale — e.g. another till (or the web) already sold what this
      // till still believed was available, and that hasn't synced down
      // yet. Recorded rather than discarded (as it silently was before)
      // so the till itself flags it immediately, and so it survives the
      // sync round-trip for the cloud/owner to see too — see the cloud's
      // OWN independent allocation in sales/views.py's _allocate_stock,
      // which is the authoritative check across every till, not just
      // this one's local view.
      if (shortfall > 0) db.prepare(`UPDATE sale_items SET stock_shortfall = ? WHERE id = ?`).run(shortfall, itemId);
    }
  }

  // Payments are validated against the real total (known only now, after the items are in). Any
  // problem throws, and the whole sale (items, stock, outbox rows) rolls back with it.
  const total = getSale(db, saleId).total;
  let payments;
  if (Array.isArray(input.payments) && input.payments.length > 0) {
    payments = input.payments.map(cleanPayment);
    const entered = money2(payments.reduce((sum, p) => sum + p.amount, 0));
    if (status === 'completed' && Math.abs(entered - total) > 0.005) {
      throw new Error(`Payments must add up to the total (${total.toFixed(2)} due, ${entered.toFixed(2)} entered).`);
    }
    if (entered - total > 0.005) throw new Error(`Payments add up to more than the total (${total.toFixed(2)}).`);
  } else {
    // The ordinary one-method sale (and the installment deposit): one payment row.
    const applied = status === 'completed' ? total : Math.min(money2(input.amount_paid || 0), total);
    payments = applied > 0 ? [cleanPayment({ method: input.payment_method || 'cash', amount: applied })] : [];
  }
  const amountPaid = money2(payments.reduce((sum, p) => sum + p.amount, 0));
  const insertPayment = db.prepare(
    `INSERT INTO sale_payments (id, sale_id, shift_id, method, amount, tendered, change_given, reference, paid_at, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  );
  for (const p of payments) {
    insertPayment.run(uuid(), saleId, shift ? shift.id : null, p.method, p.amount, p.tendered, p.change_given, p.reference, ts, ts);
  }
  // The legacy single `payment_method` column (what the cloud, the web app and older reports read)
  // holds the method that paid the MOST; the full breakdown lives in sale_payments.
  const dominant = payments.length ? payments.reduce((a, b) => (b.amount > a.amount ? b : a)).method : (input.payment_method || 'cash');
  const settled = total - amountPaid <= 0.005;
  db.prepare(`UPDATE sales SET amount_paid = ?, payment_method = ?, status = ? WHERE id = ?`)
    .run(amountPaid, dominant, settled ? 'completed' : status, saleId);

  // The cart that produced this sale is no longer unfinished work. Cleared HERE, inside the sale's
  // own transaction: a crash can never leave "sale recorded AND cart still offered", which would
  // invite ringing the same customer up twice. (A failed sale rolls this back too, so the cart stays.)
  if (input.cart_owner) db.prepare(`DELETE FROM carts WHERE id = ?`).run(draftId(input.cart_owner));

  const finalSale = getSale(db, saleId);
  if (cloudSyncProtocol(db) >= 2) {
    // ONE outbox row carries the whole sale (header, lines, payments); the cloud applies it in one
    // transaction, so it can never hold a sale with only some of its lines.
    enqueueSync(db, { entityType: 'sale_doc', entityId: saleId, operation: 'create', payload: finalSale });
  } else {
    enqueueSync(db, { entityType: 'sale', entityId: saleId, operation: 'create', payload: finalSale });
    for (const item of finalSale.items) {
      enqueueSync(db, { entityType: 'sale_item', entityId: item.id, operation: 'create', payload: item });
    }
  }
  return finalSale;
});

const deleteSale = (db) => db.transaction((saleId) => {
  const sale = getSale(db, saleId);
  if (!sale) return null;
  const ts = nowIso();
  for (const item of sale.items) {
    restoreStock(db, item.id);
    db.prepare(`UPDATE sale_items SET is_deleted = 1, updated_at = ? WHERE id = ?`).run(ts, item.id);
  }
  db.prepare(`UPDATE sales SET is_deleted = 1, updated_at = ? WHERE id = ?`).run(ts, saleId);
  enqueueSync(db, { entityType: 'sale', entityId: saleId, operation: 'delete', payload: { id: saleId } });
  return true;
});

const addPayment = (db) => db.transaction((saleId, amount, opts = {}) => {
  const sale = getSale(db, saleId);
  if (!sale) throw new Error('That sale no longer exists.');
  const balance = Math.max(money2(sale.total - sale.amount_paid), 0);
  if (balance <= 0) throw new Error('This sale has nothing left to pay.');
  // What is recorded is what was APPLIED to the debt, never more: paying 9,999 against a 500 balance
  // is a 500 payment (the rest is change, not revenue).
  const applied = money2(Math.min(Number(amount), balance));
  if (!(applied > 0)) throw new Error('Enter an amount greater than zero.');
  const payment = cleanPayment({ method: opts.method || sale.payment_method || 'cash', amount: applied, tendered: opts.tendered, reference: opts.reference });
  const shift = opts.owner ? getOpenShift(db, opts.owner) : null;
  const ts = nowIso();
  const paymentId = uuid();
  db.prepare(
    `INSERT INTO sale_payments (id, sale_id, shift_id, method, amount, tendered, change_given, reference, paid_at, created_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(paymentId, saleId, shift ? shift.id : null, payment.method, payment.amount, payment.tendered, payment.change_given, payment.reference, ts, ts);
  const newPaid = money2(sale.amount_paid + applied);
  const newStatus = newPaid >= sale.total - 0.005 ? 'completed' : sale.status;
  db.prepare(`UPDATE sales SET amount_paid = ?, status = ?, updated_at = ? WHERE id = ?`)
    .run(newPaid, newStatus, ts, saleId);
  const updated = getSale(db, saleId);
  if (cloudSyncProtocol(db) >= 2) {
    // Append-only: the cloud ADDS this payment, so one taken on the web meanwhile still counts.
    const row = db.prepare(`SELECT * FROM sale_payments WHERE id = ?`).get(paymentId);
    enqueueSync(db, { entityType: 'sale_payment', entityId: paymentId, operation: 'create', payload: row });
  } else {
    enqueueSync(db, { entityType: 'sale', entityId: saleId, operation: 'update', payload: updated });
  }
  return updated;
});

/**
 * Sales, newest first. `limit`/`offset` page through them (omit both for everything, as before).
 * Used to load EVERY sale ever made and run two queries per sale before filtering by status in
 * JavaScript, so the history screen got slower with every sale and froze the till after a while.
 */
function listSales(db, { status = null, limit = null, offset = 0 } = {}) {
  const where = ['is_deleted = 0'];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  let sql = `SELECT * FROM sales WHERE ${where.join(' AND ')} ORDER BY date DESC, rowid DESC`;
  if (limit != null) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(Math.max(0, Math.floor(Number(limit)) || 0), Math.max(0, Math.floor(Number(offset)) || 0));
  }
  const sales = db.prepare(sql).all(...params);
  const ids = sales.map((s) => s.id);
  const items = loadItemsBySale(db, ids);
  const payments = loadPaymentsBySale(db, ids);
  return sales.map((s) => buildSale(s, items.get(s.id) || [], payments.get(s.id) || []));
}

/**
 * Keeps sync_queue from growing forever. A 'synced' row has done its
 * job — the entity it described already landed on the cloud — so it's
 * safe to delete outright rather than keep marking rows 'synced' forever
 * (which is what this replaced). 'failed' rows are kept longer since
 * they're useful for debugging why something was rejected, but still
 * pruned eventually so a permanently-broken row can't sit there forever
 * either. This is the ENTIRE cost of tracking sync state — one small
 * table in the same SQLite file, actively kept small, never a second
 * database.
 */
function pruneSyncQueue(db) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // keep a day of history either way, for debugging
  db.prepare(`DELETE FROM sync_queue WHERE status = 'synced' AND client_timestamp < ?`).run(cutoff);
  // 'failed' rows are deliberately NEVER pruned: each one is a sale/stock change that exists on
  // this till and nowhere else. Deleting them after a week silently destroyed the only copy of
  // that fact. They stay (and stay visible) until someone retries them.
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------
// The three methods the cloud already knows (sales.models.Sale.PAYMENT_CHOICES).
const PAYMENT_METHODS = ['cash', 'transfer', 'pos'];

/** Money to the kobo. Float dust (0.1 + 0.2) must never decide whether payments "add up". */
const money2 = (n) => Math.round(Number(n) * 100) / 100;

/** Short, readable code identifying THIS till on its receipts (first 6 hex digits of its permanent id). */
function deviceCode(db) {
  return getOrCreateDeviceId(db).replace(/-/g, '').slice(0, 6).toUpperCase();
}

/** One validated payment line. Throws a plain-English message the cashier can act on. */
function cleanPayment(p) {
  if (!p || !PAYMENT_METHODS.includes(p.method)) throw new Error('Choose a valid payment method (cash, transfer or card).');
  const amount = money2(p.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Each payment needs an amount greater than zero.');
  let tendered = null;
  let change = 0;
  if (p.method === 'cash' && p.tendered !== undefined && p.tendered !== null && p.tendered !== '') {
    tendered = money2(p.tendered);
    if (!Number.isFinite(tendered) || tendered < amount) throw new Error('The cash handed over cannot be less than the amount paid in cash.');
    change = money2(tendered - amount);
  }
  return { method: p.method, amount, tendered, change_given: change, reference: String(p.reference || '').trim().slice(0, 64) };
}

/**
 * Sales that existed before payments did get one payment row (their old method + amount_paid), once.
 * Runs on every open; the NOT EXISTS makes it a no-op afterwards.
 */
function backfillPayments(db) {
  const rows = db.prepare(
    `SELECT id, payment_method, amount_paid, date FROM sales
     WHERE amount_paid > 0 AND NOT EXISTS (SELECT 1 FROM sale_payments p WHERE p.sale_id = sales.id)`
  ).all();
  if (rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO sale_payments (id, sale_id, shift_id, method, amount, tendered, change_given, reference, paid_at, created_at, is_deleted)
     VALUES (?, ?, NULL, ?, ?, NULL, 0, '', ?, ?, 0)`
  );
  db.transaction(() => {
    for (const r of rows) {
      insert.run(uuid(), r.id, PAYMENT_METHODS.includes(r.payment_method) ? r.payment_method : 'cash', r.amount_paid, r.date, nowIso());
    }
  })();
}

// ---------------------------------------------------------------------------------------------
// Shifts and the Z-report. Local bookkeeping: nothing here is enqueued for sync (yet).
// ---------------------------------------------------------------------------------------------
function getOpenShift(db, owner) {
  return db.prepare(`SELECT * FROM shifts WHERE owner = ? AND status = 'open'`).get(owner) || null;
}

function openShift(db, owner, openingFloat) {
  const float = openingFloat === null || openingFloat === undefined || openingFloat === '' ? NaN : money2(openingFloat);
  if (!Number.isFinite(float) || float < 0) throw new Error('Enter the opening cash float (zero or more).');
  if (getOpenShift(db, owner)) throw new Error('You already have a shift open. Close it before opening another.');
  const id = uuid();
  db.prepare(`INSERT INTO shifts (id, owner, status, opened_at, opening_float) VALUES (?, ?, 'open', ?, ?)`).run(id, owner, nowIso(), float);
  return db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(id);
}

function addCashMovement(db, owner, { kind, amount, reason } = {}) {
  const shift = getOpenShift(db, owner);
  if (!shift) throw new Error('There is no open shift. Open one before moving cash in or out.');
  if (kind !== 'paid_in' && kind !== 'paid_out') throw new Error('Unknown cash movement kind.');
  const value = money2(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Enter an amount greater than zero.');
  if (!String(reason || '').trim()) throw new Error('Say why: a reason is required for every cash movement.');
  const id = uuid();
  db.prepare(`INSERT INTO cash_movements (id, shift_id, kind, amount, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, shift.id, kind, value, String(reason).trim(), nowIso());
  return db.prepare(`SELECT * FROM cash_movements WHERE id = ?`).get(id);
}

/** The shift's numbers, computed from the books. Open shift = live (X-report); closed = frozen copy is used instead. */
function computeShiftReport(db, shift) {
  const sales = db.prepare(`SELECT * FROM sales WHERE shift_id = ? AND is_deleted = 0 ORDER BY date, rowid`).all(shift.id);
  const items = loadItemsBySale(db, sales.map((s) => s.id));
  const built = sales.map((s) => buildSale(s, items.get(s.id) || []));
  const owing = built.filter((s) => s.status === 'outstanding');

  // Payments taken DURING this shift, whenever the sale itself was made (an installment collected
  // today belongs to today's drawer). Payments on deleted (voided) sales are excluded: that money went back.
  const byMethod = { cash: 0, transfer: 0, pos: 0 };
  for (const row of db.prepare(
    `SELECT p.method AS method, SUM(p.amount) AS amount FROM sale_payments p JOIN sales s ON s.id = p.sale_id
     WHERE p.shift_id = ? AND p.is_deleted = 0 AND s.is_deleted = 0 GROUP BY p.method`
  ).all(shift.id)) byMethod[row.method] = money2(row.amount);

  const movement = (kind) => money2(db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM cash_movements WHERE shift_id = ? AND kind = ?`).get(shift.id, kind).n);
  const paidIn = movement('paid_in');
  const paidOut = movement('paid_out');
  const voided = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_paid), 0) AS paid FROM sales WHERE shift_id = ? AND is_deleted = 1`).get(shift.id);

  return {
    shift: { id: shift.id, owner: shift.owner, status: shift.status, opened_at: shift.opened_at, closed_at: shift.closed_at, z_number: shift.z_number, notes: shift.notes || '' },
    sales: {
      count: built.length,
      gross: money2(built.reduce((sum, s) => sum + s.total, 0)),
      discounts: money2(built.reduce((sum, s) => sum + s.items.reduce((d, i) => d + Number(i.discount || 0), 0), 0)),
    },
    payments: { total: money2(byMethod.cash + byMethod.transfer + byMethod.pos), by_method: byMethod },
    cash: {
      opening_float: shift.opening_float,
      cash_sales: byMethod.cash,
      paid_in: paidIn,
      paid_out: paidOut,
      expected: money2(shift.opening_float + byMethod.cash + paidIn - paidOut),
      counted: null,
      variance: null,
    },
    voided: { count: voided.n, paid: money2(voided.paid) },
    outstanding: { count: owing.length, balance: money2(owing.reduce((sum, s) => sum + s.balance_due, 0)) },
    first_receipt: built.length ? built[0].receipt_no : null,
    last_receipt: built.length ? built[built.length - 1].receipt_no : null,
  };
}

/**
 * Closes the cashier's shift. The cashier supplies what they COUNTED (they are not shown the expected
 * figure first); the variance is computed here and recorded, never adjusted. The finished report is
 * frozen: it is stored and returned verbatim from then on, so later edits can't rewrite history.
 */
function closeShift(db, owner, { countedCash, notes = '' } = {}) {
  return db.transaction(() => {
    const shift = getOpenShift(db, owner);
    if (!shift) throw new Error('There is no open shift to close.');
    const counted = countedCash === null || countedCash === undefined || countedCash === '' ? NaN : money2(countedCash);
    if (!Number.isFinite(counted) || counted < 0) throw new Error('Enter the cash you counted in the drawer (zero or more).');

    const closedAt = nowIso();
    const nextZ = Number((db.prepare(`SELECT value FROM app_settings WHERE key = 'next_z_number'`).get() || { value: 1 }).value);
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('next_z_number', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(nextZ + 1));

    const report = computeShiftReport(db, { ...shift, status: 'closed', closed_at: closedAt, z_number: nextZ, notes: String(notes || '').trim() });
    report.cash.counted = counted;
    report.cash.variance = money2(counted - report.cash.expected);
    const frozen = JSON.parse(JSON.stringify(report));
    db.prepare(
      `UPDATE shifts SET status = 'closed', closed_at = ?, counted_cash = ?, expected_cash = ?, variance = ?, z_number = ?, notes = ?, report_json = ? WHERE id = ?`
    ).run(closedAt, counted, report.cash.expected, report.cash.variance, nextZ, frozen.shift.notes, JSON.stringify(frozen), shift.id);
    return frozen;
  })();
}

function getShiftReport(db, shiftId) {
  const shift = db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shiftId);
  if (!shift) return null;
  if (shift.status === 'closed' && shift.report_json) return JSON.parse(shift.report_json);
  return computeShiftReport(db, shift);
}

function listShifts(db, { owner = null, limit = 50 } = {}) {
  const rows = owner
    ? db.prepare(`SELECT id, owner, status, opened_at, closed_at, opening_float, counted_cash, expected_cash, variance, z_number FROM shifts WHERE owner = ? ORDER BY opened_at DESC LIMIT ?`).all(owner, limit)
    : db.prepare(`SELECT id, owner, status, opened_at, closed_at, opening_float, counted_cash, expected_cash, variance, z_number FROM shifts ORDER BY opened_at DESC LIMIT ?`).all(limit);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Unfinished carts (see the `carts` table). Local only: nothing here is ever enqueued for sync.
// ---------------------------------------------------------------------------------------------
const MAX_CART_LINES = 300;
const MAX_CART_BYTES = 256 * 1024;
const draftId = (owner) => `draft:${owner}`;

function serializeCart(cart) {
  const lines = Array.isArray(cart && cart.lines) ? cart.lines : [];
  const json = JSON.stringify({
    lines,
    customer: (cart && cart.customer) || null,
    customerName: (cart && cart.customerName) || '',
  });
  if (lines.length > MAX_CART_LINES || json.length > MAX_CART_BYTES) throw new Error('This cart is too large to save.');
  return { lines, json };
}

function cartSummary(row) {
  const cart = JSON.parse(row.cart_json);
  return {
    id: row.id,
    label: row.label,
    updated_at: row.updated_at,
    item_count: cart.lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0),
    total: cart.lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0),
  };
}

/** Saves (or, if the cart is empty, removes) the cashier's active cart. Cheap enough to call on every change. */
function saveDraft(db, owner, cart) {
  const { lines, json } = serializeCart(cart);
  if (lines.length === 0) {
    db.prepare(`DELETE FROM carts WHERE id = ?`).run(draftId(owner));
    return { saved: false };
  }
  db.prepare(
    `INSERT INTO carts (id, owner, status, label, cart_json, updated_at) VALUES (?, ?, 'draft', '', ?, ?)
     ON CONFLICT(id) DO UPDATE SET cart_json = excluded.cart_json, updated_at = excluded.updated_at`
  ).run(draftId(owner), owner, json, nowIso());
  return { saved: true };
}

function loadDraft(db, owner) {
  const row = db.prepare(`SELECT cart_json FROM carts WHERE id = ?`).get(draftId(owner));
  return row ? JSON.parse(row.cart_json) : null;
}

/** Sets the cart aside to serve someone else. Atomic: it is never in both places, or neither. */
function parkCart(db, owner, cart, label = '') {
  return db.transaction(() => {
    const { lines, json } = serializeCart(cart);
    if (lines.length === 0) throw new Error('There is nothing in the cart to park.');
    const id = uuid();
    const ts = nowIso();
    const first = lines[0];
    const autoLabel = label || `${first.item_name || 'Cart'}${lines.length > 1 ? ` +${lines.length - 1} more` : ''}`;
    db.prepare(`INSERT INTO carts (id, owner, status, label, cart_json, updated_at) VALUES (?, ?, 'parked', ?, ?, ?)`).run(id, owner, autoLabel, json, ts);
    db.prepare(`DELETE FROM carts WHERE id = ?`).run(draftId(owner));
    return cartSummary({ id, label: autoLabel, cart_json: json, updated_at: ts });
  })();
}

function listParked(db, owner) {
  return db.prepare(`SELECT * FROM carts WHERE owner = ? AND status = 'parked' ORDER BY updated_at DESC`).all(owner).map(cartSummary);
}

/**
 * Brings a parked cart back as the active one. If a cart is ALREADY active it is parked first,
 * in the same transaction, so swapping between customers can never destroy someone's cart.
 */
function resumeParked(db, owner, id) {
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM carts WHERE id = ? AND owner = ? AND status = 'parked'`).get(id, owner);
    if (!row) throw new Error('That parked cart no longer exists.');
    const current = loadDraft(db, owner);
    db.prepare(`DELETE FROM carts WHERE id = ?`).run(id);
    if (current && current.lines.length > 0) parkCart(db, owner, current);   // nested: becomes a savepoint
    const cart = JSON.parse(row.cart_json);
    saveDraft(db, owner, cart);
    return cart;
  })();
}

function discardParked(db, owner, id) {
  return db.prepare(`DELETE FROM carts WHERE id = ? AND owner = ? AND status = 'parked'`).run(id, owner).changes;
}

function getSyncQueueStats(db) {
  const count = (status) => db.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE status = ?`).get(status).n;
  return { pending: count('pending'), failed: count('failed') };
}

/** Puts every failed row back in line (fresh attempt counter, no backoff). Returns how many. */
// The cloud's answer when an operation id it has already recorded comes back with different
// content (sync/views.py _REUSED_ID_ERROR). Resending the same id can never succeed, so a retry
// gives such a row a fresh id. That is safe: the cloud upserts by the entity's own id, so the
// entity is still never created twice.
const REUSED_ID_MARKER = 'already used for different content';

const retryFailedSync = (db) => db.transaction(() => {
  const reused = db.prepare(`SELECT id FROM sync_queue WHERE status = 'failed' AND last_error LIKE ?`)
    .all(`%${REUSED_ID_MARKER}%`);
  const rename = db.prepare(`UPDATE sync_queue SET id = ? WHERE id = ?`);
  for (const row of reused) rename.run(uuid(), row.id);
  return db.prepare(
    `UPDATE sync_queue SET status = 'pending', retry_count = 0, next_attempt_at = NULL WHERE status = 'failed'`
  ).run().changes;
})();

/**
 * Catches the actual root cause of "some products never reached the
 * cloud": a row created before sync existed in this database, or by a
 * code path that (by a bug, or an interrupted write) never called
 * enqueueSync for it at all — meaning it has ZERO sync_queue history,
 * not even a failed attempt. The normal push loop can never fix this on
 * its own, because there's nothing in the outbox for it to find. This
 * walks every syncable table once, finds rows with no sync_queue entry
 * at all (a LEFT JOIN ... IS NULL, not a status check), and queues them
 * fresh. Safe to run repeatedly — a row that's already queued (whatever
 * its status) is never touched twice.
 */
function reconcileUnsyncedRows(db) {
  // A row needs queueing only if the cloud has NEVER confirmed it (synced_at IS NULL: set when a push
  // is acknowledged, and on every row that came FROM the cloud) and nothing in the outbox covers it.
  // Without the synced_at test this re-queued, at every startup, every row whose outbox entry had been
  // pruned (after 24 h) and every row pulled from the cloud: the till re-uploaded its whole history,
  // stale copies and all. A sale queued as one 'sale_doc' covers the sale AND its lines.
  const tables = [
    { table: 'products', entityType: 'product', covered: `q.entity_type = 'product' AND q.entity_id = t.id` },
    { table: 'stock_batches', entityType: 'stock_batch', covered: `q.entity_type = 'stock_batch' AND q.entity_id = t.id` },
    { table: 'customers', entityType: 'customer', covered: `q.entity_type = 'customer' AND q.entity_id = t.id` },
    { table: 'sales', entityType: 'sale', covered: `q.entity_type IN ('sale', 'sale_doc') AND q.entity_id = t.id` },
    { table: 'sale_items', entityType: 'sale_item',
      covered: `(q.entity_type = 'sale_item' AND q.entity_id = t.id) OR (q.entity_type = 'sale_doc' AND q.entity_id = t.sale_id)` },
  ];
  let queued = 0;
  for (const { table, entityType, covered } of tables) {
    const orphans = db.prepare(
      `SELECT t.* FROM ${table} t
       WHERE t.is_deleted = 0 AND t.synced_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM sync_queue q WHERE ${covered})`
    ).all();
    for (const row of orphans) {
      enqueueSync(db, { entityType, entityId: row.id, operation: 'create', payload: row });
      queued += 1;
    }
  }
  if (queued > 0) console.log(`[sync] reconcile: found and queued ${queued} row(s) that had never been synced at all`);
  return queued;
}

/**
 * One-time, on the first open of this version: stamp synced_at on every row that nothing in the
 * outbox covers. Such a row was already confirmed by the cloud: synced outbox rows are the only
 * ones ever pruned, pending and failed ones never are, and pulled rows already carry synced_at.
 * Before this version only pulled rows got synced_at, so without this the first startup after the
 * upgrade would re-upload the till's entire history one last time.
 */
function backfillSyncedAt(db) {
  if (db.prepare(`SELECT 1 FROM app_settings WHERE key = 'synced_at_backfill_v1'`).get()) return;
  const covers = {
    products: `q.entity_type = 'product' AND q.entity_id = t.id`,
    stock_batches: `q.entity_type = 'stock_batch' AND q.entity_id = t.id`,
    customers: `q.entity_type = 'customer' AND q.entity_id = t.id`,
    sales: `q.entity_type IN ('sale', 'sale_doc') AND q.entity_id = t.id`,
    sale_items: `(q.entity_type = 'sale_item' AND q.entity_id = t.id) OR (q.entity_type = 'sale_doc' AND q.entity_id = t.sale_id)`,
  };
  const at = nowIso();
  db.transaction(() => {
    for (const [table, covered] of Object.entries(covers)) {
      db.prepare(
        `UPDATE ${table} AS t SET synced_at = ? WHERE t.synced_at IS NULL AND NOT EXISTS (SELECT 1 FROM sync_queue q WHERE ${covered})`
      ).run(at);
    }
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('synced_at_backfill_v1', ?)`).run(at);
  })();
}

// Which local rows an acknowledged outbox row stands for (sale_payment rows have no synced_at column).
const ACK_TABLES = { product: 'products', stock_batch: 'stock_batches', customer: 'customers', sale: 'sales', sale_item: 'sale_items' };

/** The cloud confirmed this outbox row: stamp synced_at on the local row(s) it carried. */
function markEntitySynced(db, entityType, entityId, at) {
  if (entityType === 'sale_doc') {
    db.prepare(`UPDATE sales SET synced_at = ? WHERE id = ?`).run(at, entityId);
    db.prepare(`UPDATE sale_items SET synced_at = ? WHERE sale_id = ?`).run(at, entityId);
    return;
  }
  const table = ACK_TABLES[entityType];
  if (table) db.prepare(`UPDATE ${table} SET synced_at = ? WHERE id = ?`).run(at, entityId);
}

module.exports = {
  openDb,
  uuid,
  nowIso,
  enqueueSync,
  createProduct,
  getProduct,
  listProducts,
  createCustomer,
  getCustomer,
  listCustomers,
  addStockBatch,
  createSale,
  deleteSale,
  addPayment,
  listSales,
  getSale,
  applyPulledOperation,
  getLastPullAt,
  setLastPullAt,
  getSetting,
  setSetting,
  cloudSyncProtocol,
  pruneSyncQueue,
  openShift,
  getOpenShift,
  addCashMovement,
  closeShift,
  getShiftReport,
  listShifts,
  saveDraft,
  loadDraft,
  parkCart,
  listParked,
  resumeParked,
  discardParked,
  getSyncQueueStats,
  retryFailedSync,
  reconcileUnsyncedRows,
  markEntitySynced,
};