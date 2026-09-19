const Database = require('better-sqlite3');
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
    `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, client_timestamp, status, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`
  ).run(uuid(), entityType, entityId, operation, JSON.stringify(payload), nowIso());
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

function listProducts(db, { category = null, search = '' } = {}) {
  let rows = db.prepare(`SELECT * FROM products WHERE is_deleted = 0 ORDER BY name`).all();
  if (category && category !== 'all') rows = rows.filter((r) => r.category === category);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => `${r.name} ${r.short_code || ''} ${r.barcode || ''}`.toLowerCase().includes(q));
  }
  return rows.map((r) => ({ ...r, ...computeStockFields(db, r.id) }));
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
  return rows.map((r) => {
    const outstanding = db.prepare(
      `SELECT amount_paid, id FROM sales WHERE customer_id = ? AND status = 'outstanding' AND is_deleted = 0`
    ).all(r.id);
    const balanceDue = outstanding.reduce((sum, s) => {
      const sale = getSale(db, s.id);
      return sum + (sale ? sale.balance_due : 0);
    }, 0);
    return { ...r, balance_due: balanceDue, outstanding_sale_count: outstanding.length };
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

function applyPulledProduct(db, entityId, operation, payload) {
  const ts = nowIso();
  if (operation === 'delete') {
    db.prepare(`UPDATE products SET is_deleted = 1, updated_at = ?, synced_at = ? WHERE id = ?`).run(ts, ts, entityId);
    return;
  }
  const existing = db.prepare(`SELECT updated_at FROM products WHERE id = ?`).get(entityId);
  if (existing && existing.updated_at >= (payload.updated_at || ts)) return; // local edit is newer — keep it, next push wins
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
  const existing = db.prepare(`SELECT updated_at FROM stock_batches WHERE id = ?`).get(entityId);
  if (existing && existing.updated_at >= (payload.updated_at || ts)) return;
  const fields = [payload.product_id, payload.batch_number || '', payload.quantity_received || 0,
    payload.quantity_remaining || 0, payload.cost_price || 0, payload.expiry_date || null];
  if (existing) {
    db.prepare(
      `UPDATE stock_batches SET product_id=?, batch_number=?, quantity_received=?, quantity_remaining=?, cost_price=?, expiry_date=?, updated_at=?, synced_at=? WHERE id=?`
    ).run(...fields, ts, ts, entityId);
  } else {
    db.prepare(
      `INSERT INTO stock_batches (id, product_id, batch_number, quantity_received, quantity_remaining, cost_price, expiry_date, received_date, created_at, updated_at, is_deleted, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`
    ).run(entityId, ...fields, ts, ts, ts, ts);
  }
}

function applyPulledCustomer(db, entityId, operation, payload) {
  const ts = nowIso();
  if (operation === 'delete') {
    db.prepare(`UPDATE customers SET is_deleted = 1, updated_at = ?, synced_at = ? WHERE id = ?`).run(ts, ts, entityId);
    return;
  }
  const existing = db.prepare(`SELECT updated_at FROM customers WHERE id = ?`).get(entityId);
  if (existing && existing.updated_at >= (payload.updated_at || ts)) return;
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
    db.prepare(
      `INSERT INTO sales (id, invoice_number, customer_id, customer_name, staff_name, payment_method, status, amount_paid, date, created_at, updated_at, is_deleted, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(entityId, payload.invoice_number ?? null, payload.customer_id || null, payload.customer_name || 'Walk-in',
      payload.staff_name || '', payload.payment_method || 'cash', payload.status || 'completed', payload.amount_paid || 0,
      payload.date || ts, ts, ts, ts);
  }
}

function applyPulledSaleItem(db, entityId, operation, payload) {
  const ts = nowIso();
  if (operation === 'delete') {
    db.prepare(`UPDATE sale_items SET is_deleted = 1, updated_at = ?, synced_at = ? WHERE id = ?`).run(ts, ts, entityId);
    return;
  }
  if (db.prepare(`SELECT id FROM sale_items WHERE id = ?`).get(entityId)) return; // already applied — never re-deduct stock
  if (!db.prepare(`SELECT id FROM sales WHERE id = ?`).get(payload.sale_id)) return; // sale header hasn't arrived yet — retry next pull

  db.prepare(
    `INSERT INTO sale_items (id, sale_id, product_id, item_name, category, quantity, unit_price, unit_cost, discount, created_at, updated_at, is_deleted, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(entityId, payload.sale_id, payload.product_id || null, payload.item_name || '', payload.category || '',
    payload.quantity || 1, payload.unit_price || 0, payload.unit_cost || 0, payload.discount || 0, ts, ts, ts);

  // The one case pulling a sale item actually changes something besides
  // the sales tables: deduct THIS desktop's own local stock so it stays
  // accurate for a sale that happened somewhere else entirely.
  if (payload.product_id) {
    allocateStock(db, entityId, payload.product_id, payload.quantity || 1);
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

function getSale(db, saleId) {
  const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(saleId);
  if (!sale) return null;
  const items = db.prepare(`SELECT * FROM sale_items WHERE sale_id = ? AND is_deleted = 0 ORDER BY rowid`).all(saleId);
  const itemsWithTotals = items.map((i) => ({ ...i, ...computeItemTotals(i) }));
  const total = itemsWithTotals.reduce((s, i) => s + i.total, 0);
  const profit = itemsWithTotals.reduce((s, i) => s + i.profit, 0);
  const balance_due = sale.status === 'completed' ? 0 : Math.max(total - sale.amount_paid, 0);
  return { ...sale, items: itemsWithTotals, total: Math.round(total * 100) / 100, profit: Math.round(profit * 100) / 100, balance_due };
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

  db.prepare(
    `INSERT INTO sales (id, invoice_number, customer_id, customer_name, staff_name, payment_method, status, amount_paid, date, created_at, updated_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(saleId, invoiceNumber, input.customer_id || null, input.customer_name || 'Walk-in', input.staff_name || '', input.payment_method || 'cash', status, input.amount_paid || 0, ts, ts, ts);

  for (const item of input.items) {
    const itemId = uuid();
    db.prepare(
      `INSERT INTO sale_items (id, sale_id, product_id, item_name, category, quantity, unit_price, unit_cost, discount, created_at, updated_at, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(itemId, saleId, item.product_id || null, item.item_name, item.category || '', item.quantity, item.unit_price, item.unit_cost || 0, item.discount || 0, ts, ts);

    if (item.product_id) {
      const { unitCost } = allocateStock(db, itemId, item.product_id, item.quantity);
      if (unitCost) db.prepare(`UPDATE sale_items SET unit_cost = ? WHERE id = ?`).run(unitCost, itemId);
    }
  }

  const sale = getSale(db, saleId);
  if (status === 'completed' && sale.amount_paid !== sale.total) {
    db.prepare(`UPDATE sales SET amount_paid = ? WHERE id = ?`).run(sale.total, saleId);
  }

  const finalSale = getSale(db, saleId);
  enqueueSync(db, { entityType: 'sale', entityId: saleId, operation: 'create', payload: finalSale });
  for (const item of finalSale.items) {
    enqueueSync(db, { entityType: 'sale_item', entityId: item.id, operation: 'create', payload: item });
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

const addPayment = (db) => db.transaction((saleId, amount) => {
  const sale = getSale(db, saleId);
  const newPaid = Math.min(sale.amount_paid + amount, sale.total);
  const newStatus = newPaid >= sale.total ? 'completed' : sale.status;
  db.prepare(`UPDATE sales SET amount_paid = ?, status = ?, updated_at = ? WHERE id = ?`)
    .run(newPaid, newStatus, nowIso(), saleId);
  const updated = getSale(db, saleId);
  enqueueSync(db, { entityType: 'sale', entityId: saleId, operation: 'update', payload: updated });
  return updated;
});

function listSales(db, { status = null } = {}) {
  let rows = db.prepare(`SELECT id FROM sales WHERE is_deleted = 0 ORDER BY date DESC`).all();
  let sales = rows.map((r) => getSale(db, r.id));
  if (status) sales = sales.filter((s) => s.status === status);
  return sales;
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
  const failedCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM sync_queue WHERE status = 'failed' AND client_timestamp < ?`).run(failedCutoff);
}

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
  const tables = [
    { table: 'products', entityType: 'product' },
    { table: 'stock_batches', entityType: 'stock_batch' },
    { table: 'customers', entityType: 'customer' },
    { table: 'sales', entityType: 'sale' },
    { table: 'sale_items', entityType: 'sale_item' },
  ];
  let queued = 0;
  for (const { table, entityType } of tables) {
    const orphans = db.prepare(
      `SELECT t.* FROM ${table} t
       LEFT JOIN sync_queue q ON q.entity_id = t.id AND q.entity_type = ?
       WHERE q.id IS NULL AND t.is_deleted = 0`
    ).all(entityType);
    for (const row of orphans) {
      enqueueSync(db, { entityType, entityId: row.id, operation: 'create', payload: row });
      queued += 1;
    }
  }
  if (queued > 0) console.log(`[sync] reconcile: found and queued ${queued} row(s) that had never been synced at all`);
  return queued;
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
  pruneSyncQueue,
  reconcileUnsyncedRows,
};
