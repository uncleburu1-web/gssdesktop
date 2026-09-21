const { getAccessToken, refreshAccessToken } = require('./auth');
const { applyPulledOperation, getLastPullAt, setLastPullAt, pruneSyncQueue, reconcileUnsyncedRows } = require('./db');

const API_BASE = process.env.BENCHLINE_API_URL || 'http://localhost:8000/api';
const SYNC_INTERVAL_MS = 15_000;
const RECONCILE_INTERVAL_MS = 10 * 60_000; // a cheap COUNT(*) check, not worth running more often than this
const BATCH_SIZE = 25;
const MAX_BACKOFF_MS = 5 * 60_000; // never wait longer than 5 minutes between retries of the same row

// entity_type (what SyncPullView/SyncReconcileView call it) -> local table
// name (schema.sql) — the one place both pullTick's applyPulledOperation
// dispatch and reconcileTick's local counts need to agree on.
const ENTITY_TABLES = {
  product: 'products',
  stock_batch: 'stock_batches',
  customer: 'customers',
  sale: 'sales',
  sale_item: 'sale_items',
};

// Exponential backoff after N consecutive failures — 30s, 60s, 120s, 240s,
// capped at 5 min. Keeps a flaky/offline connection from hammering the
// Django/Railway backend with the exact same batch every 15s; it still
// retries promptly the FIRST time (retryCount 0 -> next tick, unchanged),
// it just backs off if that keeps failing.
function backoffMs(retryCount) {
  return Math.min(SYNC_INTERVAL_MS * 2 ** retryCount, MAX_BACKOFF_MS);
}

function wsUrl(token) {
  const httpBase = API_BASE.replace(/\/api\/?$/, '');
  const wsBase = httpBase.replace(/^http/, 'ws');
  return `${wsBase}/ws/live/?token=${encodeURIComponent(token)}`;
}

/**
 * Push AND pull, plus a WebSocket connection that triggers an immediate
 * pull the moment anything changes elsewhere — this is the "if the seller
 * sells and has internet, tell the server right away; if the CEO also
 * sells while the desktop was off, catch up on it the moment we're back"
 * loop, in full, both directions.
 *
 * PUSH targets `/api/sync/push/` — the idempotent batch-ingest endpoint
 * (backend/sync/views.py). A push failure (offline, DNS failure, backend
 * down, 5xx) is caught and just leaves the queue rows `pending` for a
 * later tick — sale ringing never depends on this succeeding; see db.js,
 * none of whose local-write functions call this module or await
 * anything network-related.
 *
 * PULL targets `/api/sync/pull/?since=<cursor>` — a product the CEO
 * added on the web, a sale rung up on another device, all flow down into
 * this desktop's own SQLite via db.applyPulledOperation, INCLUDING local
 * stock deduction for a sale that happened elsewhere (see db.js's
 * applyPulledSaleItem) so quantities on THIS screen stay honest.
 *
 * The WebSocket is a pure latency optimization on top of both — the
 * 15s poll is what actually guarantees eventual consistency; the socket
 * just means "eventual" is usually under a second instead of up to 15s.
 * If the socket can't connect (offline, cloud down, whatever), nothing
 * breaks — pushLoop/pullLoop keep running on their own timers regardless.
 */
