-- Restaurant tables on the hub till (gss docs/restaurant/DOMAIN_MODEL.md). Created on every open with
-- IF NOT EXISTS, empty on supermarket tills. Nothing here changes any supermarket table.

-- ---------------------------------------------------------------------------------------------
-- Configuration, pulled from the cloud (read-only here, except the sold-out switch, which lives in
-- sold_out below so a pull never overwrites it mid-service).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS r_settings (
  id TEXT PRIMARY KEY, hub_device_id TEXT, service_charge_rate TEXT NOT NULL DEFAULT '0',
  service_charge_types TEXT NOT NULL DEFAULT '["dine_in"]', require_served_before_payment INTEGER NOT NULL DEFAULT 0,
  order_number_prefix TEXT NOT NULL DEFAULT '', business_day_starts_at TEXT NOT NULL DEFAULT '05:00',
  tax_state TEXT, vat_registered INTEGER, is_deleted INTEGER NOT NULL DEFAULT 0, synced_at TEXT
);
CREATE TABLE IF NOT EXISTS r_areas (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1, is_deleted INTEGER NOT NULL DEFAULT 0, synced_at TEXT);
CREATE TABLE IF NOT EXISTS r_tables (id TEXT PRIMARY KEY, area_id TEXT, label TEXT NOT NULL, seats INTEGER NOT NULL DEFAULT 4,
  sort INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, is_deleted INTEGER NOT NULL DEFAULT 0, synced_at TEXT);
CREATE TABLE IF NOT EXISTS r_stations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prints INTEGER NOT NULL DEFAULT 1,
  shows_on_screen INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0, synced_at TEXT);
CREATE TABLE IF NOT EXISTS r_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, station_id TEXT, sort INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1, is_deleted INTEGER NOT NULL DEFAULT 0, synced_at TEXT);
CREATE TABLE IF NOT EXISTS r_items (id TEXT PRIMARY KEY, category_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL, station_id TEXT, tax_class TEXT NOT NULL DEFAULT 'food', is_available INTEGER NOT NULL DEFAULT 1,
  image_url TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0, synced_at TEXT);
CREATE TABLE IF NOT EXISTS r_modifier_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, min_select INTEGER NOT NULL DEFAULT 0,
  max_select INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0, synced_at TEXT);
CREATE TABLE IF NOT EXISTS r_modifier_options (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL,
  price_delta TEXT NOT NULL DEFAULT '0', is_available INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1, is_deleted INTEGER NOT NULL DEFAULT 0, synced_at TEXT);
CREATE TABLE IF NOT EXISTS r_item_modifier_groups (id TEXT PRIMARY KEY, menu_item_id TEXT NOT NULL, group_id TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0, synced_at TEXT);
CREATE TABLE IF NOT EXISTS r_tax_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, rate TEXT NOT NULL, inclusive INTEGER NOT NULL DEFAULT 0,
  tax_classes TEXT NOT NULL DEFAULT '[]', applies_to_service_charge INTEGER NOT NULL DEFAULT 0, valid_from TEXT NOT NULL,
  valid_to TEXT, is_active INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0, synced_at TEXT);

-- Sold out for one business day, switched on the hub (T13). The hub's switch wins for that day.
CREATE TABLE IF NOT EXISTS r_sold_out (menu_item_id TEXT NOT NULL, business_date TEXT NOT NULL, by_user TEXT, at TEXT NOT NULL,
  PRIMARY KEY (menu_item_id, business_date));

-- ---------------------------------------------------------------------------------------------
-- Operations: the hub is the record for these while an order is open.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS r_orders (
  id TEXT PRIMARY KEY, number TEXT NOT NULL, service_type TEXT NOT NULL, table_id TEXT, guests INTEGER,
  waiter TEXT, opened_by TEXT, status TEXT NOT NULL DEFAULT 'open',          -- open | closed | cancelled
  business_date TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT, cancel_reason TEXT, notes TEXT NOT NULL DEFAULT '',
  device_id TEXT, queued_at TEXT,                                             -- when its order_doc entered the outbox
  -- The service charge and tax rules as they were when the order was opened. Every bill for this
  -- order is worked out from this copy, so a change in the cloud during service never alters it.
  pricing TEXT NOT NULL DEFAULT '{}'
);
-- One open dine-in order per table (R5), enforced by the database itself.
CREATE UNIQUE INDEX IF NOT EXISTS idx_r_orders_one_open_per_table ON r_orders(table_id) WHERE status = 'open' AND table_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_r_orders_status ON r_orders(status, business_date);

