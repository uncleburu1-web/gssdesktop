/*
 * Restaurant data on the hub: schema, configuration pulled from the cloud, and the helpers the order
 * engine (engine.js) builds on. Design: gss docs/restaurant/DOMAIN_MODEL.md and OFFLINE_SYNCHRONIZATION.md.
 *
 * Nothing here touches a supermarket table. ../db.js loads the schema on open and hands pulled
 * restaurant rows to applyPulled(); everything else is used by engine.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

class RestaurantError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

function ensureSchema(db) {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// Configuration pulled from the cloud (gss restaurant/sync.py PULL_TYPES). Applied as plain upserts:
// the cloud is the record for configuration, and a change there never alters an open order (its
// prices, names and rates are copied onto the order and bill).
// ---------------------------------------------------------------------------------------------
const bool = (v) => (v ? 1 : 0);
const nbool = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
const json = (v) => JSON.stringify(Array.isArray(v) ? v : []);
const text = (v, d = '') => (v === null || v === undefined ? d : String(v));

const PULL_TABLES = {
  restaurant_settings: ['r_settings', (p) => ({
    hub_device_id: p.hub_device_id || null, service_charge_rate: text(p.service_charge_rate, '0'),
    service_charge_types: json(p.service_charge_types), require_served_before_payment: bool(p.require_served_before_payment),
    order_number_prefix: text(p.order_number_prefix), business_day_starts_at: text(p.business_day_starts_at, '05:00'),
    tax_state: p.tax_state || null, vat_registered: nbool(p.vat_registered) })],
  dining_area: ['r_areas', (p) => ({ name: text(p.name), sort: p.sort || 0, is_active: bool(p.is_active) })],
  restaurant_table: ['r_tables', (p) => ({ area_id: p.area_id || null, label: text(p.label), seats: p.seats || 1, sort: p.sort || 0, is_active: bool(p.is_active) })],
  kitchen_station: ['r_stations', (p) => ({ name: text(p.name), prints: bool(p.prints), shows_on_screen: bool(p.shows_on_screen), sort: p.sort || 0, is_active: bool(p.is_active) })],
  menu_category: ['r_categories', (p) => ({ name: text(p.name), station_id: p.station_id || null, sort: p.sort || 0, is_active: bool(p.is_active) })],
  modifier_group: ['r_modifier_groups', (p) => ({ name: text(p.name), min_select: p.min_select || 0, max_select: p.max_select ?? 1, sort: p.sort || 0, is_active: bool(p.is_active) })],
  modifier_option: ['r_modifier_options', (p) => ({ group_id: p.group_id, name: text(p.name), price_delta: text(p.price_delta, '0'), is_available: bool(p.is_available), sort: p.sort || 0, is_active: bool(p.is_active) })],
  menu_item: ['r_items', (p) => ({ category_id: p.category_id || null, name: text(p.name), description: text(p.description), price: text(p.price, '0'),
    station_id: p.station_id || null, tax_class: text(p.tax_class, 'food'), is_available: bool(p.is_available), image_url: text(p.image_url), sort: p.sort || 0, is_active: bool(p.is_active) })],
  menu_item_modifier_group: ['r_item_modifier_groups', (p) => ({ menu_item_id: p.menu_item_id, group_id: p.group_id, sort: p.sort || 0 })],
  tax_rule: ['r_tax_rules', (p) => ({ name: text(p.name), rate: text(p.rate, '0'), inclusive: bool(p.inclusive), tax_classes: json(p.tax_classes),
    applies_to_service_charge: bool(p.applies_to_service_charge), valid_from: text(p.valid_from), valid_to: p.valid_to || null, is_active: bool(p.is_active) })],
};
const PULL_TYPES = Object.keys(PULL_TABLES);

function applyPulled(db, entityType, operation, payload) {
  const spec = PULL_TABLES[entityType];
  if (!spec || !payload || !payload.id) return false;
  const [table, map] = spec;
  const ts = nowIso();
  if (operation === 'delete') {
    db.prepare(`UPDATE ${table} SET is_deleted = 1, synced_at = ? WHERE id = ?`).run(ts, payload.id);
    return true;
  }
  const row = { ...map(payload), is_deleted: 0, synced_at: ts };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
     ON CONFLICT(id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`
  ).run(payload.id, ...cols.map((c) => row[c]));
  return true;
}

// ---------------------------------------------------------------------------------------------
// Configuration reads
// ---------------------------------------------------------------------------------------------
function settings(db) {
  const s = db.prepare(`SELECT * FROM r_settings WHERE is_deleted = 0 LIMIT 1`).get();
  return {
    service_charge_rate: s ? s.service_charge_rate : '0',
    service_charge_types: s ? JSON.parse(s.service_charge_types || '[]') : ['dine_in'],
    require_served_before_payment: Boolean(s && s.require_served_before_payment),
    order_number_prefix: s ? s.order_number_prefix : '',
    business_day_starts_at: (s && s.business_day_starts_at) || '05:00',
  };
}

function activeStationIds(db) {
  return db.prepare(`SELECT id FROM r_stations WHERE is_active = 1 AND is_deleted = 0`).all().map((r) => r.id);
}

function station(db, id) {
  return id ? db.prepare(`SELECT * FROM r_stations WHERE id = ?`).get(id) : null;
}

function menuItem(db, id) {
  return db.prepare(
    `SELECT i.*, c.station_id AS category_station_id FROM r_items i LEFT JOIN r_categories c ON c.id = i.category_id
     WHERE i.id = ? AND i.is_deleted = 0`
  ).get(id);
}

function taxRules(db) {
  return db.prepare(`SELECT * FROM r_tax_rules WHERE is_deleted = 0 ORDER BY valid_from, name, id`).all().map((r) => ({
    id: r.id, name: r.name, rate: r.rate, inclusive: Boolean(r.inclusive), tax_classes: JSON.parse(r.tax_classes || '[]'),
    applies_to_service_charge: Boolean(r.applies_to_service_charge), valid_from: r.valid_from, valid_to: r.valid_to, is_active: Boolean(r.is_active),
  }));
}

/**
 * Is this till the branch's restaurant hub? One hub per branch (the owner picks it in the cloud,
 * RestaurantSettings.hub_device): only the hub takes orders, so two tills can never each hold a
 * different set of open tables.
 */