function startSyncEngine(db, onDataChanged) {
  async function doPush(token, operations) {
    return fetch(`${API_BASE}/sync/push/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operations }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async function pushTick() {
    const nowIso = new Date().toISOString();
    const pending = db.prepare(
      `SELECT * FROM sync_queue
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY client_timestamp LIMIT ?`
    ).all(nowIso, BATCH_SIZE);
    if (pending.length === 0) return;

    let token = getAccessToken(db);
    if (!token) return; // not logged in yet

    const operations = pending.map((row) => ({
      id: row.id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      operation: row.operation,
      payload: JSON.parse(row.payload),
      client_timestamp: row.client_timestamp,
    }));

    try {
      let res = await doPush(token, operations);
      if (res.status === 401) {
        token = await refreshAccessToken(db);
        if (!token) return;
        res = await doPush(token, operations);
      }
      if (!res.ok) throw new Error(`sync push responded ${res.status}`);

      const result = await res.json();
      const byId = new Map((result.results || []).map((r) => [r.id, r.status]));
      for (const row of pending) {
        const outcome = byId.get(row.id);
        if (outcome === 'applied' || outcome === 'already_applied') {
          db.prepare(`UPDATE sync_queue SET status = 'synced', next_attempt_at = NULL WHERE id = ?`).run(row.id);
        } else if (outcome === 'rejected') {
          console.error(`[sync] rejected ${row.entity_type} ${row.entity_id}: ${row.last_error || 'see server response'}`);
          db.prepare(`UPDATE sync_queue SET status = 'failed', last_error = ? WHERE id = ?`).run('rejected by server', row.id);
        }
        // anything else — including the endpoint not existing yet — is
        // left `pending`, retried automatically on the next tick.
      }
    } catch (err) {
      const message = String((err && err.message) || err);
      console.error(`[sync] push failed for ${pending.length} pending item(s): ${message}`);
      for (const row of pending) {
        const nextRetryCount = row.retry_count + 1;
        const nextAttemptAt = new Date(Date.now() + backoffMs(nextRetryCount)).toISOString();
        db.prepare(
          `UPDATE sync_queue SET retry_count = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`
        ).run(nextRetryCount, message, nextAttemptAt, row.id);
      }
    }
  }

  let pullFailureCount = 0;

  async function pullTick() {
    const token = getAccessToken(db);
    if (!token) return; // not logged in yet

    const since = getLastPullAt(db);
    const url = since
      ? `${API_BASE}/sync/pull/?since=${encodeURIComponent(since)}`
      : `${API_BASE}/sync/pull/`;

    try {
      let res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401) {
        const fresh = await refreshAccessToken(db);
        if (!fresh) return;
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${fresh}` },
          signal: AbortSignal.timeout(15_000),
        });
      }
      if (!res.ok) throw new Error(`sync pull responded ${res.status}`);

      const body = await res.json();
      const operations = body.operations || [];
      if (operations.length > 0) {
        const applyAll = db.transaction(() => {
          for (const op of operations) {
            applyPulledOperation(db, op.entity_type, op.operation, op.payload);
          }
        });
        applyAll();
        console.log(`[sync] pulled and applied ${operations.length} change(s) from the cloud`);
        // THIS is what was missing: applying pulled rows to local SQLite
        // (above) makes the data correct, but nothing told the open
        // React screens to look at it again — a Sales History or POS
        // screen already on-screen when a web sale came in just kept
        // showing whatever it last rendered, until the user happened to
        // navigate away and back. Every screen that reads synced data
        // (main.js's webContents.send -> preload's onDataChanged ->
        // App.jsx bumping its tick) now re-fetches the moment something
        // actually changes, not on some arbitrary later re-mount.
        onDataChanged?.(operations);
      }
      // Cursor from the SERVER's clock, not this machine's — avoids ever
      // missing a change because of clock skew between two computers.
      setLastPullAt(db, body.server_time || new Date().toISOString());
      pullFailureCount = 0;
    } catch (err) {
      pullFailureCount += 1;
      console.error(`[sync] pull failed (attempt ${pullFailureCount}): ${String((err && err.message) || err)}`);
      // No backoff needed here the way push has one — a failed pull just
      // retries on the next regular tick, and pulls are read-only so
      // there's no risk of hammering the server with duplicate writes.
    }
  }

  // Reconcile once at startup — catches any row that somehow has ZERO
  // sync_queue history (see reconcileUnsyncedRows's docstring), before
  // the very first pushTick runs, so anything it finds gets pushed
  // immediately rather than waiting for the next scheduled tick.
  reconcileUnsyncedRows(db);
  pruneSyncQueue(db);

  /**
   * "Once it detects internet, make sure the desktop actually has the
   * same data as the backend" — the trust-but-verify backstop on top of
   * the ordinary push/pull loop above. pullTick trusts its `since` cursor
   * completely: it only asks "what changed after this timestamp", so a
   * row that was somehow missed (applied out of order and silently
   * skipped, a local DB file copied in from another machine, anything)
   * would never come back — the cursor already claims to be past it.
   *
   * This hits the cheap /api/sync/reconcile/ endpoint (row counts only,
   * no payloads) and compares against local COUNT(*)s for the same five
   * tables pullTick already knows how to fill in (ENTITY_TABLES above).
   * Any mismatch — active or total, for any one of them — means the two
   * databases disagree about how much data even exists, which a normal
   * incremental pull can't fix on its own. The fix is deliberately blunt
   * rather than clever: drop the pull cursor back to "since the
   * beginning of time" (setLastPullAt(db, null)) and let SyncPullView's
   * existing full-snapshot mode (no `since` param) resend everything.
   * No separate repair codepath to maintain or get wrong — just the same
   * pull logic already exercised on every fresh install, run once more
   * with a wider net.
   */
  async function reconcileTick() {
    const token = getAccessToken(db);
    if (!token) return; // not logged in yet

    let remoteCounts;
    try {
      const res = await fetch(`${API_BASE}/sync/reconcile/`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return; // read-only health check — just try again next scheduled reconcile
      remoteCounts = (await res.json()).counts || {};
    } catch (err) {
      console.error(`[sync] reconcile check failed: ${String((err && err.message) || err)}`);
      return;
    }

    let drift = false;
    for (const [entityType, table] of Object.entries(ENTITY_TABLES)) {
      const remote = remoteCounts[entityType];
      if (!remote) continue;
      const localTotal = db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n;
      const localActive = db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE is_deleted = 0`).get().n;
      if (localTotal !== remote.total || localActive !== remote.active) {
        console.warn(
          `[sync] reconcile: ${entityType} drifted (local ${localActive}/${localTotal} vs cloud ${remote.active}/${remote.total}) — forcing a full re-pull`
        );
        drift = true;
      }
    }

    if (drift) {
      setLastPullAt(db, null);
      await pullTick();
    }
  }

  pushTick();
  pullTick();
  const pushTimer = setInterval(pushTick, SYNC_INTERVAL_MS);
  const pullTimer = setInterval(pullTick, SYNC_INTERVAL_MS);
  // Cheap DELETE, no need to run it every 15s — every 10 minutes keeps
  // the table lean without adding meaningful overhead to the hot path.
  const pruneTimer = setInterval(() => pruneSyncQueue(db), 10 * 60_000);
  // Give the very first pullTick above a head start before checking
  // counts against it — a brand-new install's initial full pull can take
  // a few seconds for a large catalog, and reconciling mid-pull would
  // just report a drift that was already in the process of closing.
  const reconcileStartTimer = setTimeout(reconcileTick, 30_000);
  const reconcileTimer = setInterval(reconcileTick, RECONCILE_INTERVAL_MS);

  // --- Real-time trigger: don't wait up to 15s to learn about a change
  // elsewhere if we're actually online right now. Reconnects with backoff
  // on drop, exactly like the web frontend's LiveContext.jsx — same
  // reasoning: this is a latency optimization on top of the poll loops
  // above, never a replacement for them.
  let ws = null;
  let wsRetryDelay = 1000;
  let wsRetryTimer = null;
  let stopped = false;
  let hasConnectedBefore = false; // distinguishes the first connect (nothing to reconcile yet — pullTick above already did a full sync) from a RECONNECT after a drop (exactly the "once it detects internet again" moment worth double-checking)

  function connectWs() {
    if (stopped) return;
    const token = getAccessToken(db);
    if (!token) {
      wsRetryTimer = setTimeout(connectWs, 5000); // not logged in yet — check back shortly
      return;
    }
    try {
      ws = new WebSocket(wsUrl(token));
    } catch (err) {
      wsRetryTimer = setTimeout(connectWs, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 2, 30_000);
      return;
    }
    ws.onopen = () => {
      wsRetryDelay = 1000;
      if (hasConnectedBefore) reconcileTick(); // back online after a drop — verify, don't just assume the incremental pulls we missed will self-correct
      hasConnectedBefore = true;
    };
    ws.onmessage = () => { pullTick(); }; // any event at all is worth an immediate catch-up pull
    ws.onclose = () => {
      if (stopped) return;
      wsRetryTimer = setTimeout(connectWs, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 2, 30_000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  connectWs();

  return {
    stop: () => {
      stopped = true;
      clearInterval(pushTimer);
      clearInterval(pullTimer);
      clearInterval(pruneTimer);
      clearTimeout(reconcileStartTimer);
      clearInterval(reconcileTimer);
      clearTimeout(wsRetryTimer);
      try { ws && ws.close(); } catch {}
    },
    // For the "why is it slow" question to ever be answerable from a
    // screenshot instead of guesswork — the sidebar shows this live.
    getStatus: () => ({
      liveConnected: !!ws && ws.readyState === WebSocket.OPEN,
      lastPullAt: getLastPullAt(db),
      lastPushError: db.prepare(
        `SELECT last_error, client_timestamp FROM sync_queue WHERE status IN ('pending','failed') AND last_error IS NOT NULL ORDER BY client_timestamp DESC LIMIT 1`
      ).get() || null,
    }),
    // Called right after a local write (a sale rung up, a product added)
    // so it reaches the cloud immediately when we're online, instead of
    // waiting up to 15s for the next scheduled tick — the same
    // "immediately" behavior the WebSocket already gives the pull side.
    // Never awaited by the caller (see main.js) — a local write must
    // never wait on the network to finish; this just kicks pushTick off
    // in the background and lets its own error handling take it from
    // there if we're offline.
    pushNow: () => { pushTick(); },
  };
}

module.exports = { startSyncEngine };
