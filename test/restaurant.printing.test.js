// Kitchen tickets on paper: per-station printers on this PC, confirmed printing, no blind reprints.
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/main/restaurant/engine');
const printing = require('../src/main/restaurant/printing');
const { hub, ID, owner, waiter } = require('./restaurant.helpers');

const jobs = (db) => db.prepare(`SELECT kind, status, station_id, last_error FROM r_print_jobs ORDER BY created_at, rowid`).all().map((r) => ({ ...r }));

function sendOrder(db) {
  const o = engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t1 }, waiter);
  engine.addItems(db, o.id, [{ menu_item_id: ID.jollof, quantity: 2, modifiers: [ID.large, ID.chicken], notes: 'no pepper' },
    { menu_item_id: ID.chapman, quantity: 1 }], waiter);
  return { order: o, sent: engine.sendToKitchen(db, o.id, waiter) };
}

test('each station prints its own ticket on its own printer, apart from the receipt printer', async () => {
  const { db, cleanup } = hub();
  try {
    printing.setStationPrinter(db, ID.kitchen, 'EPSON Kitchen', owner);
    printing.setStationPrinter(db, ID.bar, 'XP-80 Bar', owner);
    assert.throws(() => printing.setStationPrinter(db, ID.bar, 'x', waiter), { code: 'not_allowed' });
    sendOrder(db);
    const printed = [];
    await printing.runQueue(db, async (html, printer) => { printed.push({ printer, html }); return { ok: true }; });
    assert.deepEqual(printed.map((p) => p.printer), ['EPSON Kitchen', 'XP-80 Bar']);
    const kitchen = printed[0].html;
    assert.match(kitchen, /KITCHEN/);
    assert.match(kitchen, /Table T1/);
    assert.match(kitchen, /Jollof rice/);
    assert.match(kitchen, /\+ Large/);
    assert.match(kitchen, /\+ Chicken/);
    assert.match(kitchen, /! no pepper/);
    assert.doesNotMatch(kitchen, /Chapman/, 'the drink is on the bar ticket only');
    assert.doesNotMatch(kitchen, /3500|₦/, 'no prices on kitchen tickets');
    assert.ok(jobs(db).every((j) => j.status === 'printed'));
    assert.equal(db.prepare(`SELECT SUM(print_count) n FROM r_tickets`).get().n, 2);
    assert.equal(db.prepare(`SELECT value FROM app_settings WHERE key = 'receipt_printer'`).get(), undefined, 'the receipt printer setting is untouched');
  } finally { cleanup(); }
});

test('a station with no printer chosen, or a printer that fails, is flagged, never lost', async () => {
  const { db, cleanup } = hub();
  try {
    printing.setStationPrinter(db, ID.kitchen, 'EPSON Kitchen', owner);
    sendOrder(db);
    await printing.runQueue(db, async () => ({ ok: false, reason: 'Out of paper' }));
    assert.deepEqual(jobs(db).map((j) => [j.status, j.last_error]), [['failed', 'Out of paper'], ['no_printer', 'No printer is chosen for this station on this till.']]);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM r_events WHERE type = 'print.failed'`).get().n, 2);
    assert.equal(printing.problems(db).length, 2);
  } finally { cleanup(); }
});

test('after a power cut an unconfirmed job is flagged, not printed twice; a reprint says COPY and is allowed only with permission', async () => {
  const { db, cleanup } = hub();
  try {
    printing.setStationPrinter(db, ID.kitchen, 'EPSON Kitchen', owner);
    printing.setStationPrinter(db, ID.bar, 'XP-80 Bar', owner);
    const { sent } = sendOrder(db);
    assert.equal(printing.recoverAfterRestart(db), 2);
    let calls = 0;
    await printing.runQueue(db, async () => { calls += 1; return { ok: true }; });
    assert.equal(calls, 0, 'nothing printed blindly after the restart');
    assert.ok(jobs(db).every((j) => j.status === 'failed' && /restarted/.test(j.last_error)));

    const kitchenTicket = sent.tickets.find((t) => t.station_id === ID.kitchen).id;
    assert.throws(() => printing.reprint(db, kitchenTicket, waiter), { code: 'not_allowed' });
    printing.reprint(db, kitchenTicket, owner, 'reprint-1');
    printing.reprint(db, kitchenTicket, owner, 'reprint-1'); // a double tap prints once
    const html = [];
    await printing.runQueue(db, async (h) => { html.push(h); return { ok: true }; });
    assert.equal(html.length, 1);
    assert.match(html[0], />COPY</);
  } finally { cleanup(); }
});

test('a void prints a VOID slip with the reason', async () => {
  const { db, cleanup } = hub();
  try {
    printing.setStationPrinter(db, ID.kitchen, 'EPSON Kitchen', owner);
    printing.setStationPrinter(db, ID.bar, 'XP-80 Bar', owner);
    const { order } = sendOrder(db);
    await printing.runQueue(db, async () => ({ ok: true }));
    const jollof = engine.orderView(db, order.id).items.find((i) => i.menu_item_id === ID.jollof);
    engine.voidItem(db, jollof.id, { quantity: 1, reason: 'customer changed mind' }, owner);
    const html = [];
    await printing.runQueue(db, async (h, p) => { html.push([p, h]); return { ok: true }; });
    assert.equal(html.length, 1);
    assert.equal(html[0][0], 'EPSON Kitchen');
    assert.match(html[0][1], />VOID</);
    assert.match(html[0][1], /<span class="qty">1<\/span> <span class="name">Jollof rice/);
    assert.match(html[0][1], /Reason: customer changed mind/);
  } finally { cleanup(); }
});

test('the print queue keeps working after a run that found nothing to print', async () => {
  const { db, cleanup } = hub();
  try {
    printing.setStationPrinter(db, ID.kitchen, 'EPSON Kitchen', owner);
    printing.setStationPrinter(db, ID.bar, 'XP-80 Bar', owner);
    await printing.runQueue(db, async () => ({ ok: true })); // empty queue
    sendOrder(db);
    let n = 0;
    await printing.runQueue(db, async () => { n += 1; return { ok: true }; });
    assert.equal(n, 2);
  } finally { cleanup(); }
});
