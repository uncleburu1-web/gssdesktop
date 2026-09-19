const { getAccessToken, refreshAccessToken } = require('./auth');
const { getOrCreateDeviceId } = require('./device');

const API_BASE = process.env.BENCHLINE_API_URL || 'http://localhost:8000/api';
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Tells the cloud "the desktop is alive right now" whenever there's
 * connectivity and a logged-in session. This is the ONLY signal the
 * Android CEO app has for deciding whether to show "desktop offline" —
 * see core.views.CeoShopStatusView on the backend. A failed heartbeat
 * (no internet, DNS failure, backend down, not logged in yet) is
 * silently swallowed: a missed heartbeat just means the CEO app shows
 * the shop as disconnected a little sooner. It is never a POS-breaking
 * error, by design.
 */
function startHeartbeat(db, { deviceName, appVersion = '0.1.0' } = {}) {
  const deviceId = getOrCreateDeviceId(db);

  async function post(token) {
    return fetch(`${API_BASE}/devices/heartbeat/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ device_id: deviceId, device_type: 'desktop', name: deviceName, app_version: appVersion }),
      signal: AbortSignal.timeout(5000),
    });
  }

  async function tick() {
    let token = getAccessToken(db);
    if (!token) return; // not logged in — nothing to heartbeat with yet
    try {
      let res = await post(token);
      if (res.status === 401) {
        token = await refreshAccessToken(db);
        if (!token) return;
        await post(token);
      }
    } catch {
      // Offline or backend unreachable — expected and fine, try again next tick.
    }
  }

  tick();
  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}

module.exports = { startHeartbeat, getOrCreateDeviceId };
