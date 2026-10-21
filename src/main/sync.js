const { getAccessToken, refreshSession } = require('./auth');
const restaurantStore = require('./restaurant/store');
const restaurantEngine = require('./restaurant/engine');
const {
  applyPulledOperation, getLastPullAt, setLastPullAt, pruneSyncQueue, reconcileUnsyncedRows, getSyncQueueStats,
  getSetting, setSetting,
  markEntitySynced,
} = require('./db');
const { getOrCreateDeviceId } = require('./device');

const API_BASE = process.env.BENCHLINE_API_URL || 'http://localhost:8000/api';
const SYNC_INTERVAL_MS = 15_000;
const RECONCILE_INTERVAL_MS = 10 * 60_000; // a cheap COUNT(*) check, not worth running more often than this
const START_BATCH = 25;
const MIN_BATCH = 5;
const MAX_BATCH = 100;
const PUSH_TIME_BUDGET_MS = 20_000; // one drain run yields after this long so it can never monopolise the main process
const PULL_APPLY_CHUNK = 200;       // rows applied per SQLite transaction while pulling
const PULL_DEBOUNCE_MS = 800;       // a burst of WebSocket events becomes ONE pull
const MAX_BACKOFF_MS = 5 * 60_000;  // never wait longer than 5 minutes between retries of the same row

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
// capped at 5 min. Only applied when the SERVER answered badly (5xx, deferred
// dependency) — never for "there is no internet", which is not the row's fault.
function backoffMs(retryCount) {
  return Math.min(SYNC_INTERVAL_MS * 2 ** retryCount, MAX_BACKOFF_MS);
}

function wsUrl(token, deviceId) {
  const httpBase = API_BASE.replace(/\/api\/?$/, '');
  const wsBase = httpBase.replace(/^http/, 'ws');
  // &device=: the socket's pongs then count as this till's heartbeat on the cloud (stage 1b).
  return `${wsBase}/ws/live/?token=${encodeURIComponent(token)}&device=${encodeURIComponent(deviceId)}`;
}

const PULL_PAGE_SIZE = 500;   // rows per pull page (a first sync of a big shop comes in several pages)
const MAX_PULL_PAGES = 400;   // safety stop for one pull run (200,000 rows); the next run carries on

// Sent on every sync call so the cloud scopes it to the branch this till is PAIRED to (not to
// whatever the signed-in account would resolve to on its own: a CEO with several branches has no
// single branch, and every push used to be refused).
const DEVICE_HEADER = 'X-Device-ID';
const REMOVED_MESSAGE = 'This till was removed from the shop. Sign in again to pair it.';

const PAUSED_MESSAGE = 'Cloud sync is paused because the subscription has ended. Selling continues on this till; everything uploads once it is renewed.';

/** The cloud's own words for a 402 (subscription ended), or a plain default. */
async function pausedMessage(res) {
  try {
    const body = await res.json();
    return (body && typeof body.detail === 'string' && body.detail) || PAUSED_MESSAGE;
  } catch {
    return PAUSED_MESSAGE;
  }
}

const isTimeout = (err) => !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');

/**
 * Push AND pull, plus a WebSocket connection that triggers a pull the moment
 * anything changes elsewhere.
 *
 * Guarantees (each one is covered by test/sync.engine.test.js):
 *  - SINGLE-FLIGHT. At most one push is ever in flight and at most one pull.
 *    pushNow() during a push just asks for another round when this one ends.
 *    (Previously the per-sale pushNow() and the 15s timer could send the same
 *    rows concurrently, which the server then had to untangle.)
 *  - DRAINING. A push keeps sending batches until the outbox is empty (or a
 *    ~20s budget is used) instead of one 25-row batch per 15s tick.
 *  - OFFLINE IS NOT FAILURE. When no HTTP response arrives at all, nothing is
 *    counted against the rows and no backoff is scheduled; the next attempt is
 *    simply the next tick, so sync resumes the moment internet returns.
 *  - A DEFERRED ROW CANNOT BLOCK OTHERS. The server leaves an op out of its
 *    results when something it depends on hasn't arrived. That row now backs off
 *    (instead of being re-selected first, forever), so the rows behind it flow.
 *    It is NOT failed: its parent may just be slow.
 *  - REJECTIONS ARE VISIBLE. A rejected row becomes `failed` carrying the
 *    server's own error text, is counted in getStatus().queue.failed, never
 *    pruned, and can be retried (db.retryFailedSync).
 *  - PUSH BEFORE PULL, and a pull never trusts one bad row (see applyPulled).
 *
 * PUSH targets `/api/sync/push/`, PULL targets `/api/sync/pull/?since=<cursor>`.
 * The WebSocket is a pure latency optimisation; the poll is what guarantees
 * eventual consistency, and nothing here ever sits in the path of ringing a sale.
 */
