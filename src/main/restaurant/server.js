/*
 * The hub's local server on the shop's Wi-Fi, for kitchen screens (gss docs/restaurant/API_SPECIFICATION.md §2,
 * OFFLINE_SYNCHRONIZATION.md §3 and §6, WEBSOCKET_EVENTS.md).
 *
 *   GET  /kds                              the kitchen screen page (any browser; pairs itself)
 *   GET  /hub/v1/health                    "is the hub there?" (no data)
 *   POST /hub/v1/pair                      6-digit code -> screen token (also set as a cookie)
 *   GET  /hub/v1/kds/state                 the screen's tickets, now
 *   GET  /hub/v1/events                    Server-Sent Events; resumes from Last-Event-ID
 *   POST /hub/v1/ticket-items/{id}/state   T4/T5 {"to": "preparing", "version": 3}
 *   POST /hub/v1/tickets/{id}/bump         the whole ticket ready
 *
 * Rules:
 *  - The screen holds nothing of record: it shows the hub's state and asks the hub to change it.
 *    Events only say WHAT changed; the screen re-reads the state, so an event seen twice is harmless.
 *  - Every request except the page, health and pairing needs a paired screen's token (cookie or
 *    Bearer). A screen sees and changes only its own stations; the engine checks that again.
 *  - Browsers on other sites cannot use a screen's cookie (SameSite=Strict) and cannot send JSON
 *    here without a CORS pre-flight this server never approves.
 *  - Runs only on the branch's hub, and only while some station shows on a screen (createLan).
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const screens = require('./screens');
const engine = require('./engine');

const { RestaurantError } = store;
const PORT = 7700;
const MAX_BODY = 16 * 1024;
const PING_MS = 15_000;
const POLL_MS = 1_000;
const COOKIE = 'bl_screen';
const KDS_PAGE = path.join(__dirname, 'kds.html');

const API_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { ...API_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

function sendError(res, e) {
  if (e instanceof RestaurantError) {
    return sendJson(res, e.status || 400, { detail: e.message, code: e.code, ...(e.current !== undefined ? { current: e.current } : {}) });
  }
  console.error('[restaurant/lan]', e);
  return sendJson(res, 500, { detail: 'Something went wrong. Nothing was changed.', code: 'unexpected' });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.startsWith('application/json')) {
      reject(new RestaurantError('json_only', 'Send JSON (Content-Type: application/json).', 415));
      req.resume();
      return;
    }
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new RestaurantError('too_large', 'Request too large.', 413)); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8');
      if (!text) return resolve({});
      try {
        const body = JSON.parse(text);
        resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      } catch {
        reject(new RestaurantError('bad_json', 'That request was not valid JSON.', 400));
      }
    });
    req.on('error', reject);
  });
}

function cookieToken(req) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function tokenFrom(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return cookieToken(req);
}

function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}/kds`);
    }
  }
  return out;
}

/** The HTTP server itself. `listen()` / `close()` are driven by createLan(); tests use it directly. */
function createHubServer(db, { appVersion = '', cloudStatus = () => null } = {}) {
  const clients = new Set();
  let server = null;
  let pingTimer = null;
  let pollTimer = null;

  const highest = () => (db.prepare(`SELECT MAX(seq) AS hi, MIN(seq) AS lo FROM r_events`).get() || {});

  function screenFor(req) {
    const screen = screens.authenticate(db, tokenFrom(req));
    if (!screen) throw new RestaurantError('not_paired', 'This screen is not paired with the hub (or was removed). Enter a new code.', 401);
    return screen;
  }

  function write(client, text) {
    try { client.res.write(text); } catch { drop(client); }
  }

  function drop(client) {
    clients.delete(client);
    try { client.res.end(); } catch {}
  }

  /** Send every client the events after its position that concern its stations. */
  function pump() {
    for (const client of clients) {
      // A screen removed while connected is cut off.
      if (!screens.authenticate(db, client.token)) { write(client, 'event: unpaired\ndata: {}\n\n'); drop(client); continue; }
      let advanced = false;
      for (;;) {
        const rows = db.prepare(`SELECT * FROM r_events WHERE seq > ? ORDER BY seq LIMIT 500`).all(client.seq);
        if (!rows.length) break;
        for (const r of rows) {
          client.seq = r.seq;
          advanced = true;
          const stationIds = JSON.parse(r.station_ids);
          if (!stationIds.some((s) => client.stationIds.includes(s))) continue;
          const envelope = { id: r.id, seq: r.seq, type: r.type, schema: 1, entity: { type: r.entity_type, id: r.entity_id }, at: r.at, data: JSON.parse(r.data) };
          write(client, `id: ${r.seq}\nevent: ${r.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
          client.sentSeq = r.seq;
        }
        if (rows.length < 500) break;
      }
      // Events for other stations still move this screen's resume point on (an id-only message
      // updates the browser's Last-Event-ID without firing anything), so a reconnect never re-scans them.
      if (advanced && client.sentSeq !== client.seq) { write(client, `id: ${client.seq}\n\n`); client.sentSeq = client.seq; }
    }
  }

  function openStream(req, res, url) {
    const screen = screenFor(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const { hi = 0, lo = null } = highest();
    const top = hi || 0;
    // Resume point: the browser's Last-Event-ID after a drop, or the `after` the page read with its state.
    const raw = req.headers['last-event-id'] !== undefined ? req.headers['last-event-id'] : url.searchParams.get('after');
    const from = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    const client = { res, token: tokenFrom(req), stationIds: screen.station_ids, seq: top, sentSeq: top };
    if (from !== null && Number.isInteger(from) && from >= 0) {
      if (from > top || (lo !== null && from < lo - 1)) {
        // The hub's log was reset, or the screen was away longer than the log keeps (7 days).
        res.write(`id: ${top}\nevent: resync\ndata: {}\n\n`);
      } else {
        client.seq = from;
        client.sentSeq = from;
      }
    }
    clients.add(client);
    req.on('close', () => clients.delete(client));
    pump();
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://hub.local');
    const p = url.pathname;
    const key = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']).slice(0, 100) : null;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/kds' || p === '/kds/')) {
        if (p === '/') { res.writeHead(302, { Location: '/kds' }); return res.end(); }
        res.writeHead(200, PAGE_HEADERS);
        return res.end(fs.readFileSync(KDS_PAGE));
      }
      if (req.method === 'GET' && p === '/hub/v1/health') {
        return sendJson(res, 200, { app: 'benchline-hub', version: appVersion, time: new Date().toISOString(), hub: store.hubStatus(db).is_hub, cloud: cloudStatus() });
      }
      if (req.method === 'POST' && p === '/hub/v1/pair') {
        const body = await readJson(req);
        const { token, screen } = screens.pair(db, body.code);
        return sendJson(res, 201, { token, screen: { id: screen.id, name: screen.name, stations: screen.stations } }, {
          'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${5 * 365 * 24 * 3600}`,
        });
      }
      if (req.method === 'GET' && p === '/hub/v1/kds/state') {
        const screen = screenFor(req);
        return sendJson(res, 200, {
          screen: { id: screen.id, name: screen.name, stations: screen.stations.filter((s) => screen.station_ids.includes(s.id)) },
          tickets: engine.kitchenView(db, screen.station_ids),
          seq: highest().hi || 0,
          time: new Date().toISOString(),
          warn_after_minutes: 10, late_after_minutes: 20, time_zone: 'Africa/Lagos',
        });
      }
      if (req.method === 'GET' && p === '/hub/v1/events') return openStream(req, res, url);

      let m = p.match(/^\/hub\/v1\/ticket-items\/([^/]+)\/state$/);
      if (req.method === 'POST' && m) {
        const screen = screenFor(req);
        const body = await readJson(req);
        const out = engine.setTicketItemState(db, decodeURIComponent(m[1]), { to: body.to, version: body.version }, screens.contextFor(screen), key);
        notify();
        return sendJson(res, 200, out);
      }
      m = p.match(/^\/hub\/v1\/tickets\/([^/]+)\/bump$/);
      if (req.method === 'POST' && m) {
        const screen = screenFor(req);
        await readJson(req);
        const out = engine.bumpTicket(db, decodeURIComponent(m[1]), screens.contextFor(screen), key);
        notify();
        return sendJson(res, 200, out);
      }
      if (p.startsWith('/hub/v1/') || p === '/kds') return sendJson(res, 404, { detail: 'Not found.', code: 'not_found' });
      return sendJson(res, 404, { detail: 'Not found.', code: 'not_found' });
    } catch (e) {
      return sendError(res, e);
    }
  }

  function notify() { setImmediate(pump); }

  function listen(port = PORT, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => { handle(req, res); });
      s.requestTimeout = 15_000;
      s.headersTimeout = 10_000;
      s.keepAliveTimeout = 5_000;
      s.once('error', reject);
      s.listen(port, host, () => {
        s.removeListener('error', reject);
        server = s;
        pingTimer = setInterval(() => { for (const c of clients) write(c, ': ping\n\n'); }, PING_MS);
        pollTimer = setInterval(pump, POLL_MS); // changes made anywhere still reach screens within a second
        pingTimer.unref(); pollTimer.unref();
        resolve(s.address().port);
      });
    });
  }

  function close() {
    clearInterval(pingTimer);
    clearInterval(pollTimer);
    for (const c of [...clients]) drop(c);
    const s = server;
    server = null;
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }

  return { listen, close, notify, pump, clientCount: () => clients.size, listening: () => Boolean(server), port: () => (server ? server.address().port : null) };
}

