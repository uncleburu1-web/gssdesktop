const crypto = require('crypto');
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
 * Per-username salted password hashes, cached purely so login() can
 * verify a password without the server when there's no internet at all.
 * scrypt (Node's built-in, no extra dependency — matters for an Electron
 * app that has to package cleanly) is deliberately slow/memory-hard, so
 * even someone with the raw SQLite file can't cheaply brute-force it.
 * Keyed by username (not a single slot) because more than one seller can
 * share a till, each having logged in online at some point — any of them
 * should be able to fall back to offline login later, not just whoever
 * happened to log in most recently.
 */
function getOfflineCredentials(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'offline_credentials'`).get();
  return row ? JSON.parse(row.value) : {};
}

function storeOfflineCredential(db, username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const all = getOfflineCredentials(db);
  all[username] = { salt, hash, cachedAt: new Date().toISOString() };
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('offline_credentials', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(all));
}

function verifyOfflinePassword(password, stored) {
  const candidate = crypto.scryptSync(password, stored.salt, 64);
  const expected = Buffer.from(stored.hash, 'hex');
  // Lengths always match (both are scrypt(..., 64)), but timingSafeEqual
  // throws on a length mismatch rather than returning false — guard it
  // defensively in case an older/corrupt cache entry ever has a different
  // hash length.
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/**
 * This user's own role/name, cached per-username (separately from the
 * single "whoever is currently signed in" user_profile row below) purely
 * so an OFFLINE login can restore the right person's role — without this,
 * a seller logging in offline after an owner used the till last would
 * incorrectly inherit the owner's cached profile instead of their own.
 */
function getOfflineProfiles(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'offline_profiles'`).get();
  return row ? JSON.parse(row.value) : {};
}

function storeOfflineProfile(db, username, profile) {
  const all = getOfflineProfiles(db);
  all[username] = profile;
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('offline_profiles', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(all));
}

/**
 * The fallback path when login()'s fetch to /auth/login/ never got a
 * response at all — no internet, DNS failure, or the 8s timeout firing.
 * NEVER reached when the server was actually reachable and rejected the
 * password (see login() below): only a genuinely unreachable server may
 * fall back to a locally cached hash, so a recently-changed or revoked
 * password online is never bypassable just by cutting the network.
 *
 * Deliberately does NOT touch auth_tokens: there's no way to obtain a
 * real JWT without the server, so whatever's already stored (possibly
 * stale, possibly another user's from their last online login) is left
 * exactly as-is. That's fine — local reads/writes never check the token,
 * only sync.js/heartbeat.js do, and both already treat "the server
 * rejected our token" as just another offline-style condition to retry
 * later. The one real consequence: isLoggedIn() on the NEXT app restart
 * still reflects whatever that stale token implies, not this offline
 * session — acceptable, since normal login (online or offline) always
 * runs again at that point anyway.
 */
function loginOffline(db, username, password) {
  const cached = getOfflineCredentials(db)[username];
  if (!cached) {
    const err = new Error(`No internet, and no saved sign-in for "${username}" on this till yet — sign in once online first.`);
    err.code = 'offline_no_account';
    throw err;
  }
  if (!verifyOfflinePassword(password, cached)) {
    const err = new Error('Wrong password.');
    err.code = 'offline_wrong_password';
    throw err;
  }
  const profile = getOfflineProfiles(db)[username]
    || { username, full_name: null, is_owner: false, is_ceo: false, role: 'seller' }; // safe low-privilege default — same one the online path falls back to if /me/ was never reached
  storeUserProfile(db, profile);
  return { offline: true };
}

/**
 * Authenticating a username/password FIRST tries the server, same as
 * ever — the source of truth for whether a password is currently
 * correct. Only when the server can't be reached at all (see
 * loginOffline() above) does this fall back to a locally cached, salted
 * hash from that user's last successful ONLINE login. A server that
 * responds and rejects the password is never treated as "offline" — that
 * distinction is exactly what the try/catch around the fetch below is
 * for: a thrown error means the request never completed; `!res.ok` means
 * it did, and the server said no.
 *
 * What happens after a successful ONLINE login differs by whether this
 * device has already been set up:
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
  let res;
  try {
    res = await fetch(`${API_BASE}/auth/login/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, device_id: deviceId, device_type: 'desktop' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return loginOffline(db, username, password);
  }
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
  // The password is confirmed correct by the server AT THIS EXACT
  // MOMENT — exactly the right time to (re)cache it for offline login
  // later. Overwrites whatever was cached before for this username, so a
  // changed password always replaces the old offline hash rather than
  // leaving a stale one that would otherwise still work offline.
  storeOfflineCredential(db, username, password);

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
      const profile = {
        username: me.username,
        full_name: me.full_name,
        is_owner: me.is_owner,
        is_ceo: Boolean(me.is_ceo),
        role: me.role,
      };
      storeUserProfile(db, profile);
      storeOfflineProfile(db, username, profile); // so THIS user's own role/name is what offline login restores later, not whoever logged in last
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