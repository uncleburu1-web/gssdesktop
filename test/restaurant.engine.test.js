/*
 * The restaurant order engine on the hub (transitions T1–T13, gss docs/restaurant/ORDER_LIFECYCLE.md).
 * Configuration is loaded exactly as a pull from the cloud would deliver it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dbm } = require('./helpers');
const engine = require('../src/main/restaurant/engine');
const store = require('../src/main/restaurant/store');

const { hub, ID, owner, waiter, cashier, kitchenScreen } = require('./restaurant.helpers');

const queued = (db, type) => db.prepare(`SELECT * FROM sync_queue WHERE entity_type = ?`).all(type);
const events = (db, type) => db.prepare(`SELECT * FROM r_events WHERE type = ?`).all(type);
const largeJollof = (n = 1, extra = []) => ({ menu_item_id: ID.jollof, quantity: n, modifiers: [ID.large, ...extra] });

function cook(db, order, ctx = owner) {
  for (const i of engine.orderView(db, order.id).items) {
    for (const t of i.tickets) {
      if (t.state === 'queued') engine.setTicketItemState(db, t.ticket_item_id, { to: 'ready' }, ctx);
    }
  }
}

test('table service, start to finish: open, order, kitchen, serve, bill, pay, close, upload once', () => {
  const { db, cleanup } = hub();
  try {
    dbm.openShift(db, 'chi', 5000);
    const o = engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t1, guests: 3 }, waiter);
    assert.equal(o.number, 'K-0001');
    assert.equal(engine.tablesView(db).find((t) => t.id === ID.t1).status, 'occupied');

    engine.addItems(db, o.id, [largeJollof(2, [ID.chicken]), { menu_item_id: ID.chapman, quantity: 2 }, { menu_item_id: ID.bottled }], waiter);
    const sent = engine.sendToKitchen(db, o.id, waiter);
    assert.deepEqual(sent.tickets.map((t) => [t.station_name, t.number, t.items.length]), [['Kitchen', 'K-1', 1], ['Bar', 'B-1', 1]]);
    assert.equal(sent.unrouted.length, 1, 'bottled water needs no kitchen');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM r_print_jobs WHERE status = 'queued'`).get().n, 2, 'both stations print');

    // The kitchen screen works its station only.
    const screenTickets = engine.kitchenView(db, kitchenScreen.stationIds);
    assert.equal(screenTickets.length, 1);
    const ti = screenTickets[0].items[0];
    assert.deepEqual(ti.modifiers.sort(), ['Chicken', 'Large']);
    engine.setTicketItemState(db, ti.id, { to: 'preparing', version: ti.version }, kitchenScreen);
    engine.setTicketItemState(db, ti.id, { to: 'ready', version: ti.version + 1 }, kitchenScreen);
    const bar = engine.orderView(db, o.id).items.find((i) => i.menu_item_id === ID.chapman).tickets[0];
    assert.throws(() => engine.setTicketItemState(db, bar.ticket_item_id, { to: 'ready' }, kitchenScreen), { code: 'not_your_station' });
    engine.setTicketItemState(db, bar.ticket_item_id, { to: 'ready' }, owner);
    assert.equal(events(db, 'order.ready').length, 1, 'the waiter is told once everything is ready');
    for (const item of engine.orderView(db, o.id).items) engine.serveItem(db, item.id, waiter);
    assert.equal(engine.orderView(db, o.id).kitchen_status, 'served');

    // Bill: (3500 + 500 + 1000) x 2 + 1500 x 2 + 300 = 13,300; service 10% = 1,330; VAT 7.5% of 13,300 = 997.50
    const billed = engine.printBill(db, o.id, cashier);
    assert.deepEqual([billed.bill.subtotal, billed.bill.total], ['13300.00', '15627.50']);
    assert.equal(engine.tablesView(db).find((t) => t.id === ID.t1).status, 'billing');

    const part = engine.takePayment(db, o.id, { method: 'transfer', amount: '5000' }, cashier);
    assert.equal(part.order.payment_status, 'partly_paid');
    const rest = engine.takePayment(db, o.id, { method: 'cash', tendered: '11000', tip: '200' }, cashier);
    assert.equal(rest.change, '172.50', '11,000 handed for 10,627.50 + 200 tip');
    const done = engine.orderView(db, o.id);
    assert.equal(done.status, 'closed');
    assert.equal(engine.tablesView(db).find((t) => t.id === ID.t1).status, 'free');

    const docs = queued(db, 'order_doc');
    assert.equal(docs.length, 1, 'uploaded once');
    const doc = JSON.parse(docs[0].payload);
    assert.equal(doc.bill.total, '15627.50');
    assert.equal(doc.bill.payments.length, 2);
    assert.equal(doc.tickets.length, 2);
  } finally { cleanup(); }
});

test('counter service uses the same engine: pay first, then the kitchen', () => {
  const { db, cleanup } = hub();
  try {
    dbm.openShift(db, 'chi', 0);
    const o = engine.openOrder(db, { service_type: 'counter' }, cashier);
    engine.addItems(db, o.id, [{ menu_item_id: ID.jollof, modifiers: [ID.regular] }], cashier);
    engine.takePayment(db, o.id, { method: 'cash', tendered: '5000' }, cashier); // 3,500 + VAT 262.50, no service at the counter
    let v = engine.orderView(db, o.id);
    assert.equal(v.bill.total, '3762.50');
    assert.equal(v.status, 'open', 'paid, but not yet made');
    engine.sendToKitchen(db, o.id, cashier);
    cook(db, o);
    engine.serveItem(db, v.items[0].id, cashier);
    v = engine.orderView(db, o.id);
    assert.equal(v.status, 'closed');
  } finally { cleanup(); }
});

test('items added after paying reopen the bill; the order does not close on a stale total', () => {
  const { db, cleanup } = hub();
  try {
    dbm.openShift(db, 'chi', 0);
    const o = engine.openOrder(db, { service_type: 'counter' }, cashier);
    engine.addItems(db, o.id, [{ menu_item_id: ID.chapman }], cashier);
    engine.takePayment(db, o.id, { method: 'transfer' }, cashier);
    engine.addItems(db, o.id, [{ menu_item_id: ID.bottled }], cashier);
    engine.sendToKitchen(db, o.id, cashier);
    cook(db, o);
    for (const i of engine.orderView(db, o.id).items) engine.serveItem(db, i.id, cashier);
    const v = engine.orderView(db, o.id);
    assert.equal(v.status, 'open', 'the water is not paid for yet');
    assert.equal(v.bill.status, 'open');
    engine.takePayment(db, o.id, { method: 'transfer' }, cashier);
    assert.equal(engine.orderView(db, o.id).status, 'closed');
  } finally { cleanup(); }
});

test('one open order per table; moving needs a free table', () => {
  const { db, cleanup } = hub();
  try {
    const a = engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t1 }, waiter);
    assert.throws(() => engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t1 }, waiter), { code: 'table_occupied' });
    const b = engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t2 }, waiter);
    assert.throws(() => engine.moveTable(db, a.id, ID.t2, waiter), { code: 'table_occupied' });
    engine.cancelOrder(db, b.id, { reason: 'left' }, waiter);
    engine.moveTable(db, a.id, ID.t2, waiter);
    assert.equal(engine.tablesView(db).find((t) => t.id === ID.t1).status, 'free');
    assert.throws(() => engine.openOrder(db, { service_type: 'takeaway', table_id: ID.t1 }, waiter), { code: 'table_not_allowed' });
  } finally { cleanup(); }
});

test('menu rules: modifiers, sold out, unknown items', () => {
  const { db, cleanup } = hub();
  try {
    const o = engine.openOrder(db, { service_type: 'takeaway' }, waiter);
    assert.throws(() => engine.addItems(db, o.id, [{ menu_item_id: ID.jollof }], waiter), { code: 'modifier_rules' }, 'size is required');
    assert.throws(() => engine.addItems(db, o.id, [largeJollof(1, [ID.regular])], waiter), { code: 'modifier_rules' }, 'one size only');
    assert.throws(() => engine.addItems(db, o.id, [largeJollof(1, [ID.plantain])], waiter), { code: 'modifier_unavailable' });
    assert.throws(() => engine.addItems(db, o.id, [{ menu_item_id: ID.chapman, modifiers: [ID.large] }], waiter), { code: 'bad_modifier' });
    assert.throws(() => engine.addItems(db, o.id, [{ menu_item_id: 'nope' }], waiter), { code: 'unknown_menu_item' });
    assert.throws(() => engine.addItems(db, o.id, [{ menu_item_id: ID.chapman, quantity: 1.5 }], waiter), { code: 'bad_quantity' });
    assert.throws(() => engine.setSoldOut(db, ID.chapman, true, waiter), { code: 'not_allowed' });
    engine.setSoldOut(db, ID.chapman, true, { ...cashier, capabilities: { ...cashier.capabilities, mark_sold_out: true } });
    assert.throws(() => engine.addItems(db, o.id, [{ menu_item_id: ID.chapman }], waiter), { code: 'sold_out' });
    engine.setSoldOut(db, ID.chapman, false, owner);
    engine.addItems(db, o.id, [{ menu_item_id: ID.chapman }], waiter);
    assert.equal(queued(db, 'menu_availability').length, 2);
  } finally { cleanup(); }
});

test('an item at an inactive station falls back to its category; pending items change freely, sent ones do not', () => {
  const { db, cleanup } = hub();
  try {
    const o = engine.openOrder(db, { service_type: 'takeaway' }, waiter);
    const v = engine.addItems(db, o.id, [{ menu_item_id: ID.suya, quantity: 2 }], waiter);
    engine.changePendingItem(db, v.items[0].id, { quantity: 3, notes: 'extra pepper' }, waiter);
    const sent = engine.sendToKitchen(db, o.id, waiter);
    assert.equal(sent.tickets[0].station_name, 'Kitchen', 'the grill is off, so suya goes to its category station');
    assert.throws(() => engine.changePendingItem(db, v.items[0].id, { quantity: 1 }, waiter), { code: 'already_sent' });
    assert.throws(() => engine.removePendingItem(db, v.items[0].id, waiter), { code: 'already_sent' });
  } finally { cleanup(); }
});

test('a retried send never creates a second set of tickets', () => {
  const { db, cleanup } = hub();
  try {
    const o = engine.openOrder(db, { service_type: 'takeaway' }, waiter);
    engine.addItems(db, o.id, [largeJollof(1), { menu_item_id: ID.chapman }], waiter);
    const first = engine.sendToKitchen(db, o.id, waiter, 'send-key-1');
    const retry = engine.sendToKitchen(db, o.id, waiter, 'send-key-1');
    assert.deepEqual(retry.tickets, first.tickets, 'same key -> same answer');
    const again = engine.sendToKitchen(db, o.id, waiter);
    assert.equal(again.tickets.length, 0, 'no key, nothing pending -> nothing new');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM r_tickets`).get().n, 2);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM r_print_jobs`).get().n, 2);
    assert.throws(() => engine.sendToKitchen(db, 'other-order', waiter, 'send-key-1'), { code: 'key_reused' });
  } finally { cleanup(); }
});

test('two people act on the same kitchen item: exactly one wins', () => {
  const { db, cleanup } = hub();
  try {
    const o = engine.openOrder(db, { service_type: 'takeaway' }, waiter);
    engine.addItems(db, o.id, [largeJollof(1)], waiter);
    engine.sendToKitchen(db, o.id, waiter);
    const ti = engine.kitchenView(db, [ID.kitchen])[0].items[0];
    engine.setTicketItemState(db, ti.id, { to: 'preparing', version: ti.version }, kitchenScreen);
    assert.throws(() => engine.setTicketItemState(db, ti.id, { to: 'ready', version: ti.version }, kitchenScreen),
      (e) => e.code === 'version_mismatch' && e.current.state === 'preparing');
    assert.throws(() => engine.setTicketItemState(db, ti.id, { to: 'queued' }, kitchenScreen), { code: 'bad_transition' });
    const same = engine.setTicketItemState(db, ti.id, { to: 'preparing', version: 1 }, kitchenScreen);
    assert.equal(same.changed, false, 'asking for the state it already has is a harmless success');
  } finally { cleanup(); }
});

test('voids: reason, permission, waste once cooking started, VOID slip, bill never below paid', () => {
  const { db, cleanup } = hub();
  try {
    dbm.openShift(db, 'chi', 0);
    const voider = { ...cashier, capabilities: { ...cashier.capabilities, void_sent_item: true } };
    const o = engine.openOrder(db, { service_type: 'takeaway' }, cashier);
    const v = engine.addItems(db, o.id, [largeJollof(3), { menu_item_id: ID.chapman, quantity: 1 }], cashier);
    engine.sendToKitchen(db, o.id, cashier);
    const jollof = v.items[0].id;
    assert.throws(() => engine.voidItem(db, jollof, { quantity: 1, reason: 'x' }, cashier), { code: 'not_allowed' });
    assert.throws(() => engine.voidItem(db, jollof, { quantity: 1 }, voider), { code: 'reason_required' });
    let r = engine.voidItem(db, jollof, { quantity: 1, reason: 'customer changed mind' }, voider);
    let item = r.items.find((i) => i.id === jollof);
    assert.deepEqual([item.voided_quantity, item.waste, item.state], [1, 0, 'sent'], 'not started: not waste');
    const ti = engine.kitchenView(db, [ID.kitchen])[0].items[0];
    engine.setTicketItemState(db, ti.id, { to: 'preparing' }, kitchenScreen);
    r = engine.voidItem(db, jollof, { quantity: 1, reason: 'dropped' }, voider);
    item = r.items.find((i) => i.id === jollof);
    assert.deepEqual([item.voided_quantity, item.waste], [2, 1], 'cooking had started: waste');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM r_tickets WHERE kind = 'void'`).get().n, 2, 'a VOID slip each time');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM r_print_jobs WHERE kind = 'void'`).get().n, 2);
    assert.ok(queued(db, 'audit_event').some((q) => JSON.parse(q.payload).action === 'restaurant.item_voided'));

    // Pay everything (1 jollof 4,000 + chapman 1,500 = 5,500 + VAT 412.50), then try to void below what was paid.
    engine.takePayment(db, o.id, { method: 'transfer' }, cashier);
    assert.equal(engine.orderView(db, o.id).bill.total, '5912.50');
    assert.throws(() => engine.voidItem(db, jollof, { quantity: 1, reason: 'oops' }, voider), { code: 'below_paid' });
    assert.equal(engine.orderView(db, o.id).items.find((i) => i.id === jollof).voided_quantity, 2, 'the refused void left nothing behind');
  } finally { cleanup(); }
});

test('discounts need permission and a reason, and never go below what was paid', () => {
  const { db, cleanup } = hub();
  try {
    const manager = { ...cashier, capabilities: { ...cashier.capabilities, apply_discount: true } };
    const o = engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t1 }, cashier);
    engine.addItems(db, o.id, [{ menu_item_id: ID.chapman, quantity: 4 }], cashier); // 6,000
    assert.throws(() => engine.applyDiscount(db, o.id, { type: 'percent', value: 10, reason: 'x' }, cashier), { code: 'not_allowed' });
    assert.throws(() => engine.applyDiscount(db, o.id, { type: 'percent', value: 10 }, manager), { code: 'reason_required' });
    let v = engine.applyDiscount(db, o.id, { type: 'percent', value: 10, reason: 'regular customer' }, manager);
    assert.deepEqual([v.bill.discount, v.bill.net, v.bill.total], ['600.00', '5400.00', '6345.00']); // + service 540 + VAT 405
    engine.takePayment(db, o.id, { method: 'transfer', amount: '6000' }, cashier);
    assert.throws(() => engine.applyDiscount(db, o.id, { type: 'amount', value: 1000, reason: 'more' }, manager), { code: 'below_paid' });
    v = engine.orderView(db, o.id);
    assert.equal(v.bill.discount, '600.00');
  } finally { cleanup(); }
});

test('payment rules: methods, overpaying, cash needs a shift, served-before-payment with override', () => {
  const { db, cleanup } = hub({ servedRule: true });
  try {
    const o = engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t1 }, cashier);
    engine.addItems(db, o.id, [{ menu_item_id: ID.chapman }], cashier);
    engine.sendToKitchen(db, o.id, cashier);
    assert.throws(() => engine.takePayment(db, o.id, { method: 'cheque' }, cashier), { code: 'bad_method' });
    assert.throws(() => engine.takePayment(db, o.id, { method: 'transfer' }, cashier), { code: 'not_served' });
    const boss = { ...cashier, capabilities: { ...cashier.capabilities, override_served_rule: true } };
    assert.throws(() => engine.takePayment(db, o.id, { method: 'transfer', amount: '99999' }, boss), { code: 'payment_exceeds_balance' });
    assert.throws(() => engine.takePayment(db, o.id, { method: 'cash', override: true }, boss), { code: 'no_open_shift' });
    const paid = engine.takePayment(db, o.id, { method: 'transfer', override: true }, boss);
    assert.equal(paid.order.payment_status, 'paid');
    assert.ok(queued(db, 'audit_event').some((q) => JSON.parse(q.payload).action === 'restaurant.payment_override'));
    const pay = db.prepare(`SELECT * FROM r_payments`).get();
    assert.equal(pay.override_by, 'chi');
  } finally { cleanup(); }
});

test('a retried payment is taken once', () => {
  const { db, cleanup } = hub();
  try {
    const o = engine.openOrder(db, { service_type: 'takeaway' }, cashier);
    engine.addItems(db, o.id, [{ menu_item_id: ID.chapman, quantity: 2 }], cashier);
    const a = engine.takePayment(db, o.id, { method: 'transfer', amount: '1000' }, cashier, 'pay-1');
    const b = engine.takePayment(db, o.id, { method: 'transfer', amount: '1000' }, cashier, 'pay-1');
    assert.equal(a.payment_id, b.payment_id);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM r_payments`).get().n, 1);
  } finally { cleanup(); }
});

test('cancelling: reason, manager once sent, never with payments, kitchen told, uploaded', () => {
  const { db, cleanup } = hub();
  try {
    const o = engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t1 }, waiter);
    engine.addItems(db, o.id, [largeJollof(1)], waiter);
    engine.sendToKitchen(db, o.id, waiter);
    assert.throws(() => engine.cancelOrder(db, o.id, { reason: 'left' }, waiter), { code: 'not_allowed' });
    const manager = { ...waiter, capabilities: { ...waiter.capabilities, cancel_order: true } };
    assert.throws(() => engine.cancelOrder(db, o.id, {}, manager), { code: 'reason_required' });
    const v = engine.cancelOrder(db, o.id, { reason: 'customer left' }, manager);
    assert.equal(v.status, 'cancelled');
    assert.equal(engine.kitchenView(db, [ID.kitchen]).length, 0, 'gone from the kitchen screen');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM r_print_jobs WHERE kind = 'void'`).get().n, 1);
    assert.equal(engine.tablesView(db).find((t) => t.id === ID.t1).status, 'free');
    assert.equal(queued(db, 'order_doc').length, 1);

    const p = engine.openOrder(db, { service_type: 'takeaway' }, cashier);
    engine.addItems(db, p.id, [{ menu_item_id: ID.chapman }], cashier);
    engine.takePayment(db, p.id, { method: 'transfer', amount: '100' }, cashier);
    assert.throws(() => engine.cancelOrder(db, p.id, { reason: 'x' }, owner), { code: 'has_payments' });
  } finally { cleanup(); }
});

test('an older cloud cannot take orders yet: they wait on the hub and go up once it upgrades', () => {
  const { db, cleanup } = hub({ protocol: 5 });
  try {
    const o = engine.openOrder(db, { service_type: 'takeaway' }, cashier);
    engine.addItems(db, o.id, [{ menu_item_id: ID.bottled }], cashier);
    engine.sendToKitchen(db, o.id, cashier);
    engine.serveItem(db, engine.orderView(db, o.id).items[0].id, cashier);
    engine.takePayment(db, o.id, { method: 'transfer' }, cashier);
    assert.equal(engine.orderView(db, o.id).status, 'closed');
    assert.equal(queued(db, 'order_doc').length, 0);
    dbm.setSetting(db, 'cloud_sync_protocol', '6');
    assert.equal(engine.reconcileOrders(db), 1);
    assert.equal(engine.reconcileOrders(db), 0, 'never twice');
  } finally { cleanup(); }
});

test('an older cloud is never sent restaurant audit entries it would refuse; they go up once it upgrades', () => {
  // Today's cloud (protocol 5) accepts only three till audit actions; anything else would sit in the
  // outbox as a failed upload for ever.
  const { db, cleanup } = hub({ protocol: 5 });
  try {
    dbm.setSetting(db, 'user_profile', JSON.stringify({ username: 'ada' }));
    const o = engine.openOrder(db, { service_type: 'dine_in', table_id: ID.t1 }, owner);
    engine.addItems(db, o.id, [{ menu_item_id: ID.chapman, quantity: 2 }], owner);
    engine.sendToKitchen(db, o.id, owner);
    engine.voidItem(db, engine.orderView(db, o.id).items[0].id, { quantity: 1, reason: 'Customer changed mind' }, owner);
    engine.moveTable(db, o.id, ID.t2, owner);
    engine.setSoldOut(db, ID.jollof, true, owner);
    assert.equal(queued(db, 'audit_event').length, 0, 'nothing queued for a cloud that cannot take it');
    const kept = db.prepare(`SELECT action, actor FROM r_audit ORDER BY created_at, rowid`).all().map((r) => ({ ...r }));
    assert.deepEqual(kept.map((r) => r.action), ['restaurant.item_voided', 'restaurant.table_moved', 'restaurant.sold_out']);
    assert.ok(kept.every((r) => r.actor === 'ada'), 'who did it is kept for later');

    dbm.setSetting(db, 'cloud_sync_protocol', '6');
    assert.equal(engine.reconcileOrders(db), 3, 'the open order stays; the three audit entries go up');
    const up = queued(db, 'audit_event').map((q) => JSON.parse(q.payload));
    assert.deepEqual(up.map((p) => [p.action, p.actor]), kept.map((r) => [r.action, r.actor]));
    assert.equal(engine.reconcileOrders(db), 0, 'never twice');
    engine.moveTable(db, o.id, ID.t1, owner);
    assert.equal(queued(db, 'audit_event').length, 4, 'from protocol 6 on, straight away');
  } finally { cleanup(); }
});

test('a hub restart mid-order loses nothing and the screens can catch up', () => {
  const { db, file, cleanup } = hub();
  db.close();
  try {
    let h = dbm.openDb(file);
    const o = engine.openOrder(h, { service_type: 'dine_in', table_id: ID.t1 }, waiter);
    engine.addItems(h, o.id, [largeJollof(2)], waiter);
    engine.sendToKitchen(h, o.id, waiter);
    const seenBefore = store.eventsAfter(h, 0, [ID.kitchen]).length;
    h.close(); // power cut

    h = dbm.openDb(file);
    const v = engine.orderView(h, o.id);
    assert.equal(v.status, 'open');
    assert.equal(v.items[0].state, 'sent');
    assert.equal(engine.kitchenView(h, [ID.kitchen]).length, 1, 'the ticket is still on the kitchen screen');
    const replay = store.eventsAfter(h, 0, [ID.kitchen]);
    assert.equal(replay.length, seenBefore, 'a screen reconnecting from 0 gets the same events');
    assert.ok(replay.every((e) => e.station_ids.includes(ID.kitchen)), 'and only its own station');
    h.close();
  } finally { cleanup(); }
});

test('business day: orders after midnight but before 05:00 belong to the previous day', () => {
  const { db, cleanup } = hub();
  try {
    assert.equal(store.businessDate(db, new Date('2026-10-21T23:30:00Z')), '2026-10-21'); // 00:30 Lagos -> still the 21st
    assert.equal(store.businessDate(db, new Date('2026-10-22T04:30:00Z')), '2026-10-22'); // 05:30 Lagos -> the 22nd
    assert.equal(store.businessDate(db, new Date('2026-10-21T10:00:00Z')), '2026-10-21');
  } finally { cleanup(); }
});

test("restaurant takings and cash tips are in the cashier's Z-report; a supermarket report is unchanged", () => {
  const { db, cleanup } = hub();
  try {
    dbm.openShift(db, 'chi', 1000);
    const before = dbm.getShiftReport(db, dbm.getOpenShift(db, 'chi').id);
    assert.equal(before.restaurant, undefined, 'no restaurant payments, no restaurant section');
    const o = engine.openOrder(db, { service_type: 'takeaway' }, cashier);
    engine.addItems(db, o.id, [{ menu_item_id: ID.chapman, quantity: 2 }], cashier); // 3,000 + VAT 225 = 3,225
    engine.takePayment(db, o.id, { method: 'transfer', amount: '1225' }, cashier);
    engine.takePayment(db, o.id, { method: 'cash', tendered: '2500', tip: '300' }, cashier); // 2,000 + 300 tip, change 200
    const z = dbm.getShiftReport(db, dbm.getOpenShift(db, 'chi').id);
    assert.equal(z.payments.by_method.cash, 2000);
    assert.equal(z.payments.by_method.transfer, 1225);
    assert.deepEqual(z.restaurant, { payments: 2, takings: 3225, tips: 300 });
    assert.equal(z.cash.expected, 1000 + 2000 + 300, 'float + cash takings + cash tip');
  } finally { cleanup(); }
});