/**
 * Starts the local server when this till is the hub and some station shows on a screen; stops it
 * otherwise. Checked every few seconds, so switching screens on in the cloud (or this till becoming
 * the hub) needs no restart.
 */
function createLan(db, { port = PORT, host = '0.0.0.0', appVersion = '', cloudStatus = () => null, checkEveryMs = 5_000 } = {}) {
  const hub = createHubServer(db, { appVersion, cloudStatus });
  let error = null;
  let stopped = false;
  let chain = Promise.resolve(); // checks run one after another, never two at once

  const wanted = () => store.hubStatus(db).is_hub
    && Boolean(db.prepare(`SELECT 1 FROM r_stations WHERE is_active = 1 AND is_deleted = 0 AND shows_on_screen = 1 LIMIT 1`).get());

  async function runCheck() {
    if (stopped) return;
    let want = false;
    try { want = wanted(); } catch { want = false; } // database closing: treat as "not wanted"
    if (want && !hub.listening()) {
      try {
        await hub.listen(port, host);
        error = null;
      } catch (e) {
        error = e.code === 'EADDRINUSE'
          ? `Port ${port} is already used by another program on this PC.`
          : `The kitchen screen server could not start (${e.message}).`;
      }
    } else if (!want && hub.listening()) {
      await hub.close();
    }
  }

  function check() {
    chain = chain.then(runCheck).catch(() => {});
    return chain;
  }

  const timer = setInterval(check, checkEveryMs);
  timer.unref(); // never what keeps the app (or a test) running
  check();

  return {
    check,
    notify: () => hub.notify(),
    status: () => ({ listening: hub.listening(), port: hub.port() || port, urls: hub.listening() ? lanAddresses(hub.port()) : [], screens_connected: hub.clientCount(), error }),
    // Waits for a check in progress (it may be opening the port) before closing, so nothing is left listening.
    stop: async () => { stopped = true; clearInterval(timer); await chain; await hub.close(); },
  };
}

module.exports = { createHubServer, createLan, lanAddresses, PORT, COOKIE };
