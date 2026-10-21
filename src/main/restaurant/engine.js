/*
 * The restaurant order engine on the hub: transitions T1–T13 of gss docs/restaurant/ORDER_LIFECYCLE.md.
 *
 * Every public function runs in ONE SQLite transaction that writes the change, its audit entry, its
 * event for kitchen screens (r_events) and, when an order finishes, its upload to the cloud. Either
 * all of it commits or none of it does. Every change accepts an idempotency key: a retried request
 * returns the first answer and changes nothing (no duplicate tickets, payments or orders).
 *
 * `ctx` says who is acting: { user, role, isOwner, capabilities, isScreen, stationIds }. Permissions are
 * checked here as well as in the UI, so a screen can never do more than the person using it may.
 */
const store = require('./store');
const { stationFor, route } = require('./routing');
const billing = require('./billing');

const { RestaurantError, uuid, nowIso } = store;
const SERVICE_TYPES = ['dine_in', 'takeaway', 'counter'];

// Lazily required: db.js requires this folder, so a top-level require would be circular.
const tillDb = () => require('../db');

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
function can(ctx, capability) {
  return Boolean(ctx && (ctx.isOwner || (ctx.capabilities && ctx.capabilities[capability])));
}

function need(ctx, capability) {
  if (!can(ctx, capability)) throw new RestaurantError('not_allowed', 'You are not allowed to do that.', 403, { capability });
}

function audit(db, action, summary, reason = '', data = {}) {
  store.audit(db, action, { summary, reason, data }); // kept on the hub; uploaded from protocol 6
}

function getOrderRow(db, orderId) {
  if (typeof orderId !== 'string' || !orderId) throw new RestaurantError('not_found', 'Order not found.', 404);
  const order = db.prepare(`SELECT * FROM r_orders WHERE id = ?`).get(orderId);
  if (!order) throw new RestaurantError('not_found', 'Order not found.', 404);
  return order;
}

function openOrderRow(db, orderId) {
  const order = getOrderRow(db, orderId);
  if (order.status !== 'open') throw new RestaurantError('order_not_open', `This order is ${order.status}.`, 409);
  return order;
}

const items = (db, orderId) => db.prepare(`SELECT * FROM r_order_items WHERE order_id = ? ORDER BY sort, created_at`).all(orderId);
const ticketItemsOf = (db, orderItemId) => db.prepare(
  `SELECT ti.*, t.station_id, t.kind FROM r_ticket_items ti JOIN r_tickets t ON t.id = ti.ticket_id
   WHERE ti.order_item_id = ? AND t.kind = 'new' ORDER BY t.sent_at DESC, ti.rowid DESC`).all(orderItemId);
const billOf = (db, orderId) => db.prepare(`SELECT * FROM r_bills WHERE order_id = ?`).get(orderId);
const paidOn = (db, billId) => db.prepare(`SELECT amount FROM r_payments WHERE bill_id = ?`).all(billId)
  .reduce((acc, p) => billing.addMoney(acc, p.amount), '0.00');
const remaining = (item) => item.quantity - item.voided_quantity;

function tx(db, key, op, request, fn) {
  return db.transaction(() => store.onceForKey(db, key, op, request, fn))();
}

// ---------------------------------------------------------------------------------------------
// The bill (used by T6, T8, T9, T10)
// ---------------------------------------------------------------------------------------------
/**
 * What the order's bills are worked out with: the service charge and the tax rules in force when the
 * order was opened (copied onto the order, like item prices). A rate changed or a tax switched on in
 * the cloud during service applies to the NEXT orders, never to this one.
 */
function pricingNow(db, businessDate) {
  const s = store.settings(db);
  return {
    service_charge: { rate: s.service_charge_rate, service_types: s.service_charge_types },
    tax_rules: store.taxRules(db).filter((r) => r.is_active && r.valid_from <= businessDate && (!r.valid_to || r.valid_to >= businessDate)),
  };
}

function pricingOf(db, order) {
  let p = {};
  try { p = JSON.parse(order.pricing || '{}'); } catch { p = {}; }
  return p.service_charge && Array.isArray(p.tax_rules) ? p : pricingNow(db, order.business_date);
}

function computeFor(db, order, { discountSpec } = {}) {
  const pricing = pricingOf(db, order);
  const lines = items(db, order.id).map((i) => ({ id: i.id, unit_price: i.unit_price, modifiers_price: i.modifiers_price,
    quantity: String(i.quantity), voided_quantity: String(i.voided_quantity), tax_class: i.tax_class }));
  const existing = billOf(db, order.id);
  const spec = discountSpec !== undefined ? discountSpec : (existing && existing.discount_spec ? JSON.parse(existing.discount_spec) : null);
  return billing.computeBill({
    service_type: order.service_type, business_date: order.business_date, lines, discount: spec,
    service_charge: pricing.service_charge, tax_rules: pricing.tax_rules,
  });
}