function hubStatus(db) {
  const setting = (key) => { const r = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key); return r ? r.value : null; };
  let modules = [];
  try { modules = (JSON.parse(setting('shop_settings') || '{}') || {}).modules || []; } catch { modules = []; }
  const s = db.prepare(`SELECT hub_device_id FROM r_settings WHERE is_deleted = 0 LIMIT 1`).get();
  const hub = (s && s.hub_device_id) || null;
  const device = setting('device_id');
  const restaurant = modules.includes('restaurant');
  // is_hub: this till runs the restaurant right now (switched-off module = nobody does).
  return { restaurant, hub_device_id: hub, device_id: device, is_hub: Boolean(restaurant && hub && device && hub === device) };
}

function assertHub(db) {
  const h = hubStatus(db);
  if (!h.restaurant) throw new RestaurantError('module_disabled', 'This branch does not use the restaurant.', 403);
  if (!h.hub_device_id) throw new RestaurantError('no_hub', 'No till is the restaurant hub yet. The owner chooses it in the restaurant settings.', 403);
  if (!h.is_hub) throw new RestaurantError('not_the_hub', 'This till is not the restaurant hub. Orders are taken on the hub till.', 403);
  return h;
}

function isSoldOut(db, menuItemId, businessDate) {
  return Boolean(db.prepare(`SELECT 1 FROM r_sold_out WHERE menu_item_id = ? AND business_date = ?`).get(menuItemId, businessDate));
}

// ---------------------------------------------------------------------------------------------
// Business day, numbering, events, idempotency
// ---------------------------------------------------------------------------------------------
const TIME_ZONE = 'Africa/Lagos';

/** The business day a moment belongs to: before the day's start time (default 05:00) it is still yesterday. */
function businessDate(db, at = new Date()) {
  const startsAt = settings(db).business_day_starts_at;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (`${parts.hour}:${parts.minute}` >= startsAt) return today;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Next number in a sequence (per scope, per business day). Call inside the write transaction. */
function nextNumber(db, scope, day) {
  const key = `r_seq:${scope}:${day}`;
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
  const next = (row ? Number(row.value) : 0) + 1;
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(next));
  return next;
}

