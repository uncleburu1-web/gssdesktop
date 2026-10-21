/*
 * Kitchen ticket printing on the hub (gss docs/restaurant/KITCHEN_WORKFLOW.md §2).
 *
 *  - Each station's printer is chosen ON THIS PC (app_settings 'station_printer:<id>'), separately
 *    from the customer receipt printer (owner's decision 5). Never synced: a Windows printer name
 *    only means something on the PC it is installed on.
 *  - Sending to the kitchen queues a job per printing station (engine.js). runQueue() prints them
 *    through the same silent printing receipts use (main.js passes `printHtml`).
 *  - A job is marked printed only when Windows confirms it. After a crash or power cut a job left
 *    unconfirmed is NOT printed again blindly (that could duplicate a ticket); it is marked
 *    "not confirmed" so the hub shows a reprint button.
 *  - A reprint needs the reprint_ticket capability, says COPY and is audited.
 */
const store = require('./store');

const { RestaurantError, uuid, nowIso } = store;
const tillDb = () => require('../db');
const KEY = (stationId) => `station_printer:${stationId}`;

function stationPrinter(db, stationId) {
  return tillDb().getSetting(db, KEY(stationId)) || '';
}

function setStationPrinter(db, stationId, deviceName, ctx) {
  if (!(ctx && ctx.isOwner)) throw new RestaurantError('not_allowed', 'Only an owner or manager sets up printers.', 403);
  if (!store.station(db, stationId)) throw new RestaurantError('unknown_station', 'Station not found.', 404);
  tillDb().setSetting(db, KEY(stationId), String(deviceName || ''));
  return listStationPrinters(db);
}

function listStationPrinters(db) {
  return db.prepare(`SELECT id, name, prints, is_active FROM r_stations WHERE is_deleted = 0 ORDER BY sort, name`).all()
    .map((s) => ({ station_id: s.id, station: s.name, prints: Boolean(s.prints), active: Boolean(s.is_active), printer: stationPrinter(db, s.id) }));
}