/** Create or refresh the order's bill from its items. Never below what is already paid (R6). */
function refreshBill(db, order, { discountSpec, discountReason, by } = {}) {
  let computed;
  try {
    computed = computeFor(db, order, { discountSpec });
  } catch (e) {
    if (e instanceof billing.BillError) throw new RestaurantError(e.code, 'That discount is more than the bill.', 400);
    throw e;
  }
  const existing = billOf(db, order.id);
  const paid = existing ? paidOn(db, existing.id) : '0.00';
  if (billing.compareMoney(computed.total, paid) < 0) {
    throw new RestaurantError('below_paid', `The bill cannot go below the ₦${paid} already paid.`, 409);
  }
  const ts = nowIso();
  const id = existing ? existing.id : uuid();
  const spec = discountSpec !== undefined ? discountSpec : (existing ? (existing.discount_spec ? JSON.parse(existing.discount_spec) : null) : null);
  // Settled only while what is paid covers the CURRENT total: items added after paying reopen the bill.
  const covered = billing.compareMoney(computed.total, '0.00') > 0 && billing.compareMoney(paid, computed.total) >= 0;
  const status = covered ? 'settled' : 'open';
  if (existing) {
    db.prepare(`UPDATE r_bills SET subtotal = ?, discount = ?, discount_spec = ?, discount_reason = COALESCE(?, discount_reason),
                discount_by = COALESCE(?, discount_by), net = ?, total = ?, status = ?,
                settled_at = CASE WHEN ? = 'settled' THEN COALESCE(settled_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?`)
      .run(computed.subtotal, computed.discount, spec ? JSON.stringify(spec) : null, discountReason ?? null, by ?? null,
        computed.net, computed.total, status, status, ts, ts, id);
    db.prepare(`DELETE FROM r_bill_charges WHERE bill_id = ?`).run(id);
  } else {
    db.prepare(`INSERT INTO r_bills (id, order_id, number, status, subtotal, discount, discount_spec, discount_reason, discount_by, net, total, updated_at)
                VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, order.id, `B-${order.number}`, computed.subtotal, computed.discount, spec ? JSON.stringify(spec) : null,
        discountReason ?? null, by ?? null, computed.net, computed.total, ts);
  }
  const insert = db.prepare(`INSERT INTO r_bill_charges (id, bill_id, kind, tax_rule_id, name, rate, inclusive, base, amount, sort) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  computed.charges.forEach((c, i) => insert.run(uuid(), id, c.kind, c.tax_rule_id, c.name, c.rate, c.inclusive ? 1 : 0, c.base, c.amount, i));
  return billOf(db, order.id);
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------
function orderView(db, orderId) {
  const order = getOrderRow(db, orderId);
  const its = items(db, orderId).map((i) => ({
    ...i,
    modifiers: db.prepare(`SELECT option_id, group_id, name, price_delta FROM r_order_item_modifiers WHERE order_item_id = ?`).all(i.id),
    tickets: ticketItemsOf(db, i.id).map((t) => ({ ticket_item_id: t.id, station_id: t.station_id, state: t.state, version: t.version, quantity: t.quantity, voided_quantity: t.voided_quantity })),
  }));
  const bill = billOf(db, orderId);
  const billView = bill ? {
    ...bill,
    charges: db.prepare(`SELECT kind, tax_rule_id, name, rate, inclusive, base, amount FROM r_bill_charges WHERE bill_id = ? ORDER BY sort`).all(bill.id)
      .map((c) => ({ ...c, inclusive: Boolean(c.inclusive) })),
    payments: db.prepare(`SELECT * FROM r_payments WHERE bill_id = ? ORDER BY received_at, rowid`).all(bill.id),
    paid: paidOn(db, bill.id),
  } : null;
  const live = its.filter((i) => remaining(i) > 0);
  const kitchenDone = (i) => i.tickets.filter((t) => t.state !== 'voided').every((t) => t.state === 'ready' || t.state === 'served');
  let kitchen = 'in_kitchen';
  if (live.length === 0 || live.every((i) => i.state === 'pending')) kitchen = 'not_sent';
  else if (live.every((i) => i.state === 'served')) kitchen = 'served';
  else if (!live.some((i) => i.state === 'pending') && live.every((i) => i.state === 'served' || kitchenDone(i))) kitchen = 'ready';
  const payment = !billView || billing.compareMoney(billView.paid, '0.00') === 0 ? 'unpaid'
    : billing.compareMoney(billView.paid, billView.total) >= 0 ? 'paid' : 'partly_paid';
  return { ...order, items: its, bill: billView, kitchen_status: kitchen, payment_status: payment };
}

function tablesView(db) {
  return db.prepare(
    `SELECT t.id, t.label, t.seats, t.area_id, a.name AS area, o.id AS order_id, o.number AS order_number,
            (SELECT COUNT(*) FROM r_bills b WHERE b.order_id = o.id AND b.printed_at IS NOT NULL) AS billed
     FROM r_tables t LEFT JOIN r_areas a ON a.id = t.area_id
     LEFT JOIN r_orders o ON o.table_id = t.id AND o.status = 'open'
     WHERE t.is_deleted = 0 AND t.is_active = 1 ORDER BY a.sort, t.sort, t.label`
  ).all().map((t) => ({ ...t, status: !t.order_id ? 'free' : t.billed ? 'billing' : 'occupied' }));
}

/** What a kitchen screen shows: its stations' tickets that still have work on them. */
function kitchenView(db, stationIds) {
  const tickets = db.prepare(
    `SELECT t.*, o.number AS order_number, o.service_type, rt.label AS table_label FROM r_tickets t
     JOIN r_orders o ON o.id = t.order_id LEFT JOIN r_tables rt ON rt.id = o.table_id
     WHERE t.kind = 'new' AND t.station_id IN (${stationIds.map(() => '?').join(',') || "''"}) ORDER BY t.sent_at`
  ).all(...stationIds);
  const out = [];
  for (const t of tickets) {
    const its = db.prepare(
      `SELECT ti.*, oi.name, oi.notes, oi.void_reason FROM r_ticket_items ti JOIN r_order_items oi ON oi.id = ti.order_item_id WHERE ti.ticket_id = ? ORDER BY ti.rowid`
    ).all(t.id).map((i) => ({ ...i, modifiers: db.prepare(`SELECT name FROM r_order_item_modifiers WHERE order_item_id = ?`).all(i.order_item_id).map((m) => m.name) }));
    if (its.some((i) => ['queued', 'preparing', 'ready'].includes(i.state))) out.push({ ...t, items: its });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// T1 open an order
// ---------------------------------------------------------------------------------------------
function openOrder(db, { service_type: serviceType, table_id: tableId = null, guests = null, notes = '', waiter = null } = {}, ctx, key) {
  return tx(db, key, 'open', { serviceType, tableId, guests, notes, waiter }, () => {
    need(ctx, 'take_orders');
    if (!SERVICE_TYPES.includes(serviceType)) throw new RestaurantError('bad_service_type', 'Choose dine-in, takeaway or counter.');
    if (serviceType === 'dine_in') {
      const table = tableId && db.prepare(`SELECT * FROM r_tables WHERE id = ? AND is_deleted = 0 AND is_active = 1`).get(tableId);
      if (!table) throw new RestaurantError('unknown_table', 'Choose a table.', 404);
    } else if (tableId) {
      throw new RestaurantError('table_not_allowed', 'Only dine-in orders have a table.');
    }
    const day = store.businessDate(db);
    const prefix = store.settings(db).order_number_prefix;
    const number = `${prefix}${String(store.nextNumber(db, 'order', day)).padStart(4, '0')}`;
    const id = uuid();
    try {
      db.prepare(`INSERT INTO r_orders (id, number, service_type, table_id, guests, waiter, opened_by, status, business_date, opened_at, notes, device_id, pricing)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`)
        .run(id, number, serviceType, tableId, guests, waiter || ctx.user, ctx.user, day, nowIso(), notes || '', tillDb().getSetting(db, 'device_id'),
          JSON.stringify(pricingNow(db, day)));
    } catch (e) {
      if (/UNIQUE/.test(String(e.message))) throw new RestaurantError('table_occupied', 'That table already has an open order.', 409);
      throw e;
    }
    store.emit(db, 'order.opened', { entityType: 'order', entityId: id, data: { number, table_id: tableId } });
    if (tableId) store.emit(db, 'table.changed', { entityType: 'table', entityId: tableId, data: { status: 'occupied' } });
    return orderView(db, id);
  });
}

// ---------------------------------------------------------------------------------------------
// T2 pending items: add, change, remove (free until sent)
// ---------------------------------------------------------------------------------------------
function validateModifiers(db, menu, optionIds) {
  const groups = db.prepare(
    `SELECT g.* FROM r_item_modifier_groups l JOIN r_modifier_groups g ON g.id = l.group_id
     WHERE l.menu_item_id = ? AND l.is_deleted = 0 AND g.is_deleted = 0 AND g.is_active = 1 ORDER BY l.sort`
  ).all(menu.id);
  const chosen = [];
  for (const optionId of optionIds || []) {
    const option = db.prepare(`SELECT * FROM r_modifier_options WHERE id = ? AND is_deleted = 0`).get(optionId);
    if (!option || !groups.some((g) => g.id === option.group_id)) throw new RestaurantError('bad_modifier', `That choice is not offered for ${menu.name}.`);
    if (!option.is_active || !option.is_available) throw new RestaurantError('modifier_unavailable', `${option.name} is not available.`);
    if (chosen.some((c) => c.id === option.id)) throw new RestaurantError('bad_modifier', `${option.name} is chosen twice.`);
    chosen.push(option);
  }
  for (const g of groups) {
    const n = chosen.filter((c) => c.group_id === g.id).length;
    if (n < g.min_select || n > g.max_select) {
      const want = g.min_select === g.max_select ? `${g.min_select}` : `${g.min_select}–${g.max_select}`;
      throw new RestaurantError('modifier_rules', `${menu.name}: choose ${want} for ${g.name}.`);
    }
  }
  return chosen;
}

function addItems(db, orderId, lines, ctx, key) {
  return tx(db, key, 'add_items', { orderId, lines }, () => {
    need(ctx, 'take_orders');
    const order = openOrderRow(db, orderId);
    if (!Array.isArray(lines) || lines.length === 0) throw new RestaurantError('no_items', 'Add at least one item.');
    let sort = db.prepare(`SELECT COALESCE(MAX(sort), 0) AS n FROM r_order_items WHERE order_id = ?`).get(orderId).n;
    for (const line of lines) {
      const menu = store.menuItem(db, line.menu_item_id);
      if (!menu || !menu.is_active) throw new RestaurantError('unknown_menu_item', 'That item is not on the menu.', 404);
      if (!menu.is_available || store.isSoldOut(db, menu.id, order.business_date)) throw new RestaurantError('sold_out', `${menu.name} is sold out.`, 409);
      const quantity = Number(line.quantity ?? 1);
      if (!Number.isInteger(quantity) || quantity < 1) throw new RestaurantError('bad_quantity', 'Quantity must be a whole number, 1 or more.');
      const chosen = validateModifiers(db, menu, line.modifiers);
      const modifiersPrice = chosen.reduce((acc, o) => billing.addMoney(acc, o.price_delta), '0.00');
      const id = uuid();
      sort += 1;
      db.prepare(`INSERT INTO r_order_items (id, order_id, menu_item_id, name, unit_price, modifiers_price, tax_class, quantity, notes, state, added_by, created_at, sort)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(id, orderId, menu.id, menu.name, menu.price, modifiersPrice, menu.tax_class, quantity, String(line.notes || '').slice(0, 200), ctx.user, nowIso(), sort);
      const insertMod = db.prepare(`INSERT INTO r_order_item_modifiers (id, order_item_id, option_id, group_id, name, price_delta) VALUES (?,?,?,?,?,?)`);
      for (const o of chosen) insertMod.run(uuid(), id, o.id, o.group_id, o.name, o.price_delta);
    }
    store.emit(db, 'order.updated', { entityType: 'order', entityId: orderId });
    return orderView(db, orderId);
  });
}

function pendingItem(db, itemId) {
  const item = db.prepare(`SELECT * FROM r_order_items WHERE id = ?`).get(itemId);
  if (!item) throw new RestaurantError('not_found', 'Item not found.', 404);
  openOrderRow(db, item.order_id);
  if (item.state !== 'pending') throw new RestaurantError('already_sent', 'This item went to the kitchen; void it instead.', 409);
  return item;
}

function changePendingItem(db, itemId, { quantity, notes } = {}, ctx, key) {
  return tx(db, key, 'change_item', { itemId, quantity, notes }, () => {
    need(ctx, 'take_orders');
    const item = pendingItem(db, itemId);
    const q = quantity === undefined ? item.quantity : Number(quantity);
    if (!Number.isInteger(q) || q < 1) throw new RestaurantError('bad_quantity', 'Quantity must be a whole number, 1 or more.');
    db.prepare(`UPDATE r_order_items SET quantity = ?, notes = ? WHERE id = ?`).run(q, notes === undefined ? item.notes : String(notes).slice(0, 200), itemId);
    store.emit(db, 'order.updated', { entityType: 'order', entityId: item.order_id });
    return orderView(db, item.order_id);
  });
}

function removePendingItem(db, itemId, ctx, key) {
  return tx(db, key, 'remove_item', { itemId }, () => {
    need(ctx, 'take_orders');
    const item = pendingItem(db, itemId);
    db.prepare(`DELETE FROM r_order_item_modifiers WHERE order_item_id = ?`).run(itemId);
    db.prepare(`DELETE FROM r_order_items WHERE id = ?`).run(itemId);
    store.emit(db, 'order.updated', { entityType: 'order', entityId: item.order_id });
    return orderView(db, item.order_id);
  });
}

// ---------------------------------------------------------------------------------------------
// T3 send to the kitchen
// ---------------------------------------------------------------------------------------------
function ticketNumber(db, stationRow, day) {
  const letter = (stationRow.name || 'K').trim().charAt(0).toUpperCase() || 'K';
  return `${letter}-${store.nextNumber(db, `ticket:${stationRow.id}`, day)}`;
}

function queuePrint(db, ticketId, stationId, kind, by) {
  const st = store.station(db, stationId);
  if (!st || !st.prints) return;
  db.prepare(`INSERT INTO r_print_jobs (id, ticket_id, station_id, kind, status, created_at, requested_by) VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
    .run(uuid(), ticketId, stationId, kind, nowIso(), by);
}

function sendToKitchen(db, orderId, ctx, key) {
  return tx(db, key, 'send', { orderId }, () => {
    need(ctx, 'send_to_kitchen');
    const order = openOrderRow(db, orderId);
    const active = store.activeStationIds(db);
    const lines = items(db, orderId).map((i) => {
      const menu = store.menuItem(db, i.menu_item_id);
      return { id: i.id, state: i.state, station_id: stationFor(menu && menu.station_id, menu && menu.category_station_id, active) };
    });
    const plan = route(lines);
    const ts = nowIso();
    const created = [];
    for (const ticket of plan.tickets) {
      const st = store.station(db, ticket.station_id);
      const ticketId = uuid();
      const number = ticketNumber(db, st, order.business_date);
      db.prepare(`INSERT INTO r_tickets (id, order_id, station_id, number, kind, sent_by, sent_at, business_date) VALUES (?, ?, ?, ?, 'new', ?, ?, ?)`)
        .run(ticketId, orderId, st.id, number, ctx.user, ts, order.business_date);
      for (const itemId of ticket.items) {
        const item = db.prepare(`SELECT quantity FROM r_order_items WHERE id = ?`).get(itemId);
        db.prepare(`INSERT INTO r_ticket_items (id, ticket_id, order_item_id, quantity) VALUES (?, ?, ?, ?)`).run(uuid(), ticketId, itemId, item.quantity);
        db.prepare(`UPDATE r_order_items SET state = 'sent', sent_at = ?, station_id = ? WHERE id = ?`).run(ts, st.id, itemId);
      }
      queuePrint(db, ticketId, st.id, 'ticket', ctx.user);
      store.emit(db, 'ticket.created', { stationIds: [st.id], entityType: 'ticket', entityId: ticketId, data: { number, order_id: orderId } });
      created.push({ id: ticketId, number, station_id: st.id, station_name: st.name, items: ticket.items });
    }
    // Items with no active station (e.g. bottled water) need no kitchen: they are sent and can be served at once.
    for (const itemId of plan.unrouted) db.prepare(`UPDATE r_order_items SET state = 'sent', sent_at = ? WHERE id = ?`).run(ts, itemId);
    if (created.length || plan.unrouted.length) store.emit(db, 'order.updated', { entityType: 'order', entityId: orderId });
    return { tickets: created, unrouted: plan.unrouted, order: orderView(db, orderId) };
  });
}

// ---------------------------------------------------------------------------------------------
// T4 / T5 kitchen and service progress
// ---------------------------------------------------------------------------------------------
const NEXT = { queued: ['preparing', 'ready'], preparing: ['ready'], ready: ['served'] };

function afterTicketChange(db, orderItemId) {
  const item = db.prepare(`SELECT * FROM r_order_items WHERE id = ?`).get(orderItemId);
  const live = ticketItemsOf(db, orderItemId).filter((t) => t.state !== 'voided');
  if (item.state === 'sent' && live.length && live.every((t) => t.state === 'served')) {
    db.prepare(`UPDATE r_order_items SET state = 'served', served_at = ? WHERE id = ?`).run(nowIso(), orderItemId);
  }
  const order = getOrderRow(db, item.order_id);
  const outstanding = db.prepare(
    `SELECT COUNT(*) AS n FROM r_ticket_items ti JOIN r_order_items oi ON oi.id = ti.order_item_id
     WHERE oi.order_id = ? AND ti.state IN ('queued', 'preparing')`).get(order.id).n;
  return { order, outstanding };
}

function setTicketItemState(db, ticketItemId, { to, version } = {}, ctx, key) {
  return tx(db, key, 'ticket_item_state', { ticketItemId, to, version }, () => {
    const ti = db.prepare(`SELECT ti.*, t.station_id, t.order_id FROM r_ticket_items ti JOIN r_tickets t ON t.id = ti.ticket_id WHERE ti.id = ?`).get(ticketItemId);
    if (!ti) throw new RestaurantError('not_found', 'Ticket item not found.', 404);
    if (ctx && ctx.isScreen && !(ctx.stationIds || []).includes(ti.station_id)) throw new RestaurantError('not_your_station', 'This screen does not cover that station.', 403);
    const kitchenAction = to === 'preparing' || to === 'ready';
    const allowed = ctx && (ctx.isOwner || ctx.isScreen || (kitchenAction ? ctx.role === 'kitchen' : can(ctx, 'take_orders')));
    if (!allowed) throw new RestaurantError('not_allowed', 'You are not allowed to do that.', 403);
    openOrderRow(db, ti.order_id);
    if (ti.state === to) return { ticket_item: ti, changed: false }; // already there: success, nothing to do
    if (version !== undefined && Number(version) !== ti.version) {
      throw new RestaurantError('version_mismatch', 'Someone changed this item a moment ago.', 409, { current: { state: ti.state, version: ti.version } });
    }
    if (!(NEXT[ti.state] || []).includes(to)) {
      throw new RestaurantError('bad_transition', `Cannot go from ${ti.state} to ${to}.`, 409, { current: { state: ti.state, version: ti.version } });
    }
    const ts = nowIso();
    const stamp = to === 'preparing' ? 'started_at' : to === 'ready' ? 'ready_at' : 'served_at';
    db.prepare(`UPDATE r_ticket_items SET state = ?, version = version + 1, ${stamp} = ? WHERE id = ?`).run(to, ts, ticketItemId);
    const { order, outstanding } = afterTicketChange(db, ti.order_item_id);
    store.emit(db, 'ticket.item_changed', { stationIds: [ti.station_id], entityType: 'ticket_item', entityId: ticketItemId,
      data: { state: to, version: ti.version + 1, order_id: order.id } });
    if (to === 'ready' && outstanding === 0) store.emit(db, 'order.ready', { entityType: 'order', entityId: order.id, data: { number: order.number } });
    if (to === 'served') tryClose(db, order.id);
    return { ticket_item: db.prepare(`SELECT * FROM r_ticket_items WHERE id = ?`).get(ticketItemId), changed: true };
  });
}

function bumpTicket(db, ticketId, ctx, key) {
  return tx(db, key, 'bump', { ticketId }, () => {
    const t = db.prepare(`SELECT * FROM r_tickets WHERE id = ?`).get(ticketId);
    if (!t) throw new RestaurantError('not_found', 'Ticket not found.', 404);
    if (ctx && ctx.isScreen && !(ctx.stationIds || []).includes(t.station_id)) throw new RestaurantError('not_your_station', 'This screen does not cover that station.', 403);
    if (!(ctx && (ctx.isOwner || ctx.isScreen || ctx.role === 'kitchen'))) throw new RestaurantError('not_allowed', 'You are not allowed to do that.', 403);
    openOrderRow(db, t.order_id);
    const ts = nowIso();
    const open = db.prepare(`SELECT * FROM r_ticket_items WHERE ticket_id = ? AND state IN ('queued', 'preparing')`).all(ticketId);
    for (const ti of open) {
      db.prepare(`UPDATE r_ticket_items SET state = 'ready', version = version + 1, ready_at = ? WHERE id = ?`).run(ts, ti.id);
      store.emit(db, 'ticket.item_changed', { stationIds: [t.station_id], entityType: 'ticket_item', entityId: ti.id, data: { state: 'ready', version: ti.version + 1, order_id: t.order_id } });
    }
    const { order, outstanding } = afterTicketChange(db, open.length ? open[0].order_item_id : db.prepare(`SELECT order_item_id FROM r_ticket_items WHERE ticket_id = ?`).get(ticketId).order_item_id);
    if (open.length && outstanding === 0) store.emit(db, 'order.ready', { entityType: 'order', entityId: order.id, data: { number: order.number } });
    return { bumped: open.length };
  });
}

/** T5: the waiter serves an item: its ready kitchen work becomes served (items with no kitchen are served at once). */
function serveItem(db, orderItemId, ctx, key) {
  return tx(db, key, 'serve', { orderItemId }, () => {
    need(ctx, 'take_orders');
    const item = db.prepare(`SELECT * FROM r_order_items WHERE id = ?`).get(orderItemId);
    if (!item) throw new RestaurantError('not_found', 'Item not found.', 404);
    openOrderRow(db, item.order_id);
    if (item.state === 'served') return orderView(db, item.order_id);
    if (item.state !== 'sent') throw new RestaurantError('not_sent', 'Send the item to the kitchen first.', 409);
    const live = ticketItemsOf(db, orderItemId).filter((t) => t.state !== 'voided');
    if (live.some((t) => t.state === 'queued' || t.state === 'preparing')) throw new RestaurantError('not_ready', 'The kitchen has not finished this item.', 409);
    const ts = nowIso();
    for (const t of live.filter((x) => x.state === 'ready')) {
      db.prepare(`UPDATE r_ticket_items SET state = 'served', version = version + 1, served_at = ? WHERE id = ?`).run(ts, t.id);
      store.emit(db, 'ticket.item_changed', { stationIds: [t.station_id], entityType: 'ticket_item', entityId: t.id, data: { state: 'served', version: t.version + 1, order_id: item.order_id } });
    }
    db.prepare(`UPDATE r_order_items SET state = 'served', served_at = ? WHERE id = ?`).run(ts, orderItemId);
    store.emit(db, 'order.updated', { entityType: 'order', entityId: item.order_id });
    tryClose(db, item.order_id);
    return orderView(db, item.order_id);
  });
}

// ---------------------------------------------------------------------------------------------
// T6 void an item the kitchen already has
// ---------------------------------------------------------------------------------------------
function voidItem(db, orderItemId, { quantity, reason } = {}, ctx, key) {
  return tx(db, key, 'void', { orderItemId, quantity, reason }, () => {
    need(ctx, 'void_sent_item');
    const item = db.prepare(`SELECT * FROM r_order_items WHERE id = ?`).get(orderItemId);
    if (!item) throw new RestaurantError('not_found', 'Item not found.', 404);
    const order = openOrderRow(db, item.order_id);
    if (item.state === 'pending') throw new RestaurantError('not_sent', 'This item has not gone to the kitchen; just remove it.', 409);
    const q = Number(quantity ?? remaining(item));
    if (!Number.isInteger(q) || q < 1 || q > remaining(item)) throw new RestaurantError('bad_quantity', `You can void 1 to ${remaining(item)}.`);
    const why = String(reason || '').trim();
    if (!why) throw new RestaurantError('reason_required', 'Say why the item is voided.');
    const kitchen = ticketItemsOf(db, orderItemId);
    const waste = item.state === 'served' || kitchen.some((t) => ['preparing', 'ready', 'served'].includes(t.state) && t.voided_quantity < t.quantity);

    db.prepare(`UPDATE r_order_items SET voided_quantity = voided_quantity + ?, void_reason = ?, waste = MAX(waste, ?), voided_by = ?,
                state = CASE WHEN voided_quantity + ? >= quantity THEN 'voided' ELSE state END WHERE id = ?`)
      .run(q, why, waste ? 1 : 0, ctx.user, q, orderItemId);
    // Take the void off the newest kitchen work first, and tell each station on a VOID slip.
    let left = q;
    const ts = nowIso();
    const voidTickets = new Map();
    for (const t of kitchen) {
      if (left <= 0) break;
      const take = Math.min(t.quantity - t.voided_quantity, left);
      if (take <= 0) continue;
      db.prepare(`UPDATE r_ticket_items SET voided_quantity = voided_quantity + ?, version = version + 1,
                  state = CASE WHEN voided_quantity + ? >= quantity THEN 'voided' ELSE state END WHERE id = ?`).run(take, take, t.id);
      left -= take;
      if (!voidTickets.has(t.station_id)) {
        const st = store.station(db, t.station_id);
        const id = uuid();
        db.prepare(`INSERT INTO r_tickets (id, order_id, station_id, number, kind, sent_by, sent_at, business_date) VALUES (?, ?, ?, ?, 'void', ?, ?, ?)`)
          .run(id, order.id, st.id, ticketNumber(db, st, order.business_date), ctx.user, ts, order.business_date);
        voidTickets.set(t.station_id, id);
        queuePrint(db, id, st.id, 'void', ctx.user);
      }
      db.prepare(`INSERT INTO r_ticket_items (id, ticket_id, order_item_id, quantity, voided_quantity, state) VALUES (?, ?, ?, ?, ?, 'voided')`)
        .run(uuid(), voidTickets.get(t.station_id), orderItemId, take, take);
      store.emit(db, 'ticket.voided', { stationIds: [t.station_id], entityType: 'ticket_item', entityId: t.id, data: { quantity: take, reason: why, order_id: order.id } });
    }
    if (billOf(db, order.id)) refreshBill(db, order); // throws below_paid, rolling the whole void back
    audit(db, 'restaurant.item_voided', `Voided ${q} × ${item.name} on order ${order.number}${waste ? ' (waste)' : ''}`, why,
      { order_id: order.id, order_item_id: orderItemId, quantity: q, waste });
    store.emit(db, 'order.updated', { entityType: 'order', entityId: order.id });
    tryClose(db, order.id);
    return orderView(db, order.id);
  });
}

// ---------------------------------------------------------------------------------------------
// T7 move table
// ---------------------------------------------------------------------------------------------
function moveTable(db, orderId, tableId, ctx, key) {
  return tx(db, key, 'move', { orderId, tableId }, () => {
    need(ctx, 'move_table');
    const order = openOrderRow(db, orderId);
    if (order.service_type !== 'dine_in') throw new RestaurantError('not_dine_in', 'Only dine-in orders have a table.');
    if (order.table_id === tableId) return orderView(db, orderId);
    const table = db.prepare(`SELECT * FROM r_tables WHERE id = ? AND is_deleted = 0 AND is_active = 1`).get(tableId);
    if (!table) throw new RestaurantError('unknown_table', 'Choose a table.', 404);
    try {
      db.prepare(`UPDATE r_orders SET table_id = ? WHERE id = ?`).run(tableId, orderId);
    } catch (e) {
      if (/UNIQUE/.test(String(e.message))) throw new RestaurantError('table_occupied', `${table.label} already has an open order.`, 409);
      throw e;
    }
    audit(db, 'restaurant.table_moved', `Order ${order.number} moved to ${table.label}`, '', { order_id: orderId, from: order.table_id, to: tableId });
    store.emit(db, 'table.changed', { entityType: 'table', entityId: order.table_id, data: { status: 'free' } });
    store.emit(db, 'table.changed', { entityType: 'table', entityId: tableId, data: { status: 'occupied' } });
    return orderView(db, orderId);
  });
}

// ---------------------------------------------------------------------------------------------
// T8 print the bill · T9 discount
// ---------------------------------------------------------------------------------------------
function printBill(db, orderId, ctx, key) {
  return tx(db, key, 'bill', { orderId }, () => {
    need(ctx, 'take_payment');
    const order = openOrderRow(db, orderId);
    if (!items(db, orderId).some((i) => remaining(i) > 0)) throw new RestaurantError('empty_order', 'There is nothing to bill.');
    const bill = refreshBill(db, order);
    db.prepare(`UPDATE r_bills SET printed_at = ?, print_count = print_count + 1 WHERE id = ?`).run(nowIso(), bill.id);
    store.emit(db, 'bill.printed', { entityType: 'bill', entityId: bill.id, data: { order_id: orderId, total: bill.total } });
    if (order.table_id) store.emit(db, 'table.changed', { entityType: 'table', entityId: order.table_id, data: { status: 'billing' } });
    return orderView(db, orderId);
  });
}

function applyDiscount(db, orderId, { type, value, reason } = {}, ctx, key) {
  return tx(db, key, 'discount', { orderId, type, value, reason }, () => {
    need(ctx, 'apply_discount');
    const order = openOrderRow(db, orderId);
    const clearing = value === null || value === undefined || Number(value) === 0;
    if (!clearing && !['amount', 'percent'].includes(type)) throw new RestaurantError('bad_discount', 'A discount is an amount or a percent.');
    if (!clearing && (!(Number(value) > 0) || (type === 'percent' && Number(value) > 100))) throw new RestaurantError('bad_discount', 'Give a discount above zero (a percent up to 100).');
    const why = String(reason || '').trim();
    if (!clearing && !why) throw new RestaurantError('reason_required', 'Say why the discount is given.');
    const bill = refreshBill(db, order, { discountSpec: clearing ? null : { type, value: String(value) }, discountReason: clearing ? '' : why, by: ctx.user });
    audit(db, 'restaurant.discount', clearing ? `Discount removed on order ${order.number}` : `Discount ${bill.discount} on order ${order.number}`, why,
      { order_id: orderId, type, value: String(value ?? 0), discount: bill.discount });
    store.emit(db, 'order.updated', { entityType: 'order', entityId: orderId });
    return orderView(db, orderId);
  });
}

// ---------------------------------------------------------------------------------------------
// T10 payment · T11 close
// ---------------------------------------------------------------------------------------------
function takePayment(db, orderId, { method, amount, tendered = null, tip = '0', reference = '', override = false } = {}, ctx, key) {
  return tx(db, key, 'pay', { orderId, method, amount, tendered, tip, reference, override }, () => {
    need(ctx, 'take_payment');
    const order = openOrderRow(db, orderId);
    if (!tillDb().paymentMethods(db).includes(method)) throw new RestaurantError('bad_method', 'Choose cash, transfer, POS or mobile money.');
    if (!items(db, orderId).some((i) => remaining(i) > 0)) throw new RestaurantError('empty_order', 'There is nothing to bill.');
    const bill = refreshBill(db, order); // always against the latest items
    const paid = paidOn(db, bill.id);
    const balance = billing.subMoney(bill.total, paid);
    const value = String(amount ?? balance);
    if (!(Number(value) > 0)) throw new RestaurantError('bad_amount', 'Enter an amount above zero.');
    if (billing.compareMoney(value, balance) > 0) throw new RestaurantError('payment_exceeds_balance', `Only ₦${balance} is left to pay.`, 409);
    const tipValue = String(tip || '0');
    if (Number(tipValue) < 0) throw new RestaurantError('bad_tip', 'A tip cannot be negative.');
    let change = '0.00';
    if (method === 'cash') {
      const handed = String(tendered ?? billing.addMoney(value, tipValue));
      const due = billing.addMoney(value, tipValue);
      if (billing.compareMoney(handed, due) < 0) throw new RestaurantError('not_enough_cash', `The customer handed ₦${handed}; ₦${due} is due.`);
      change = billing.subMoney(handed, due);
    }
    const shift = tillDb().getOpenShift(db, ctx.user);
    if (method === 'cash' && !shift) throw new RestaurantError('no_open_shift', 'Open your shift before taking cash.', 409);
    let overrideBy = null;
    if (store.settings(db).require_served_before_payment && order.service_type === 'dine_in') {
      const unserved = items(db, orderId).some((i) => remaining(i) > 0 && i.state !== 'served');
      if (unserved) {
        if (!(override && can(ctx, 'override_served_rule'))) throw new RestaurantError('not_served', 'Serve everything before taking payment (or a manager overrides).', 409);
        overrideBy = ctx.user;
        audit(db, 'restaurant.payment_override', `Payment taken before everything was served on order ${order.number}`, '', { order_id: orderId });
      }
    }
    const id = uuid();
    db.prepare(`INSERT INTO r_payments (id, bill_id, method, amount, tendered, change, tip, reference, shift_id, received_by, received_at, override_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, bill.id, method, billing.addMoney(value, '0'), method === 'cash' ? String(tendered ?? billing.addMoney(value, tipValue)) : null,
        change, billing.addMoney(tipValue, '0'), String(reference || '').slice(0, 80), shift ? shift.id : null, ctx.user, nowIso(), overrideBy);
    refreshBill(db, order); // marks the bill settled once the payments cover it
    store.emit(db, 'payment.received', { entityType: 'payment', entityId: id, data: { order_id: orderId, method, amount: value } });
    tryClose(db, orderId);
    return { payment_id: id, change, order: orderView(db, orderId) };
  });
}

/** T11: closes the order once the bill is settled and nothing is left in the kitchen or unsent. */
function tryClose(db, orderId) {
  const order = getOrderRow(db, orderId);
  if (order.status !== 'open') return false;
  if (!billOf(db, orderId)) return false;
  const live = items(db, orderId).filter((i) => remaining(i) > 0);
  if (live.length === 0 || live.some((i) => i.state !== 'served')) return false; // everything voided -> cancel instead
  if (refreshBill(db, order).status !== 'settled') return false; // against the CURRENT items, never a stale total
  const ts = nowIso();
  db.prepare(`UPDATE r_orders SET status = 'closed', closed_at = ? WHERE id = ?`).run(ts, orderId);
  store.emit(db, 'order.closed', { entityType: 'order', entityId: orderId, data: { number: order.number } });
  if (order.table_id) store.emit(db, 'table.changed', { entityType: 'table', entityId: order.table_id, data: { status: 'free' } });
  queueOrderDoc(db, orderId);
  return true;
}

// ---------------------------------------------------------------------------------------------
// T12 cancel · T13 sold out
// ---------------------------------------------------------------------------------------------
function cancelOrder(db, orderId, { reason } = {}, ctx, key) {
  return tx(db, key, 'cancel', { orderId, reason }, () => {
    const order = openOrderRow(db, orderId);
    const its = items(db, orderId);
    const anySent = its.some((i) => i.state !== 'pending');
    need(ctx, anySent ? 'cancel_order' : 'take_orders');
    const why = String(reason || '').trim();
    if (!why) throw new RestaurantError('reason_required', 'Say why the order is cancelled.');
    const bill = billOf(db, orderId);
    if (bill && billing.compareMoney(paidOn(db, bill.id), '0.00') > 0) throw new RestaurantError('has_payments', 'This order has payments; it cannot be cancelled.', 409);
    const ts = nowIso();
    const voidTickets = new Map();
    for (const item of its) {
      if (item.state === 'pending') {
        db.prepare(`UPDATE r_order_items SET state = 'voided', voided_quantity = quantity, void_reason = ?, voided_by = ? WHERE id = ?`).run(why, ctx.user, item.id);
        continue;
      }
      const kitchen = ticketItemsOf(db, item.id);
      const waste = item.state === 'served' || kitchen.some((t) => ['preparing', 'ready', 'served'].includes(t.state));
      for (const t of kitchen.filter((x) => x.state !== 'voided' && x.state !== 'served')) {
        const take = t.quantity - t.voided_quantity;
        db.prepare(`UPDATE r_ticket_items SET state = 'voided', voided_quantity = quantity, version = version + 1 WHERE id = ?`).run(t.id);
        if (!voidTickets.has(t.station_id)) {
          const st = store.station(db, t.station_id);
          const id = uuid();
          db.prepare(`INSERT INTO r_tickets (id, order_id, station_id, number, kind, sent_by, sent_at, business_date) VALUES (?, ?, ?, ?, 'void', ?, ?, ?)`)
            .run(id, orderId, st.id, ticketNumber(db, st, order.business_date), ctx.user, ts, order.business_date);
          voidTickets.set(t.station_id, id);
          queuePrint(db, id, st.id, 'void', ctx.user);
        }
        db.prepare(`INSERT INTO r_ticket_items (id, ticket_id, order_item_id, quantity, voided_quantity, state) VALUES (?, ?, ?, ?, ?, 'voided')`)
          .run(uuid(), voidTickets.get(t.station_id), item.id, take, take);
        store.emit(db, 'ticket.voided', { stationIds: [t.station_id], entityType: 'ticket_item', entityId: t.id, data: { quantity: take, reason: why, order_id: orderId } });
      }
      db.prepare(`UPDATE r_order_items SET state = 'voided', voided_quantity = quantity, void_reason = ?, waste = MAX(waste, ?), voided_by = ? WHERE id = ?`)
        .run(why, waste ? 1 : 0, ctx.user, item.id);
    }
    if (bill) db.prepare(`UPDATE r_bills SET status = 'void', updated_at = ? WHERE id = ?`).run(ts, bill.id);
    db.prepare(`UPDATE r_orders SET status = 'cancelled', closed_at = ?, cancel_reason = ? WHERE id = ?`).run(ts, why, orderId);
    audit(db, 'restaurant.order_cancelled', `Order ${order.number} cancelled`, why, { order_id: orderId, sent: anySent });
    store.emit(db, 'order.cancelled', { entityType: 'order', entityId: orderId, data: { number: order.number } });
    if (order.table_id) store.emit(db, 'table.changed', { entityType: 'table', entityId: order.table_id, data: { status: 'free' } });
    queueOrderDoc(db, orderId);
    return orderView(db, orderId);
  });
}

function setSoldOut(db, menuItemId, soldOut, ctx, key) {
  return tx(db, key, 'sold_out', { menuItemId, soldOut }, () => {
    need(ctx, 'mark_sold_out');
    const menu = store.menuItem(db, menuItemId);
    if (!menu) throw new RestaurantError('unknown_menu_item', 'That item is not on the menu.', 404);
    const day = store.businessDate(db);
    if (soldOut) db.prepare(`INSERT OR IGNORE INTO r_sold_out (menu_item_id, business_date, by_user, at) VALUES (?, ?, ?, ?)`).run(menuItemId, day, ctx.user, nowIso());
    else db.prepare(`DELETE FROM r_sold_out WHERE menu_item_id = ? AND business_date = ?`).run(menuItemId, day);
    audit(db, 'restaurant.sold_out', `${menu.name} ${soldOut ? 'sold out' : 'back on'} (${day})`, '', { menu_item_id: menuItemId, sold_out: Boolean(soldOut), business_date: day });
    store.emit(db, 'menu.availability', { stationIds: store.activeStationIds(db), entityType: 'menu_item', entityId: menuItemId, data: { sold_out: Boolean(soldOut) } });
    if (tillDb().cloudSyncProtocol(db) >= ORDER_PROTOCOL) {
      tillDb().enqueueSync(db, { entityType: 'menu_availability', entityId: menuItemId, operation: 'update',
        payload: { menu_item_id: menuItemId, sold_out: Boolean(soldOut), business_date: day, by: ctx.user, at: nowIso() } });
    }
    return { menu_item_id: menuItemId, sold_out: Boolean(soldOut), business_date: day };
  });
}

// ---------------------------------------------------------------------------------------------
// Upload to the cloud (gss docs/restaurant/API_SPECIFICATION.md, order_doc)
// ---------------------------------------------------------------------------------------------
const ORDER_PROTOCOL = 6; // the cloud accepts order_doc from sync protocol 6

function orderDoc(db, orderId) {
  const v = orderView(db, orderId);
  const tickets = db.prepare(`SELECT * FROM r_tickets WHERE order_id = ? ORDER BY sent_at, rowid`).all(orderId).map((t) => ({
    id: t.id, station_id: t.station_id, number: t.number, kind: t.kind, sent_at: t.sent_at, sent_by: t.sent_by,
    items: db.prepare(`SELECT * FROM r_ticket_items WHERE ticket_id = ? ORDER BY rowid`).all(t.id).map((i) => ({
      id: i.id, order_item_id: i.order_item_id, quantity: i.quantity, voided_quantity: i.voided_quantity, state: i.state,
      started_at: i.started_at, ready_at: i.ready_at, served_at: i.served_at })),
  }));
  return {
    id: v.id, number: v.number, service_type: v.service_type, table_id: v.table_id, guests: v.guests, waiter: v.waiter,
    opened_by: v.opened_by, status: v.status, business_date: v.business_date, opened_at: v.opened_at, closed_at: v.closed_at,
    cancel_reason: v.cancel_reason, notes: v.notes,
    // Everything the cloud needs to work the bill out again from this document alone (never from
    // today's settings): the frozen service charge and tax rules, and the discount as entered.
    pricing: pricingOf(db, getOrderRow(db, orderId)),
    items: v.items.map((i) => ({ id: i.id, menu_item_id: i.menu_item_id, name: i.name, unit_price: i.unit_price, modifiers_price: i.modifiers_price,
      tax_class: i.tax_class, quantity: i.quantity, voided_quantity: i.voided_quantity, state: i.state, waste: Boolean(i.waste),
      void_reason: i.void_reason, notes: i.notes, sent_at: i.sent_at, served_at: i.served_at,
      modifiers: i.modifiers.map((m) => ({ option_id: m.option_id, group_id: m.group_id, name: m.name, price_delta: m.price_delta })) })),
    tickets,
    bill: v.bill && {
      id: v.bill.id, number: v.bill.number, status: v.bill.status, subtotal: v.bill.subtotal, discount: v.bill.discount,
      discount_spec: v.bill.discount_spec ? JSON.parse(v.bill.discount_spec) : null,
      discount_reason: v.bill.discount_reason, net: v.bill.net, total: v.bill.total, charges: v.bill.charges,
      payments: v.bill.payments.map((p) => ({ id: p.id, method: p.method, amount: p.amount, tendered: p.tendered, change: p.change, tip: p.tip,
        reference: p.reference, shift_ref: p.shift_id, received_by: p.received_by, received_at: p.received_at })),
    },
  };
}

/** Queue the finished order for the cloud, once. Older clouds (before protocol 6) cannot take it yet:
 * it stays on the hub and reconcileOrders() queues it after the cloud upgrades. */
function queueOrderDoc(db, orderId) {
  if (tillDb().cloudSyncProtocol(db) < ORDER_PROTOCOL) return false;
  const order = getOrderRow(db, orderId);
  if (order.queued_at || order.status === 'open') return false;
  tillDb().enqueueSync(db, { entityType: 'order_doc', entityId: orderId, operation: 'create', payload: orderDoc(db, orderId) });
  db.prepare(`UPDATE r_orders SET queued_at = ? WHERE id = ?`).run(nowIso(), orderId);
  return true;
}

/** After the cloud upgrades to protocol 6: queue finished orders and audit entries it could not take before. */
function reconcileOrders(db) {
  if (tillDb().cloudSyncProtocol(db) < ORDER_PROTOCOL) return 0;
  const orders = db.transaction(() => db.prepare(`SELECT id FROM r_orders WHERE status IN ('closed', 'cancelled') AND queued_at IS NULL`).all()
    .filter((o) => queueOrderDoc(db, o.id)).length)();
  return orders + store.queuePendingAudit(db);
}

module.exports = {
  openOrder, addItems, changePendingItem, removePendingItem, sendToKitchen, setTicketItemState, bumpTicket, serveItem,
  voidItem, moveTable, printBill, applyDiscount, takePayment, cancelOrder, setSoldOut,
  orderView, tablesView, kitchenView, orderDoc, reconcileOrders, ORDER_PROTOCOL, RestaurantError,
};

/** The menu as the order screen shows it: categories, items with their choices, and what is sold out today. */
function menuView(db) {
  const day = store.businessDate(db);
  const soldOut = new Set(db.prepare(`SELECT menu_item_id FROM r_sold_out WHERE business_date = ?`).all(day).map((r) => r.menu_item_id));
  const groups = db.prepare(`SELECT * FROM r_modifier_groups WHERE is_deleted = 0 AND is_active = 1`).all();
  const options = db.prepare(`SELECT * FROM r_modifier_options WHERE is_deleted = 0 AND is_active = 1 ORDER BY sort, name`).all();
  const links = db.prepare(`SELECT * FROM r_item_modifier_groups WHERE is_deleted = 0 ORDER BY sort`).all();
  return db.prepare(`SELECT * FROM r_categories WHERE is_deleted = 0 AND is_active = 1 ORDER BY sort, name`).all().map((c) => ({
    ...c,
    items: db.prepare(`SELECT * FROM r_items WHERE category_id = ? AND is_deleted = 0 AND is_active = 1 ORDER BY sort, name`).all(c.id).map((i) => ({
      ...i,
      available: Boolean(i.is_available) && !soldOut.has(i.id),
      sold_out_today: soldOut.has(i.id),
      modifier_groups: links.filter((l) => l.menu_item_id === i.id).map((l) => groups.find((g) => g.id === l.group_id)).filter(Boolean)
        .map((g) => ({ ...g, options: options.filter((o) => o.group_id === g.id).map((o) => ({ ...o, available: Boolean(o.is_available) })) })),
    })),
  }));
}

module.exports.menuView = menuView;