function startSyncEngine(db, onDataChanged) {
  // ---- connectivity, as the sidebar and the owner see it ---------------------------------
  // 'ok' | 'offline' | 'degraded' (server answered badly) | 'auth_required' | 'unsupported' | 'paused' (subscription ended)
  const cloud = { state: 'ok', message: '', lastSuccessAt: null, lastErrorAt: null };
  function setCloud(state, message = '') {
    const was = cloud.state;
    cloud.state = state;
    cloud.message = message;
    if (state === 'ok') cloud.lastSuccessAt = new Date().toISOString();
    else cloud.lastErrorAt = new Date().toISOString();
    return was;
  }

  let batchSize = START_BATCH;
  let pushPromise = null;
  let pushAgain = false;
  let pullPromise = null;
  let pullRerun = false;
  let pullQueuedBehindPush = false;
  let pullFailureCount = 0;
  let lastPullSkipped = 0;
  let pullDebounceTimer = null;
  const deviceId = getOrCreateDeviceId(db);
  // Pulls overlap the previous one by a couple of minutes (the cloud's next_since), so the same
  // row can arrive twice. Applying it again is harmless, but this remembers what was applied at
  // which updated_at so an unchanged row is not re-applied (or re-announced to the screens).
  const appliedInOverlap = new Map(); // `${entity_type}:${entity_id}` -> updated_at

  async function doPush(token, operations) {
    return fetch(`${API_BASE}/sync/push/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, [DEVICE_HEADER]: deviceId },
      body: JSON.stringify({ operations }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  // Rows the server answered badly for (5xx, 429, unreadable body): a COUNTED attempt with backoff.
  const countFailure = db.transaction((rows, message) => {
    const now = new Date().toISOString();
    for (const row of rows) {
      const nextRetryCount = row.retry_count + 1;
      db.prepare(`UPDATE sync_queue SET retry_count = ?, last_error = ?, next_attempt_at = ?, last_attempt_at = ? WHERE id = ?`)
        .run(nextRetryCount, message, new Date(Date.now() + backoffMs(nextRetryCount)).toISOString(), now, row.id);
    }
  });

  // After the cloud had trouble (5xx, 429, unreadable reply), rows were pushed back by up to 5 min.
  // The moment the cloud answers properly again, those rows go straight back in line (G10), instead
  // of sitting out their backoff while the cloud is fine. Rows waiting for a parent record keep theirs.
  function releaseServerErrorBackoff() {
    const released = db.prepare(
      `UPDATE sync_queue SET next_attempt_at = NULL
       WHERE status = 'pending' AND next_attempt_at IS NOT NULL
         AND (last_error LIKE 'sync push responded 5%' OR last_error = 'sync push responded 429'
              OR last_error = 'sync push returned an unreadable response')`
    ).run().changes;
    if (released > 0) console.log(`[sync] the cloud recovered: ${released} row(s) released from backoff`);
    return released;
  }

  const applyOutcomes = db.transaction((rows, byId) => {
    const now = new Date().toISOString();
    for (const row of rows) {
      const outcome = byId.get(row.id);
      const status = outcome && outcome.status;
      if (status === 'applied' || status === 'already_applied') {
        db.prepare(`UPDATE sync_queue SET status = 'synced', next_attempt_at = NULL, last_error = NULL, last_attempt_at = ?, acked_at = ? WHERE id = ?`)
          .run(now, now, row.id);
        markEntitySynced(db, row.entity_type, row.entity_id, now);
      } else if (status === 'rejected') {
        const why = (outcome.error && String(outcome.error)) || 'rejected by server';
        console.error(`[sync] rejected ${row.entity_type} ${row.entity_id}: ${why}`);
        db.prepare(`UPDATE sync_queue SET status = 'failed', last_error = ?, last_attempt_at = ? WHERE id = ?`).run(why, now, row.id);
      } else {
        // Left out of `results` (or a status we don't know): the server is waiting on something
        // this op depends on. Back off so the rows BEHIND it get their turn, but never fail it.
        const nextRetryCount = row.retry_count + 1;
        db.prepare(`UPDATE sync_queue SET retry_count = ?, last_error = ?, next_attempt_at = ?, last_attempt_at = ? WHERE id = ?`)
          .run(nextRetryCount, 'waiting for a related record to sync first',
            new Date(Date.now() + backoffMs(nextRetryCount)).toISOString(), now, row.id);
      }
    }
  });

  /** One HTTP round trip. Resolves to 'progress' (a batch was processed), 'idle' (nothing to do), or 'stop' (can't continue now). */
  async function pushBatch() {
    const pending = db.prepare(
      `SELECT * FROM sync_queue
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY client_timestamp LIMIT ?`
    ).all(new Date().toISOString(), batchSize);
    if (pending.length === 0) return 'idle';

    let token = getAccessToken(db);
    if (!token) return 'idle'; // not logged in yet

    const operations = pending.map((row) => ({
      id: row.id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      operation: row.operation,
      payload: JSON.parse(row.payload),
      client_timestamp: row.client_timestamp,
    }));

    let res;
    try {
      res = await doPush(token, operations);
      if (res.status === 401) {
        const refreshed = await refreshSession(db);
        if (!refreshed.ok) {
          if (refreshed.reason === 'network') { setCloud('offline', 'No internet connection.'); return 'stop'; }
          if (refreshed.reason === 'server') { setCloud('degraded', 'The cloud is having trouble.'); return 'stop'; }
          setCloud('auth_required', 'Your session expired. Sign in while online to resume syncing.');
          return 'stop';
        }
        token = refreshed.token;
        res = await doPush(token, operations);
        if (res.status === 401) {
          setCloud('auth_required', 'Your session expired. Sign in while online to resume syncing.');
          return 'stop';
        }
      }
    } catch (err) {
      // No HTTP response at all: offline, DNS, refused, TLS, or our own timeout. Not the rows' fault.
      if (isTimeout(err)) batchSize = Math.max(MIN_BATCH, Math.floor(batchSize / 2)); // slow link: smaller bites
      setCloud('offline', 'No internet connection.');
      console.error(`[sync] push could not reach the cloud (${String((err && err.message) || err)}); ${pending.length} item(s) stay queued`);
      return 'stop';
    }

    if (res.status === 402) {
      // Subscription ended: sync is paused, not failing. Nothing is counted against the rows and
      // nothing is lost; they all go up once the shop renews.
      setCloud('paused', await pausedMessage(res));
      return 'stop';
    }
    if (res.status === 410) {
      // This till was unpaired in Settings -> Devices. Nothing is the rows' fault: keep them all
      // (they upload once someone signs in again and re-pairs the till) and burn no retries.
      setCloud('auth_required', REMOVED_MESSAGE);
      return 'stop';
    }
    if (res.status === 404 || res.status === 405) {
      // The cloud hasn't been updated to this version yet. Keep everything, burn nothing.
      setCloud('unsupported', 'The cloud has not been updated for this version yet.');
      return 'stop';
    }
    if (!res.ok) {
      const message = `sync push responded ${res.status}`;
      console.error(`[sync] ${message} for ${pending.length} item(s)`);
      countFailure(pending, message);
      setCloud('degraded', 'The cloud is having trouble. Will retry.');
      return 'stop';
    }

    let result;
    try {
      result = await res.json();
    } catch {
      countFailure(pending, 'sync push returned an unreadable response');
      setCloud('degraded', 'The cloud is having trouble. Will retry.');
      return 'stop';
    }

    applyOutcomes(pending, new Map((result.results || []).map((r) => [r.id, r])));
    if (setCloud('ok') === 'degraded') releaseServerErrorBackoff();
    if (pending.length === batchSize) batchSize = Math.min(MAX_BATCH, Math.ceil(batchSize * 1.25));
    return 'progress';
  }

  /** The single-flight push. Safe to call as often as you like; never rejects. */
  function pushNow() {
    if (pushPromise) { pushAgain = true; return pushPromise; }
    pushPromise = (async () => {
      try {
        const deadline = Date.now() + PUSH_TIME_BUDGET_MS;
        do {
          pushAgain = false;
          let outcome;
          do { outcome = await pushBatch(); } while (outcome === 'progress' && Date.now() < deadline);
        } while (pushAgain && Date.now() < deadline);
      } catch (err) {
        console.error(`[sync] push cycle crashed: ${String((err && err.stack) || err)}`);
      } finally {
        pushPromise = null;
        if (pullQueuedBehindPush) { pullQueuedBehindPush = false; pullNow(); }
      }
    })();
    return pushPromise;
  }

  // ---- pull ------------------------------------------------------------------------------
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const overlapKey = (op) => `${op.entity_type}:${op.entity_id}`;

  function applyChunk(chunk, skipped) {
    db.transaction(() => {
      for (const op of chunk) {
        // One bad row must not freeze the whole pull forever (the cursor would never advance):
        // apply each row inside its own savepoint and skip the ones that throw, loudly.
        db.exec('SAVEPOINT pull_op');
        try {
          applyPulledOperation(db, op.entity_type, op.operation, op.payload);
          db.exec('RELEASE pull_op');
          if (op.updated_at) appliedInOverlap.set(overlapKey(op), op.updated_at);
        } catch (err) {
          db.exec('ROLLBACK TO pull_op');
          db.exec('RELEASE pull_op');
          skipped.push({ entity_type: op.entity_type, error: String((err && err.message) || err) });
          console.error(`[sync] pull: skipped one ${op.entity_type} (${String((err && err.message) || err)})`);
        }
      }
    })();
  }

  /** One page of a pull. Resolves to the parsed body, or null when this run must stop (state set). */
  async function fetchPullPage(since, cursor, entityTypes = null) {
    let token = getAccessToken(db);
    if (!token) return null; // not logged in yet
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    if (entityTypes) params.set('entity_types', entityTypes);
    params.set('limit', String(PULL_PAGE_SIZE));
    if (cursor) params.set('cursor', cursor);
    const url = `${API_BASE}/sync/pull/?${params.toString()}`;
    const fetchPull = (t) => fetch(url, {
      headers: { Authorization: `Bearer ${t}`, [DEVICE_HEADER]: deviceId },
      signal: AbortSignal.timeout(15_000),
    });

    let res;
    try {
      res = await fetchPull(token);
      if (res.status === 401) {
        const refreshed = await refreshSession(db);
        if (!refreshed.ok) {
          if (refreshed.reason === 'network') setCloud('offline', 'No internet connection.');
          else if (refreshed.reason !== 'server') setCloud('auth_required', 'Your session expired. Sign in while online to resume syncing.');
          return null;
        }
        res = await fetchPull(refreshed.token);
      }
    } catch (err) {
      pullFailureCount += 1;
      setCloud('offline', 'No internet connection.');
      console.error(`[sync] pull could not reach the cloud (attempt ${pullFailureCount}): ${String((err && err.message) || err)}`);
      return null;
    }
    if (res.status === 410) { setCloud('auth_required', REMOVED_MESSAGE); return null; }
    if (res.status === 402) { setCloud('paused', await pausedMessage(res)); return null; }
    if (!res.ok) {
      pullFailureCount += 1;
      console.error(`[sync] pull failed (attempt ${pullFailureCount}): sync pull responded ${res.status}`);
      return null;
    }
    try { return await res.json(); } catch {
      pullFailureCount += 1;
      console.error(`[sync] pull failed (attempt ${pullFailureCount}): unreadable response`);
      return null;
    }
  }

  async function pullOnce() {
    const since = getLastPullAt(db);
    let cursor = null;
    let firstBody = null;
    let lastBody = null;
    let pages = 0;
    let applied = 0;
    let skippedCount = 0;
    const changed = [];
    // Page by page (G11): a first sync of a big shop no longer arrives as one giant response that
    // freezes the till while it parses. An older cloud ignores limit/cursor and sends one page.
    do {
      const body = await fetchPullPage(since, cursor);
      if (!body) return; // stopped part-way: the cursor is NOT advanced, so the next run starts again from `since` (every apply is idempotent)
      firstBody = firstBody || body;
      lastBody = body;
      pages += 1;

      // A successful round trip after being offline (or paused) is the "it's back" moment: say so,
      // and push whatever queued up meanwhile right away. ('degraded' is about PUSHES failing, so only
      // a successful push clears it, and releases the rows it had backed off.)
      if (cloud.state === 'offline' || cloud.state === 'paused') {
        setCloud('ok');
        setImmediate(() => pushNow());
      }

      // Rows already applied at this exact version during the previous (overlapping) pull are
      // dropped here; anything new or changed since goes through as before.
      const operations = (body.operations || []).filter(
        (op) => !(op.updated_at && appliedInOverlap.get(overlapKey(op)) === op.updated_at)
      );
      // Applied in small chunks, yielding between them: better-sqlite3 is synchronous and shares
      // the main thread with every IPC call, so one giant transaction would freeze the till.
      const skipped = [];
      for (let i = 0; i < operations.length; i += PULL_APPLY_CHUNK) {
        applyChunk(operations.slice(i, i + PULL_APPLY_CHUNK), skipped);
        if (i + PULL_APPLY_CHUNK < operations.length) await tick();
      }
      applied += operations.length - skipped.length;
      skippedCount += skipped.length;
      changed.push(...operations);

      cursor = body.has_more && body.next_cursor ? body.next_cursor : null;
      if (cursor) await tick();
    } while (cursor && pages < MAX_PULL_PAGES);

    lastPullSkipped = skippedCount;
    if (changed.length > 0) {
      console.log(`[sync] pulled and applied ${applied} change(s) from the cloud${pages > 1 ? ` in ${pages} pages` : ''}`);
      onDataChanged?.(changed);
    }
    if (cursor) return; // hit the page safety stop: keep the old cursor, carry on next run

    // Which operation formats this cloud accepts (db.cloudSyncProtocol). Absent = an older cloud = 1.
    const previousProtocol = Number(getSetting(db, 'cloud_sync_protocol')) || 1;
    const protocol = Number(lastBody.sync_protocol) || 1;
    setSetting(db, 'cloud_sync_protocol', String(protocol));
    if (protocol > previousProtocol) {
      // The cloud just learned new record kinds (e.g. shifts at 3): queue what this till holds of
      // them now, instead of waiting for the next restart's reconcile.
      if (reconcileUnsyncedRows(db) > 0) setImmediate(() => pushNow());
      // Restaurant orders finished while the cloud could not take them yet (protocol < 6).
      if (restaurantEngine.reconcileOrders(db) > 0) setImmediate(() => pushNow());
    }
    if (protocol >= 4 && !getSetting(db, 'stock_movements_backfilled')) await backfillStockMovements();
    if (isRestaurantBranch()) await pullRestaurantConfig();
    // Cursor from the SERVER's clock, not this machine's. next_since (from the FIRST page, the
    // earliest read) is already moved back behind the read, so a row committed while this pull was
    // reading comes back next time instead of being skipped forever (G4). Older clouds: server_time.
    const nextCursor = firstBody.next_since || firstBody.server_time || new Date().toISOString();
    setLastPullAt(db, nextCursor);
    // What the sidebar shows as "last update from cloud": when this pull happened, not the cursor.
    setSetting(db, 'last_pull_completed_at', lastBody.server_time || new Date().toISOString());
    for (const [key, updatedAt] of appliedInOverlap) {
      if (Date.parse(updatedAt) <= Date.parse(nextCursor)) appliedInOverlap.delete(key); // cannot come back: the next pull starts after it
    }
    pullFailureCount = 0;
  }

  /**
   * Once, the first time this till talks to a cloud with the stock ledger (protocol 4): fetch every
   * damage/count/service-part movement from the beginning. The ordinary pull's cursor may already be
   * past movements recorded while this till was still on an older version that ignored them.
   * Each one is applied at most once (db.applyPulledStockMovement), so a repeat is harmless.
   */
  async function backfillStockMovements() {
    let cursor = null;
    let pages = 0;
    const changed = [];
    do {
      const body = await fetchPullPage(null, cursor, 'stock_movement');
      if (!body) return; // try again on the next pull
      const skipped = [];
      const operations = body.operations || [];
      for (let i = 0; i < operations.length; i += PULL_APPLY_CHUNK) {
        applyChunk(operations.slice(i, i + PULL_APPLY_CHUNK), skipped);
        await tick();
      }
      changed.push(...operations);
      pages += 1;
      cursor = body.has_more && body.next_cursor ? body.next_cursor : null;
    } while (cursor && pages < MAX_PULL_PAGES);
    if (cursor) return;
    setSetting(db, 'stock_movements_backfilled', new Date().toISOString());
    if (changed.length > 0) onDataChanged?.(changed);
  }

  /** Is this till's branch a restaurant branch? (modules come from /api/me at sign-in) */
  function isRestaurantBranch() {
    try {
      const shop = JSON.parse(getSetting(db, 'shop_settings') || '{}');
      return Array.isArray(shop.modules) && shop.modules.includes('restaurant');
    } catch {
      return false;
    }
  }

  /**
   * Restaurant configuration (menu, tables, stations, taxes, settings). The cloud sends these only
   * when they are asked for by name AND the branch is a restaurant branch, so this pass has its own
   * cursor and runs only on restaurant branches. Same paging and overlap rules as the main pull;
   * applying a row twice is harmless (plain upserts).
   */
  async function pullRestaurantConfig() {
    const since = getSetting(db, 'restaurant_last_pull_at');
    let cursor = null;
    let first = null;
    let pages = 0;
    const changed = [];
    const skipped = [];
    do {
      const body = await fetchPullPage(since, cursor, restaurantStore.PULL_TYPES.join(','));
      if (!body) return; // try again next pull; the cursor is not advanced
      first = first || body;
      const operations = body.operations || [];
      for (let i = 0; i < operations.length; i += PULL_APPLY_CHUNK) {
        applyChunk(operations.slice(i, i + PULL_APPLY_CHUNK), skipped);
        await tick();
      }
      changed.push(...operations);
      pages += 1;
      cursor = body.has_more && body.next_cursor ? body.next_cursor : null;
    } while (cursor && pages < MAX_PULL_PAGES);
    // A row that would not apply is skipped like in the main pull, and counted in the same place so
    // the sync status shows it instead of a menu item silently missing on the hub.
    lastPullSkipped += skipped.length;
    if (cursor) return;
    setSetting(db, 'restaurant_last_pull_at', first.next_since || first.server_time || new Date().toISOString());
    if (changed.length > 0) onDataChanged?.(changed);
  }

  /** The single-flight pull. A pull requested during a push waits for it (push first, then pull). */
  function pullNow() {
    if (pushPromise) { pullQueuedBehindPush = true; return pushPromise; }
    if (pullPromise) { pullRerun = true; return pullPromise; }
    pullPromise = (async () => {
      try {
        do {
          pullRerun = false;
          await pullOnce();
        } while (pullRerun);
      } catch (err) {
        console.error(`[sync] pull cycle crashed: ${String((err && err.stack) || err)}`);
      } finally {
        pullPromise = null;
      }
    })();
    return pullPromise;
  }

  function requestPull() {
    clearTimeout(pullDebounceTimer);
    pullDebounceTimer = setTimeout(() => { pullNow(); }, PULL_DEBOUNCE_MS);
  }

  async function syncTick() {
    await pushNow();
    await pullNow();
  }

  // Reconcile once at startup — catches any row that somehow has ZERO
  // sync_queue history (see reconcileUnsyncedRows's docstring), before
  // the very first push runs, so anything it finds gets pushed
  // immediately rather than waiting for the next scheduled tick.
  reconcileUnsyncedRows(db);
  pruneSyncQueue(db);

  /**
   * "Once it detects internet, make sure the desktop actually has the
   * same data as the backend" — the trust-but-verify backstop on top of
   * the ordinary push/pull loop above. pullOnce trusts its `since` cursor
   * completely: it only asks "what changed after this timestamp", so a
   * row that was somehow missed (applied out of order and silently
   * skipped, a local DB file copied in from another machine, anything)
   * would never come back — the cursor already claims to be past it.
   *
   * This hits the cheap /api/sync/reconcile/ endpoint (row counts only,
   * no payloads) and compares against local COUNT(*)s for the same five
   * tables pullOnce already knows how to fill in (ENTITY_TABLES above).
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

    // Row counts only mean something once this till has nothing waiting to upload. With a
    // backlog (or failed rows) the local count is LEGITIMATELY ahead of the cloud's; calling
    // that "drift" forced a full re-pull of everything every 10 minutes for as long as the
    // backlog lasted.
    const queue = getSyncQueueStats(db);
    if (queue.pending > 0 || queue.failed > 0) return;

    let remoteCounts;
    try {
      const res = await fetch(`${API_BASE}/sync/reconcile/`, {
        headers: { Authorization: `Bearer ${token}`, [DEVICE_HEADER]: deviceId },
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
      await pullNow();
    }
  }

  syncTick(); // push first, then pull
  const syncTimer = setInterval(syncTick, SYNC_INTERVAL_MS);
  // Cheap DELETE, no need to run it every 15s — every 10 minutes keeps
  // the table lean without adding meaningful overhead to the hot path.
  const pruneTimer = setInterval(() => pruneSyncQueue(db), 10 * 60_000);
  // Give the very first pull above a head start before checking
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
  let hasConnectedBefore = false; // distinguishes the first connect (nothing to reconcile yet — the first pull above already did a full sync) from a RECONNECT after a drop (exactly the "once it detects internet again" moment worth double-checking)
  let wsReconnectCount = 0; // observability only (see getStatus below) — how flaky has this till's connection actually been today

  function connectWs() {
    if (stopped) return;
    const token = getAccessToken(db);
    if (!token) {
      wsRetryTimer = setTimeout(connectWs, 5000); // not logged in yet — check back shortly
      return;
    }
    try {
      ws = new WebSocket(wsUrl(token, deviceId));
    } catch (err) {
      wsRetryTimer = setTimeout(connectWs, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 2, 30_000);
      return;
    }
    ws.onopen = () => {
      wsRetryDelay = 1000;
      pushNow(); // connection is back: send whatever queued up meanwhile right now, not at the next 15s tick
      if (hasConnectedBefore) reconcileTick(); // back online after a drop — verify, don't just assume the incremental pulls we missed will self-correct
      hasConnectedBefore = true;
    };
    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        requestPull(); // unparseable — treat conservatively as "something happened"
        return;
      }
      if (data && data.event === 'ping') {
        // App-level heartbeat only (see backend realtime/consumers.py) --
        // not a domain event. Reply so the server can tell this
        // connection is actually alive, not just technically open, but
        // don't waste a pull cycle on it -- previously EVERY message
        // triggered pullTick(), so adding a periodic server heartbeat
        // would otherwise have turned into a pull every ~30s regardless
        // of whether anything actually changed.
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
        return;
      }
      // 'hello' (sent on every connect/reconnect) and any real domain
      // event both land here -- both are worth an immediate catch-up
      // pull. This deliberately does not try to be smarter than that
      // (e.g. reading `sequence` to decide whether a pull is really
      // needed): reconcileTick() on reconnect below is the actual
      // safety net for anything missed outright, so a slightly
      // over-eager pull here costs a bit of bandwidth, never correctness.
      // Debounced + single-flight: a burst of events (a big sync from
      // another till) is ONE pull, not one pull per message.
      requestPull();
    };
    ws.onclose = () => {
      if (stopped) return;
      wsReconnectCount += 1;
      wsRetryTimer = setTimeout(connectWs, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 2, 30_000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  connectWs();

  return {
    stop: () => {
      stopped = true;
      clearInterval(syncTimer);
      clearTimeout(pullDebounceTimer);
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
      liveReconnectCount: wsReconnectCount,
      lastPullAt: getSetting(db, 'last_pull_completed_at') || getLastPullAt(db),
      // What the cashier/owner actually needs to know about getting data to the cloud — kept
      // separate from `liveConnected` (the WebSocket), which says nothing about whether
      // uploads are working.
      cloudSync: { ...cloud },
      queue: getSyncQueueStats(db),
      lastPullSkipped,
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
    // Returns a promise (callers may ignore it — it never rejects) that resolves
    // when the push cycle, including any round queued behind it, has finished.
    pushNow,
    pullNow,
  };
}

module.exports = { startSyncEngine };