CREATE TABLE IF NOT EXISTS r_order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES r_orders(id), menu_item_id TEXT NOT NULL,
  name TEXT NOT NULL, unit_price TEXT NOT NULL, modifiers_price TEXT NOT NULL DEFAULT '0', tax_class TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0), notes TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',                                      -- pending | sent | served | voided
  station_id TEXT, sent_at TEXT, served_at TEXT,
  voided_quantity INTEGER NOT NULL DEFAULT 0, void_reason TEXT, waste INTEGER NOT NULL DEFAULT 0, voided_by TEXT,
  added_by TEXT, created_at TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_r_order_items_order ON r_order_items(order_id, sort);

CREATE TABLE IF NOT EXISTS r_order_item_modifiers (
  id TEXT PRIMARY KEY, order_item_id TEXT NOT NULL REFERENCES r_order_items(id), option_id TEXT NOT NULL,
  group_id TEXT NOT NULL, name TEXT NOT NULL, price_delta TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_r_item_modifiers ON r_order_item_modifiers(order_item_id);

CREATE TABLE IF NOT EXISTS r_tickets (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES r_orders(id), station_id TEXT NOT NULL,
  number TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'new',                     -- new | void
  sent_by TEXT, sent_at TEXT NOT NULL, print_count INTEGER NOT NULL DEFAULT 0, business_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_r_tickets_station ON r_tickets(station_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_r_tickets_order ON r_tickets(order_id);

CREATE TABLE IF NOT EXISTS r_ticket_items (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES r_tickets(id), order_item_id TEXT NOT NULL REFERENCES r_order_items(id),
  quantity INTEGER NOT NULL, voided_quantity INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',                                       -- queued | preparing | ready | served | voided
  version INTEGER NOT NULL DEFAULT 1, started_at TEXT, ready_at TEXT, served_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_r_ticket_items_ticket ON r_ticket_items(ticket_id);
CREATE INDEX IF NOT EXISTS idx_r_ticket_items_item ON r_ticket_items(order_item_id);

CREATE TABLE IF NOT EXISTS r_bills (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES r_orders(id), number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',                                        -- open | settled | void
  subtotal TEXT NOT NULL, discount TEXT NOT NULL DEFAULT '0.00', discount_spec TEXT, discount_reason TEXT, discount_by TEXT,
  net TEXT NOT NULL, total TEXT NOT NULL, printed_at TEXT, print_count INTEGER NOT NULL DEFAULT 0, settled_at TEXT, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_r_bills_one_per_order ON r_bills(order_id);

CREATE TABLE IF NOT EXISTS r_bill_charges (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES r_bills(id), kind TEXT NOT NULL, tax_rule_id TEXT, name TEXT NOT NULL,
  rate TEXT NOT NULL, inclusive INTEGER NOT NULL DEFAULT 0, base TEXT NOT NULL, amount TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_r_bill_charges ON r_bill_charges(bill_id, sort);

-- Money received: append-only (no UPDATE or DELETE anywhere in the code).
CREATE TABLE IF NOT EXISTS r_payments (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES r_bills(id), method TEXT NOT NULL, amount TEXT NOT NULL,
  tendered TEXT, change TEXT NOT NULL DEFAULT '0.00', tip TEXT NOT NULL DEFAULT '0.00', reference TEXT NOT NULL DEFAULT '',
  shift_id TEXT, received_by TEXT, received_at TEXT NOT NULL, override_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_r_payments_bill ON r_payments(bill_id);
CREATE INDEX IF NOT EXISTS idx_r_payments_shift ON r_payments(shift_id);

-- Every change, written in the same transaction as the change (transactional outbox for screens).
CREATE TABLE IF NOT EXISTS r_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, type TEXT NOT NULL, station_ids TEXT NOT NULL DEFAULT '[]',
  entity_type TEXT, entity_id TEXT, data TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL
);

-- Restaurant audit entries (voids, discounts, table moves, cancellations, overrides, sold-out,
-- reprints). Kept on the hub and uploaded as audit_event only to a cloud that speaks protocol 6: an
-- older cloud accepts just three till audit actions and would refuse these, leaving failed uploads.
CREATE TABLE IF NOT EXISTS r_audit (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}', actor TEXT, created_at TEXT NOT NULL, queued_at TEXT
);

-- Idempotency: a repeated request with the same key gets the first answer, never a second change.
CREATE TABLE IF NOT EXISTS r_requests (
  key TEXT PRIMARY KEY, op TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL
);

-- Kitchen print jobs (printer chosen per station on THIS PC, apart from the receipt printer).
CREATE TABLE IF NOT EXISTS r_print_jobs (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES r_tickets(id), station_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ticket',                                        -- ticket | void | copy
  status TEXT NOT NULL DEFAULT 'queued',                                      -- queued | printed | failed | no_printer
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, printed_at TEXT, requested_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_r_print_jobs_status ON r_print_jobs(status, created_at);
