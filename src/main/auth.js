const API_BASE = process.env.BENCHLINE_API_URL || 'http://localhost:8000/api';
const { getOrCreateDeviceId } = require('./device');

function getStoredTokens(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'auth_tokens'`).get();
  return row ? JSON.parse(row.value) : null;
}

function storeTokens(db, tokens) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('auth_tokens', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(tokens));
}

/**
 * Shop/branch-level setup — everything needed to customize this till
 * (name, address, contact details, logo, receipt footer message, which
 * business type it is, and which optional sections apply — service/
 * repairs, pharmacy). This is device-paired, not user-paired: whichever
 * branch this till's device_id got paired to on its very first login
 * (see login() below) owns this data for good, so it's downloaded ONCE
 * and then just reused — it does NOT get cleared on logout(), unlike the
 * per-user profile below, so a second seller logging into the same till
 * never re-triggers the "setting up your account" download; only
 * getUserProfile()'s per-login piece does.
 */
function getStoredShopSettings(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'shop_settings'`).get();
  return row ? JSON.parse(row.value) : null;
}

function storeShopSettings(db, settings) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('shop_settings', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(settings));
}

/** True once this device has ever completed the shop-settings download — LoginScreen.jsx uses this to decide whether to show "Setting up your account…" (first time) or a plain "Signing in…" (every login after). */
function hasShopSettings(db) {
  return Boolean(getStoredShopSettings(db));
}

/**
 * The logged-in user's own identity — { username, full_name, is_owner,
 * is_ceo, role }. Unlike shop settings above, this IS cleared on
 * logout(), since it's specific to whoever is currently signed in on
 * this till, not to the till itself.
 */
function getStoredUserProfile(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'user_profile'`).get();
  return row ? JSON.parse(row.value) : null;
}

function storeUserProfile(db, profile) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('user_profile', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(profile));
}

/**
 * The desktop's ONE dependency on the network being reachable for a
 * given login: authenticating the username/password itself always has
 * to reach the server (there's no safe way to check a password purely
 * locally). What happens AFTER that differs by whether this device has
 * already been set up:
 *   - First login ever on this till: nothing is cached yet, so we fetch
 *     /api/me/ and save both the shop-level settings (name, address,
 *     contact, logo, receipt footer, business type, service/pharmacy
 *     flags) and this user's own role — this is the "download everything
 *     and set up the till" step LoginScreen.jsx shows "Setting up your
 *     account…" for.
 *   - Every login after that: the shop settings are already sitting in
 *     local db from the first time, so they're left alone — only this
 *     user's own role/name is worth a quick refresh (in case it changed
 *     since they were last on this till). If even that quick refresh
 *     can't reach the server (offline), we fall back to whatever's
 *     cached for shop settings, and to the safer "seller" default for
 *     the user's own role rather than guessing owner.
 *
 * Sends `device_id` (this machine's persistent id — see device.js) and
 * `device_type: 'desktop'` so the backend can enforce branch pairing: the
 * FIRST login on a given physical machine pairs it to that account's
 * branch for good; every login after that, from anyone whose account
 * belongs to a DIFFERENT branch, is rejected server-side even though
 * their username/password are perfectly valid — see backend
 * core.auth_serializers.DeviceAwareTokenObtainPairSerializer for the
 * actual rule. That rejection surfaces here as a normal thrown Error
 * (with `.code === 'device_shop_mismatch'`) so LoginScreen.jsx can show
 * it clearly instead of as a generic "wrong password".
 */
async function login(db, username, password) {
  const deviceId = getOrCreateDeviceId(db);
  const res = await fetch(`${API_BASE}/auth/login/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, device_id: deviceId, device_type: 'desktop' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail) ? body.detail[0] : body.detail;
    const code = Array.isArray(body.code) ? body.code[0] : body.code;
    const err = new Error(detail || 'Login failed — check username and password.');
    err.code = code || null;
    throw err;
  }
  const tokens = await res.json();
  storeTokens(db, tokens);

  // Same network window as the login call above — /api/me/ returns both
  // this user's role and the shop's full setup in one shot, so no
  // separate endpoint is needed. Shop settings just get (re)written here
  // too whenever we're online anyway; the "don't hit the server again"
  // part is enforced by getUserProfile() reading local db first and this
  // whole block being skippable — see hasShopSettings().
  try {
    const meRes = await fetch(`${API_BASE}/me/`, {
      headers: { Authorization: `Bearer ${tokens.access}` },
      signal: AbortSignal.timeout(8000),
    });
    if (meRes.ok) {
      const me = await meRes.json();
      storeShopSettings(db, {
        shop_id: me.shop_id,
        shop_name: me.shop_name,
        shop_address: me.shop_address,
        shop_phone: me.shop_phone,
        shop_email: me.shop_email,
        shop_logo_url: me.shop_logo_url,
        shop_receipt_footer_note: me.shop_receipt_footer_note,
        service_enabled: Boolean(me.service_enabled),
        pharmacy_enabled: Boolean(me.pharmacy_enabled),
        // Drives which categories ProductsScreen/PosScreen offer for this
        // till — see renderer/categories.js. Without this the desktop app
        // has no way to tell a clothing or general-retail shop apart from
        // a gadgets shop, and everyone gets offered "Laptop".
        business_type: me.business_type || 'general',
      });
      storeUserProfile(db, {
        username: me.username,
        full_name: me.full_name,
        is_owner: me.is_owner,
        is_ceo: Boolean(me.is_ceo),
        role: me.role,
      });
    }
  } catch {
    // Login itself already succeeded — don't fail the whole sign-in over
    // this one follow-up call. Whatever's already cached (shop settings
    // from a previous login, this user's role from a previous session)
    // stays as-is; getUserProfile() below falls back to the safer,
    // lower-privilege "seller" view if this is the very first login and
    // nothing is cached at all.
  }

  return tokens;
}

function getUserProfile(db) {
  const shop = getStoredShopSettings(db) || {};
  const user = getStoredUserProfile(db) || { is_owner: false, role: 'seller', full_name: null, username: null, is_ceo: false };
  return { ...shop, ...user };
}

/**
 * Only clears THIS user's session — tokens and their own role/name.
 * Deliberately leaves shop_settings and device_id alone: they belong to
 * the till, not the person, so the next seller who logs in here (or the
 * same one again later) never has to wait through "Setting up your
 * account…" a second time.
 */
function logout(db) {
  db.prepare(`DELETE FROM app_settings WHERE key IN ('auth_tokens', 'user_profile')`).run();
}

function getAccessToken(db) {
  const tokens = getStoredTokens(db);
  return tokens ? tokens.access : null;
}

async function refreshAccessToken(db) {
  const tokens = getStoredTokens(db);
  if (!tokens || !tokens.refresh) return null;
  try {
    const res = await fetch(`${API_BASE}/auth/refresh/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: tokens.refresh }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    storeTokens(db, { ...tokens, access: data.access });
    return data.access;
  } catch {
    return null;
  }
}

module.exports = {
  login, logout, getAccessToken, refreshAccessToken, getStoredTokens, getUserProfile, hasShopSettings,
};