/** Record an event for kitchen screens and the hub UI, in the caller's transaction. */
function emit(db, type, { stationIds = [], entityType = null, entityId = null, data = {} } = {}) {
  const info = db.prepare(
    `INSERT INTO r_events (id, type, station_ids, entity_type, entity_id, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), type, JSON.stringify(stationIds), entityType, entityId, JSON.stringify(data), nowIso());
  return Number(info.lastInsertRowid);
}

function eventsAfter(db, seq, stationIds = null) {
  const rows = db.prepare(`SELECT * FROM r_events WHERE seq > ? ORDER BY seq LIMIT 1000`).all(seq || 0);
  return rows
    .map((r) => ({ ...r, station_ids: JSON.parse(r.station_ids), data: JSON.parse(r.data) }))
    .filter((e) => !stationIds || e.station_ids.some((s) => stationIds.includes(s)));
}

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

/**
 * Run a change at most once per Idempotency-Key. Same key + same request -> the first answer again;
 * same key + a different request -> refused. No key -> just runs. Call inside the transaction.
 */
function onceForKey(db, key, op, request, fn) {
  if (!key) return fn();
  const seen = db.prepare(`SELECT * FROM r_requests WHERE key = ?`).get(key);
  const h = hash({ op, request });
  if (seen) {
    if (seen.request_hash !== h) throw new RestaurantError('key_reused', 'This request id was already used for a different action.', 409);
    return JSON.parse(seen.response);
  }
  const response = fn();
  db.prepare(`INSERT INTO r_requests (key, op, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(key, op, h, JSON.stringify(response ?? null), nowIso());
  return response;
}

/**
 * Record a restaurant audit entry, in the caller's transaction. Always kept on the hub; queued for
 * the cloud only when it accepts restaurant audit actions (protocol 6, as order_doc). Earlier
 * entries are queued by queuePendingAudit() once the cloud upgrades.
 */
const AUDIT_PROTOCOL = 6;
function audit(db, action, { summary = '', reason = '', data = {} } = {}) {
  const tillDb = require('../db');
  const profile = db.prepare(`SELECT value FROM app_settings WHERE key = 'user_profile'`).get();
  let actor = null;
  try { actor = profile ? JSON.parse(profile.value).username || null : null; } catch { actor = null; }
  const id = uuid();
  db.prepare(`INSERT INTO r_audit (id, action, summary, reason, data, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, action, String(summary), String(reason || ''), JSON.stringify(data || {}), actor, nowIso());
  if (tillDb.cloudSyncProtocol(db) >= AUDIT_PROTOCOL) queueAudit(db, id);
  return id;
}

function queueAudit(db, id) {
  const r = db.prepare(`SELECT * FROM r_audit WHERE id = ? AND queued_at IS NULL`).get(id);
  if (!r) return false;
  require('../db').enqueueSync(db, { entityType: 'audit_event', entityId: r.id, operation: 'create',
    payload: { id: r.id, action: r.action, summary: r.summary, reason: r.reason, data: JSON.parse(r.data), actor: r.actor, created_at: r.created_at } });
  db.prepare(`UPDATE r_audit SET queued_at = ? WHERE id = ?`).run(nowIso(), r.id);
  return true;
}

/** After the cloud upgrades to protocol 6: queue the entries recorded while it could not take them. */
function queuePendingAudit(db) {
  if (require('../db').cloudSyncProtocol(db) < AUDIT_PROTOCOL) return 0;
  return db.transaction(() => db.prepare(`SELECT id FROM r_audit WHERE queued_at IS NULL ORDER BY created_at, rowid`).all()
    .filter((r) => queueAudit(db, r.id)).length)();
}

/** Housekeeping: events older than 7 days, request keys older than 48 hours. */
function prune(db, now = Date.now()) {
  db.prepare(`DELETE FROM r_events WHERE at < ? AND seq < (SELECT MAX(seq) FROM r_events)`).run(new Date(now - 7 * 864e5).toISOString());
  db.prepare(`DELETE FROM r_requests WHERE created_at < ?`).run(new Date(now - 2 * 864e5).toISOString());
}

module.exports = {
  RestaurantError, ensureSchema, applyPulled, PULL_TYPES, settings, activeStationIds, station, menuItem, taxRules,
  hubStatus, assertHub, isSoldOut, audit, queuePendingAudit, businessDate, nextNumber, emit, eventsAfter, onceForKey, prune, uuid, nowIso,
};