/** What goes on the paper: big type, no prices. */
function ticketDocument(db, ticketId, kind = 'ticket') {
  const t = db.prepare(
    `SELECT t.*, s.name AS station_name, o.number AS order_number, o.service_type, o.waiter, rt.label AS table_label
     FROM r_tickets t JOIN r_stations s ON s.id = t.station_id JOIN r_orders o ON o.id = t.order_id
     LEFT JOIN r_tables rt ON rt.id = o.table_id WHERE t.id = ?`
  ).get(ticketId);
  if (!t) throw new RestaurantError('not_found', 'Ticket not found.', 404);
  const lines = db.prepare(
    `SELECT ti.quantity, ti.voided_quantity, oi.id AS order_item_id, oi.name, oi.notes, oi.void_reason
     FROM r_ticket_items ti JOIN r_order_items oi ON oi.id = ti.order_item_id WHERE ti.ticket_id = ? ORDER BY ti.rowid`
  ).all(ticketId).map((l) => ({
    quantity: t.kind === 'void' ? l.voided_quantity : l.quantity,
    name: l.name,
    modifiers: db.prepare(`SELECT name FROM r_order_item_modifiers WHERE order_item_id = ? ORDER BY rowid`).all(l.order_item_id).map((m) => m.name),
    notes: l.notes || '',
    reason: t.kind === 'void' ? (l.void_reason || '') : '',
  }));
  const where = t.table_label ? `Table ${t.table_label}` : t.service_type === 'takeaway' ? 'TAKEAWAY' : 'COUNTER';
  const banner = kind === 'copy' ? 'COPY' : t.kind === 'void' ? 'VOID' : 'NEW';
  return {
    station: t.station_name.toUpperCase(), number: t.number, time: new Date(t.sent_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }),
    where, order: t.order_number, waiter: t.waiter || '', lines, banner,
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderTicketHtml(doc) {
  const items = doc.lines.map((l) => `
    <div class="line"><span class="qty">${esc(l.quantity)}</span> <span class="name">${esc(l.name)}</span></div>
    ${l.modifiers.map((m) => `<div class="mod">+ ${esc(m)}</div>`).join('')}
    ${l.notes ? `<div class="note">! ${esc(l.notes)}</div>` : ''}
    ${l.reason ? `<div class="note">Reason: ${esc(l.reason)}</div>` : ''}`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 2mm; } body { font-family: Arial, sans-serif; width: 72mm; margin: 0; color: #000; }
    .head { display: flex; justify-content: space-between; font-weight: 700; font-size: 16px; }
    .sub { font-size: 13px; margin: 2px 0 6px; } hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
    .line { font-size: 20px; font-weight: 700; margin-top: 4px; } .qty { display: inline-block; min-width: 26px; }
    .mod { font-size: 15px; margin-left: 30px; } .note { font-size: 15px; margin-left: 30px; font-style: italic; }
    .banner { text-align: center; font-size: 26px; font-weight: 800; margin-top: 6px; }
  </style></head><body>
    <div class="head"><span>${esc(doc.station)}</span><span>${esc(doc.number)}</span><span>${esc(doc.time)}</span></div>
    <div class="sub">${esc(doc.where)} · Order ${esc(doc.order)}${doc.waiter ? ` · ${esc(doc.waiter)}` : ''}</div>
    <hr>${items}<hr><div class="banner">${esc(doc.banner)}</div>
  </body></html>`;
}

/**
 * Print every queued job, oldest first, one at a time. `printHtml(html, deviceName)` resolves to
 * { ok, reason }. Single-flight: overlapping calls share one run.
 */
let running = null;
let again = false;
function runQueue(db, printHtml) {
  // Single-flight, and nothing is ever left behind: a job queued while a run is finishing sets
  // `again`, so the run goes round once more (or a new run starts right after) instead of the job
  // waiting for the next action on the till.
  if (running) { again = true; return running; }
  running = (async () => {
    do { again = false; await drain(db, printHtml); } while (again);
  })().finally(() => {
    running = null;
    if (again) runQueue(db, printHtml);
  });
  return running;
}

async function drain(db, printHtml) {
  for (;;) {
    const job = db.prepare(`SELECT * FROM r_print_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1`).get();
    if (!job) return;
    const printer = stationPrinter(db, job.station_id);
    if (!printer) {
      finish(db, job, 'no_printer', 'No printer is chosen for this station on this till.');
      continue;
    }
    let result;
    try {
      result = await printHtml(renderTicketHtml(ticketDocument(db, job.ticket_id, job.kind)), printer);
    } catch (e) {
      result = { ok: false, reason: e.message };
    }
    finish(db, job, result && result.ok ? 'printed' : 'failed', result && result.ok ? null : (result && result.reason) || 'The printer did not confirm.');
  }
}

function finish(db, job, status, error) {
  db.transaction(() => {
    db.prepare(`UPDATE r_print_jobs SET status = ?, attempts = attempts + 1, last_error = ?, printed_at = ? WHERE id = ?`)
      .run(status, error, status === 'printed' ? nowIso() : null, job.id);
    if (status === 'printed') db.prepare(`UPDATE r_tickets SET print_count = print_count + 1 WHERE id = ?`).run(job.ticket_id);
    else store.emit(db, 'print.failed', { stationIds: [job.station_id], entityType: 'print_job', entityId: job.id, data: { ticket_id: job.ticket_id, reason: error } });
  })();
}

/** On start-up: jobs that were printing when the till stopped are unknown. Flag them; never reprint blindly. */
function recoverAfterRestart(db) {
  return db.prepare(`UPDATE r_print_jobs SET status = 'failed', last_error = ? WHERE status = 'queued'`)
    .run('Not confirmed before the till restarted. Reprint if the kitchen did not get it.').changes;
}

/** Print again: a failed job (same ticket, same kind), or a COPY of any ticket (needs reprint_ticket). */
function reprint(db, ticketId, ctx, key) {
  return db.transaction(() => store.onceForKey(db, key, 'reprint', { ticketId }, () => {
    if (!(ctx && (ctx.isOwner || (ctx.capabilities && ctx.capabilities.reprint_ticket)))) {
      throw new RestaurantError('not_allowed', 'You are not allowed to reprint tickets.', 403);
    }
    const t = db.prepare(`SELECT t.*, o.number AS order_number FROM r_tickets t JOIN r_orders o ON o.id = t.order_id WHERE t.id = ?`).get(ticketId);
    if (!t) throw new RestaurantError('not_found', 'Ticket not found.', 404);
    const id = uuid();
    db.prepare(`INSERT INTO r_print_jobs (id, ticket_id, station_id, kind, status, created_at, requested_by) VALUES (?, ?, ?, 'copy', 'queued', ?, ?)`)
      .run(id, ticketId, t.station_id, nowIso(), ctx.user);
    store.audit(db, 'restaurant.ticket_reprinted', { summary: `Ticket ${t.number} (order ${t.order_number}) reprinted`, data: { ticket_id: ticketId } });
    return { job_id: id };
  }))();
}

function problems(db) {
  return db.prepare(
    `SELECT j.*, t.number AS ticket_number, s.name AS station FROM r_print_jobs j JOIN r_tickets t ON t.id = j.ticket_id
     JOIN r_stations s ON s.id = j.station_id WHERE j.status IN ('failed', 'no_printer') ORDER BY j.created_at DESC LIMIT 50`
  ).all();
}

module.exports = { stationPrinter, setStationPrinter, listStationPrinters, ticketDocument, renderTicketHtml, runQueue, recoverAfterRestart, reprint, problems };
