const { randomUUID } = require('crypto');

/**
 * The one persistent identifier for THIS physical install — generated
 * once on first launch and reused forever after (survives app restarts;
 * only a fresh OS install/DB wipe would lose it). Used for two things
 * that both need the SAME id to mean anything:
 *   - heartbeat.js: "is this desktop online right now"
 *   - auth.js's login(): which branch this specific machine is paired to
 *     (see backend core.auth_serializers.DeviceAwareTokenObtainPairSerializer)
 *
 * Split into its own module (rather than living in heartbeat.js, which
 * would be the more obvious place) purely to avoid a circular require:
 * heartbeat.js already needs auth.js's getAccessToken/refreshAccessToken,
 * so auth.js can't require heartbeat.js back without Node handing one of
 * the two a half-initialized module.
 */
function getOrCreateDeviceId(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'device_id'`).get();
  if (row) return row.value;
  const id = randomUUID();
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('device_id', ?)`).run(id);
  return id;
}

module.exports = { getOrCreateDeviceId };
