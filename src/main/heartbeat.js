const { getAccessToken, refreshAccessToken } = require('./auth');
const { getOrCreateDeviceId } = require('./device');

const API_BASE = process.env.BENCHLINE_API_URL || 'http://localhost:8000/api';
const TICK_MS = 60_000;               // look once a minute (was: POST every 30 s, always)
const LIVE_REFRESH_MS = 5 * 60_000;   // with a live socket, send counts at most every 5 min unless they changed

/**
 * Tells the cloud "this till is alive" and how its outbox is doing (pending / failed uploads), so the
 * cloud can show ONLINE, STALE ("on, but sales are not reaching you") or OFFLINE without asking.
 *
 * Stage 1b: while the live WebSocket is connected, its ping/pong already proves the till is alive
 * (the cloud stamps Device.last_ws_seen_at from it), so this HTTP heartbeat is only sent when the
 * socket is down, when the queue counts changed, or every 5 minutes as a refresh. Roughly 2,880
 * requests per till per day became a handful.
 *
 * A failed heartbeat (offline, cloud down, not logged in) is silently skipped: it is never a
 * POS-breaking error.
 */
function startHeartbeat(db, { deviceName, appVersion = '0.1.0', isLiveConnected = () => false, queueStats = () => null } = {}) {
  const deviceId = getOrCreateDeviceId(db);
  let lastSentAt = 0;
  let lastCounts = null;

  async function post(token, counts) {
    return fetch(`${API_BASE}/devices/heartbeat/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        device_id: deviceId, device_type: 'desktop', name: deviceName, app_version: appVersion,
        ...(counts ? { pending_ops: counts.pending, failed_ops: counts.failed } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
  }

  function shouldSend(counts, now) {
    if (!isLiveConnected()) return true;
    const key = counts ? `${counts.pending}/${counts.failed}` : '';
    if (key !== lastCounts) return true;
    return now - lastSentAt >= LIVE_REFRESH_MS;
  }

  async function tick() {
    let token = getAccessToken(db);
    if (!token) return; // not logged in — nothing to heartbeat with yet
    let counts = null;
    try { counts = queueStats(); } catch {}
    const now = Date.now();
    if (!shouldSend(counts, now)) return;
    try {
      let res = await post(token, counts);
      if (res.status === 401) {
        token = await refreshAccessToken(db);
        if (!token) return;
        res = await post(token, counts);
      }
      if (res.ok) {
        lastSentAt = now;
        lastCounts = counts ? `${counts.pending}/${counts.failed}` : '';
      }
    } catch {
      // Offline or backend unreachable — expected and fine, try again next tick.
    }
  }

  tick();
  const timer = setInterval(tick, TICK_MS);
  return { stop: () => clearInterval(timer), tick };
}

module.exports = { startHeartbeat, getOrCreateDeviceId };
