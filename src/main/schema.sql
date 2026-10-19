-- Local SQLite schema for the desktop POS.
-- Mirrors the cloud Django schema closely (same field names, same UUID
-- style ids) so the future sync engine can map rows 1:1 without a
-- translation layer. Every table that represents shop data (not local
-- app config) carries: id (uuid), created_at, updated_at, is_deleted,
-- synced_at (null until the sync engine has confirmed the cloud has it).

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Every payment taken against a sale: one row per method used, so a sale can be paid by cash +
-- transfer + card, and an installment sale collects several payments over time. `amount` is what
-- was APPLIED to the sale; for cash, `tendered` is what the customer handed over and `change_given`
-- what went back, so only `amount` ever stays in the drawer. Not a synced record kind: it travels
-- inside the sale that is uploaded (see getSale / createSale).
CREATE TABLE IF NOT EXISTS sale_payments (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  shift_id TEXT,
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  tendered REAL,
  change_given REAL NOT NULL DEFAULT 0,
  reference TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_shift ON sale_payments(shift_id, method);

-- A cashier's till session: opening float, the sales and payments taken, cash moved in/out, and a
-- frozen Z-report at close. Local bookkeeping for now (not uploaded). One open shift per cashier.
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT NOT NULL,
  opening_float REAL NOT NULL DEFAULT 0,
  closed_at TEXT,
  counted_cash REAL,
  expected_cash REAL,
  variance REAL,
  z_number INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  report_json TEXT,
  synced_at TEXT                   -- when the cloud confirmed it (stage 3); NULL = not uploaded yet
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_shift_per_owner ON shifts(owner) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_shifts_opened ON shifts(opened_at);

CREATE TABLE IF NOT EXISTS cash_movements (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cash_movements_shift ON cash_movements(shift_id);

-- The cashier's unfinished work. LOCAL SCRATCH SPACE: never synced, never part of the books.
--   status 'draft'  : the cart currently on screen, saved continuously, so a crash or power cut
--                     doesn't lose it (one row per cashier: id = 'draft:<owner>')
--   status 'parked' : a cart set aside to serve someone else, resumed later
CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  label TEXT NOT NULL DEFAULT '',
  cart_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_carts_owner ON carts(owner, status, updated_at);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_code TEXT,
  barcode TEXT,
  category TEXT,
  unit TEXT DEFAULT 'PIECE',
  sell_price REAL NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);

-- FEFO stock batches, same shape as the cloud's StockBatch.
CREATE TABLE IF NOT EXISTS stock_batches (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  batch_number TEXT,
  quantity_received INTEGER NOT NULL,
  quantity_remaining INTEGER NOT NULL,
  cost_price REAL NOT NULL DEFAULT 0,
  expiry_date TEXT,
  received_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_batches_product ON stock_batches(product_id, expiry_date);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);

-- Cart header — mirrors cloud Sale.
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  invoice_number INTEGER,
  customer_id TEXT REFERENCES customers(id),
  customer_name TEXT DEFAULT 'Walk-in',
  staff_name TEXT,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  status TEXT NOT NULL DEFAULT 'completed',
  amount_paid REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);

-- Cart line — mirrors cloud SaleItem.
CREATE TABLE IF NOT EXISTS sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  product_id TEXT REFERENCES products(id),
  item_name TEXT NOT NULL,
  category TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  stock_shortfall INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
-- Sales history: newest-first, optionally one status, paged. Without these every open of the
-- history screen sorted the whole table.
CREATE INDEX IF NOT EXISTS idx_sales_active_date ON sales(is_deleted, date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_status_date ON sales(is_deleted, status, date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

-- Which batch(es) a sale line drew stock from — lets deletes/restores be
-- exact instead of guessed, same as the cloud's SaleAllocation.
CREATE TABLE IF NOT EXISTS sale_allocations (
  id TEXT PRIMARY KEY,
  sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
  batch_id TEXT REFERENCES stock_batches(id),
  quantity INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_allocations_item ON sale_allocations(sale_item_id);

-- The outbox. Every write to the tables above also appends one row here.
-- The sync engine drains this, oldest first, whenever it's online and the
-- subscription allows cloud sync. Nothing is ever removed from here until
-- the cloud has confirmed it applied the operation (status='synced') —
-- an app crash or power loss mid-sync just means picking up where the
-- `pending` rows left off on next launch.
CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,      -- 'product' | 'stock_batch' | 'sale' | 'sale_item' | ...
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,        -- 'create' | 'update' | 'delete'
  payload TEXT NOT NULL,          -- JSON snapshot of the row at write time
  client_timestamp TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'synced' | 'failed'
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,            -- exponential backoff after a failed attempt; NULL = eligible now
  last_error TEXT,
  device_id TEXT,                  -- which till queued it (app_settings.device_id); NULL on rows older than this column
  actor TEXT,                      -- username signed in when it was queued; NULL if nobody was (startup reconcile)
  last_attempt_at TEXT,            -- last time the cloud ANSWERED for this row (no answer = offline, not an attempt)
  acked_at TEXT                    -- when the cloud confirmed it (applied / already_applied)
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, client_timestamp);
-- applyPulled* asks "does THIS till still have an unpushed edit of this exact row?" for every
-- pulled row; without this that is a full scan of the outbox per row.
CREATE INDEX IF NOT EXISTS idx_sync_queue_entity ON sync_queue(entity_type, entity_id);
