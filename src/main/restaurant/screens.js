/*
 * Kitchen screens on the shop's Wi-Fi: pairing and tokens (gss docs/restaurant/KITCHEN_WORKFLOW.md §3,
 * OFFLINE_SYNCHRONIZATION.md §6).
 *
 *  - On the hub, an owner or manager adds a screen and picks its station(s). The hub shows a 6-digit
 *    code that works ONCE and for 10 minutes.
 *  - The screen (any browser on the Wi-Fi) enters the code and gets a long random token bound to
 *    those stations. It only ever sees and acts on those stations.
 *  - Only hashes of codes and tokens are stored, so a copy of the till's database never lets anyone
 *    act as a screen. Too many wrong codes lock pairing for a few minutes.
 *  - The owner can remove a screen at any time; its token stops working at once.
 */
const crypto = require('crypto');
const store = require('./store');

const { RestaurantError, uuid } = store;
const CODE_TTL_MS = 10 * 60_000;
const MAX_WRONG_CODES = 5;
const LOCK_MS = 5 * 60_000;
const SEEN_EVERY_MS = 60_000; // how often "last seen" is written (not on every request)

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

// Wrong-code lock, per hub process. A restart clears it, which is fine: only the hub's owner can restart it.
const lock = { wrong: 0, until: 0 };
function resetLock() { lock.wrong = 0; lock.until = 0; }

function needOwner(ctx) {
  if (!(ctx && ctx.isOwner)) throw new RestaurantError('not_allowed', 'Only an owner or manager adds or removes kitchen screens.', 403);
}

function checkStations(db, stationIds) {
  const ids = [...new Set((Array.isArray(stationIds) ? stationIds : []).filter((s) => typeof s === 'string' && s))];
  const ok = ids.filter((id) => { const s = store.station(db, id); return s && s.is_active && !s.is_deleted; });
  if (!ids.length || ok.length !== ids.length) throw new RestaurantError('unknown_station', 'Choose one or more of this restaurant\'s stations.');
  return ids;
}

function stationNames(db, ids) {
  return ids.map((id) => store.station(db, id)).filter(Boolean).map((s) => ({ id: s.id, name: s.name }));
}

function view(db, row) {
  const ids = JSON.parse(row.station_ids);
  return { id: row.id, name: row.name, stations: stationNames(db, ids), station_ids: ids, created_at: row.created_at,
    created_by: row.created_by, last_seen_at: row.last_seen_at, revoked_at: row.revoked_at };
}

/** Owner on the hub: start pairing a screen. Returns the code to type on the screen. */
function createPairingCode(db, { name, station_ids: stationIds } = {}, ctx, now = Date.now()) {
  needOwner(ctx);
  const label = String(name || '').trim().slice(0, 60) || 'Kitchen screen';
  const stations = checkStations(db, stationIds);
  return db.transaction(() => {
    db.prepare(`DELETE FROM r_pairing_codes WHERE expires_at < ?`).run(iso(now - 24 * 3600_000)); // tidy old ones
    let code;
    do { code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }
    while (db.prepare(`SELECT 1 FROM r_pairing_codes WHERE code_hash = ?`).get(sha(code)));
    const expiresAt = iso(now + CODE_TTL_MS);
    db.prepare(`INSERT INTO r_pairing_codes (code_hash, name, station_ids, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sha(code), label, JSON.stringify(stations), iso(now), ctx.user, expiresAt);
    return { code, name: label, stations: stationNames(db, stations), expires_at: expiresAt };
  })();
}

/** A screen on the Wi-Fi: exchange a code for its token. */
function pair(db, code, now = Date.now()) {
  if (lock.until > now) throw new RestaurantError('pairing_locked', 'Too many wrong codes. Wait a few minutes, then ask the manager for a new code.', 429);
  const digits = String(code ?? '').replace(/\s/g, '');
  const row = /^\d{6}$/.test(digits) ? db.prepare(`SELECT * FROM r_pairing_codes WHERE code_hash = ?`).get(sha(digits)) : null;
  if (!row || row.used_at || row.expires_at <= iso(now)) {
    lock.wrong += 1;
    if (lock.wrong >= MAX_WRONG_CODES) { lock.wrong = 0; lock.until = now + LOCK_MS; }
    throw new RestaurantError('bad_code', 'That code is wrong or has expired. Ask the manager for a new one.');
  }
  lock.wrong = 0;
  const token = crypto.randomBytes(32).toString('base64url');
  const id = uuid();
  db.transaction(() => {
    // Only the first of two simultaneous uses wins.
    if (!db.prepare(`UPDATE r_pairing_codes SET used_at = ?, screen_id = ? WHERE code_hash = ? AND used_at IS NULL`).run(iso(now), id, row.code_hash).changes) {
      throw new RestaurantError('bad_code', 'That code is wrong or has expired. Ask the manager for a new one.');
    }
    db.prepare(`INSERT INTO r_screens (id, name, station_ids, token_hash, created_at, created_by, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, row.name, row.station_ids, sha(token), iso(now), row.created_by, iso(now));
    store.audit(db, 'restaurant.screen_paired', { summary: `Kitchen screen "${row.name}" added`, data: { screen_id: id, station_ids: JSON.parse(row.station_ids) } });
  })();
  return { token, screen: view(db, db.prepare(`SELECT * FROM r_screens WHERE id = ?`).get(id)) };
}

/** The screen behind a token, or null (unknown or removed). Stations that were deleted drop out. */
function authenticate(db, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const row = db.prepare(`SELECT * FROM r_screens WHERE token_hash = ? AND revoked_at IS NULL`).get(sha(token));
  if (!row) return null;
  if (!row.last_seen_at || Date.parse(row.last_seen_at) < now - SEEN_EVERY_MS) {
    db.prepare(`UPDATE r_screens SET last_seen_at = ? WHERE id = ?`).run(iso(now), row.id);
  }
  const screen = view(db, row);
  const active = new Set(store.activeStationIds(db));
  return { ...screen, station_ids: screen.station_ids.filter((s) => active.has(s)) };
}

/** What the engine sees when a screen acts: only its stations. */
function contextFor(screen) {
  return { user: `screen:${screen.name}`, isScreen: true, stationIds: screen.station_ids, screenId: screen.id };
}

function listScreens(db) {
  return db.prepare(`SELECT * FROM r_screens WHERE revoked_at IS NULL ORDER BY created_at`).all().map((r) => view(db, r));
}

function revokeScreen(db, screenId, ctx) {
  needOwner(ctx);
  return db.transaction(() => {
    const row = typeof screenId === 'string' && db.prepare(`SELECT * FROM r_screens WHERE id = ?`).get(screenId);
    if (!row) throw new RestaurantError('not_found', 'Screen not found.', 404);
    if (!row.revoked_at) {
      db.prepare(`UPDATE r_screens SET revoked_at = ?, revoked_by = ? WHERE id = ?`).run(store.nowIso(), ctx.user, row.id);
      store.audit(db, 'restaurant.screen_removed', { summary: `Kitchen screen "${row.name}" removed`, data: { screen_id: row.id } });
    }
    return listScreens(db);
  })();
}

module.exports = { createPairingCode, pair, authenticate, contextFor, listScreens, revokeScreen, resetLock, CODE_TTL_MS, MAX_WRONG_CODES, LOCK_MS };
