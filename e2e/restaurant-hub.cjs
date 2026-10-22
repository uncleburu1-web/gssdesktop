/*
 * Restaurant, end to end, against a real server (gss `restaurant` branch) and a real hub till:
 *
 *   1. The owner switches the restaurant module on and sets the restaurant up through the cloud API.
 *   2. The till (signed in BEFORE the restaurant was switched on) learns it from the pull, pulls the
 *      set-up, and becomes the branch's hub; a second till in the branch is refused.
 *   3. With the server STOPPED (no internet): a full table-service order on the hub — open, order with
 *      modifiers, send (kitchen + bar), kitchen screen, serve, bill, cash payment, close.
 *   4. The hub's bill equals the cloud's Python engine on the same lines with the cloud's own rates.
 *   5. A price changed in the cloud mid-service does not change an open order; a new order gets it.
 *   6. The cashier's Z-report includes the restaurant takings.
 *
 *   E2E_SERVER_CMD=<start|stop script> E2E_PSQL='su postgres -c "psql -d <db> -tAc' \
 *   E2E_MANAGE='<command that runs manage.py shell -c>' node e2e/restaurant-hub.cjs
 * Needs a freshly seeded database (gssfrontend/e2e/seed.py).
 */
const D = require('path').resolve(__dirname, '..');
const SERVER = process.env.E2E_API_URL || 'http://127.0.0.1:8000/api';
const SERVER_CMD = process.env.E2E_SERVER_CMD;
if (!SERVER_CMD || !process.env.E2E_MANAGE) { console.error('Set E2E_SERVER_CMD and E2E_MANAGE.'); process.exit(2); }
require(D + '/test/_setup');
process.env.BENCHLINE_API_URL = SERVER;
const os = require('os'); const fs = require('fs'); const path = require('path');
const { execSync } = require('child_process');
const dbm = require(D + '/src/main/db'); const auth = require(D + '/src/main/auth'); const sync = require(D + '/src/main/sync');
const engine = require(D + '/src/main/restaurant/engine');
const rstore = require(D + '/src/main/restaurant/store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, label, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };

async function api(token, method, url, body, branch, retry = true) {
  let res;
  try {
    res = await fetch(`${SERVER}${url}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(branch ? { 'X-Branch-ID': branch } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // After the server restarts, the first request can land on a pooled connection to the old process.
    if (retry && e.cause && e.cause.code === 'UND_ERR_SOCKET') return api(token, method, url, body, branch, false);
    throw e;
  }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return data;
}
async function login(username) {
  const r = await fetch(`${SERVER}/auth/login/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'pass12345' }) });
  return (await r.json()).access;
}
const list = (d) => (Array.isArray(d) ? d : d.results);

(async () => {
  // ---- 0. A till signs in while the branch is still only a supermarket --------------------------
  const db = dbm.openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-')), 'pos.db'));
  await auth.login(db, 'coowner', 'pass12345');
  check(!JSON.parse(dbm.getSetting(db, 'shop_settings')).modules.includes('restaurant'), 'a supermarket till signs in (no restaurant yet)');
  const engineSync = sync.startSyncEngine(db, () => {});
  const settle = async () => { for (let i = 0; i < 3; i++) { await engineSync.pushNow(); await engineSync.pullNow(); await sleep(300); } };
  await settle();

  // ---- 1. Owner sets the restaurant up in the cloud --------------------------------------------
  const ceo = await login('ceo');
  const branches = list(await api(ceo, 'GET', '/branches/'));
  const store = branches.find((b) => b.name === 'E2E Store').id;
  // The owner makes E2E Store a restaurant by changing its kind of shop (owner's decision 13). A server
  // without kinds of shop ignores the field: switch the module on directly there.
  const changed = await api(ceo, 'PATCH', `/branches/${store}/`, { shop_type: 'restaurant' });
  const mods = changed.shop_type === 'restaurant'
    ? await api(ceo, 'GET', `/branches/${store}/modules/`)
    : await api(ceo, 'PUT', `/branches/${store}/modules/`, { modules: { restaurant: true } });
  check(mods.modules.restaurant && mods.modules.retail, `the owner makes the branch a restaurant (${changed.shop_type ? 'its kind of shop' : 'older server: the module'}; supermarket stays on)`);
  const post = (url, body) => api(ceo, 'POST', `/restaurant/${url}`, body, store);
  const kitchen = await post('stations/', { name: 'Kitchen', prints: true, shows_on_screen: true });
  const bar = await post('stations/', { name: 'Bar', prints: true });
  const mains = await post('menu/categories/', { name: 'Mains', station: kitchen.id });
  const drinks = await post('menu/categories/', { name: 'Drinks', station: bar.id });
  const jollof = await post('menu/items/', { category: mains.id, name: 'Jollof rice', price: '3500.00', tax_class: 'food' });
  const chapman = await post('menu/items/', { category: drinks.id, name: 'Chapman', price: '1500.00', tax_class: 'drink' });
  const size = await post('menu/modifier-groups/', { name: 'Size', min_select: 1, max_select: 1 });
  await post('menu/modifier-options/', { group: size.id, name: 'Regular', price_delta: '0' });
  const large = await post('menu/modifier-options/', { group: size.id, name: 'Large', price_delta: '500' });
  await post('menu/item-modifier-groups/', { menu_item: jollof.id, group: size.id });
  const hall = await post('areas/', { name: 'Hall' });
  const t1 = await post('tables/', { area: hall.id, label: 'T1', seats: 4 });
  const t2 = await post('tables/', { area: hall.id, label: 'T2', seats: 2 });
  const vat = await post('tax-rules/', { name: 'VAT', rate: '7.5', valid_from: '2026-01-01' });
  await post('tax-rules/activate/', { rule_ids: [vat.id], state: 'Lagos', vat_registered: true, treatment_confirmed: true });
  await api(ceo, 'PUT', '/restaurant/settings/', { service_charge_rate: '10', service_charge_types: ['dine_in'] }, store);
  check(true, 'menu, modifiers, tables, stations, VAT and service charge set up through the API');

  // ---- 2. The till pulls it and becomes the hub -------------------------------------------------
  await settle();
  check(JSON.parse(dbm.getSetting(db, 'shop_settings')).modules.includes('restaurant'), 'the till learns from the pull that its branch is now a restaurant (no new sign-in)');
  check(rstore.hubStatus(db).hub_device_id === null && (() => { try { rstore.assertHub(db); return false; } catch (e) { return e.code === 'no_hub'; } })(),
    'until the owner picks a hub, the till refuses restaurant work (no_hub)');
  const pulled = db.prepare(`SELECT (SELECT COUNT(*) FROM r_items) items, (SELECT COUNT(*) FROM r_tables) tables, (SELECT COUNT(*) FROM r_stations) stations,
                             (SELECT is_active FROM r_tax_rules) vat, (SELECT service_charge_rate FROM r_settings) service`).get();
  check(pulled.items === 2 && pulled.tables === 2 && pulled.stations === 2 && pulled.vat === 1 && Number(pulled.service) === 10,
    'the hub pulled the whole set-up', JSON.stringify({ ...pulled }));
  const hubSet = await api(ceo, 'PUT', '/restaurant/settings/hub/', { device_id: dbm.getSetting(db, 'device_id') }, store);
  check(hubSet.hub_device === dbm.getSetting(db, 'device_id'), 'the owner makes this till the hub');
  await settle();
  check(rstore.hubStatus(db).is_hub, 'the till learns it is the hub');
  // A second till in the same branch (another PC, signed in by a seller) must not take orders.
  const other = dbm.openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'till2-')), 'pos.db'));
  await auth.login(other, 'sade', 'pass12345');
  const otherSync = sync.startSyncEngine(other, () => {});
  for (let i = 0; i < 2; i++) { await otherSync.pullNow(); await sleep(300); }
  let refused = null; try { rstore.assertHub(other); } catch (e) { refused = e.code; }
  check(refused === 'not_the_hub' && db.prepare(`SELECT COUNT(*) n FROM r_items`).get().n === other.prepare(`SELECT COUNT(*) n FROM r_items`).get().n,
    'a second till in the branch has the menu but is refused as not the hub', refused);
  otherSync.stop();

  // ---- 3. Internet down: a full table-service order on the hub ----------------------------------
  execSync(`${SERVER_CMD} stop`, { stdio: 'ignore' });
  const owner = { user: 'coowner', isOwner: true };
  const screen = { user: 'kitchen-screen', isScreen: true, stationIds: [kitchen.id] };
  dbm.openShift(db, 'coowner', 2000);
  const order = engine.openOrder(db, { service_type: 'dine_in', table_id: t1.id, guests: 2 }, owner, 'e2e-open');
  engine.addItems(db, order.id, [{ menu_item_id: jollof.id, quantity: 2, modifiers: [large.id], notes: 'no pepper' }, { menu_item_id: chapman.id, quantity: 1 }], owner);
  const sent = engine.sendToKitchen(db, order.id, owner, 'e2e-send');
  const resent = engine.sendToKitchen(db, order.id, owner, 'e2e-send');
  check(sent.tickets.length === 2 && JSON.stringify(resent.tickets) === JSON.stringify(sent.tickets), 'two tickets (kitchen, bar); a retried send makes none extra');
  const card = engine.kitchenView(db, [kitchen.id]);
  check(card.length === 1 && card[0].items[0].name === 'Jollof rice', 'the kitchen screen shows only the kitchen ticket');
  engine.setTicketItemState(db, card[0].items[0].id, { to: 'preparing', version: card[0].items[0].version }, screen);
  engine.bumpTicket(db, card[0].id, screen);
  const barItem = engine.orderView(db, order.id).items.find((i) => i.menu_item_id === chapman.id).tickets[0];
  engine.setTicketItemState(db, barItem.ticket_item_id, { to: 'ready' }, owner);
  for (const i of engine.orderView(db, order.id).items) engine.serveItem(db, i.id, owner);
  const billed = engine.printBill(db, order.id, owner);
  // (3,500 + 500) x 2 + 1,500 = 9,500; service 10% = 950; VAT 7.5% of 9,500 = 712.50 -> 11,162.50
  check(billed.bill.total === '11162.50', 'bill worked out on the hub, offline', billed.bill.total);
  const paid = engine.takePayment(db, order.id, { method: 'cash', tendered: '12000' }, owner, 'e2e-pay');
  check(paid.order.status === 'closed' && paid.change === '837.50', 'paid in cash, change given, order closed, table free',
    `${paid.order.status} change ${paid.change}`);

  // ---- 4. Same bill from the cloud's Python engine with the cloud's own rates -------------------
  execSync(`${SERVER_CMD} start`, { stdio: 'ignore' });
  const cloudRules = list(await api(ceo, 'GET', '/restaurant/tax-rules/', undefined, store));
  const cloudSettings = await api(ceo, 'GET', '/restaurant/settings/', undefined, store);
  const v = engine.orderView(db, order.id);
  const input = {
    service_type: v.service_type, business_date: v.business_date, discount: null,
    lines: v.items.map((i) => ({ id: i.id, unit_price: i.unit_price, modifiers_price: i.modifiers_price, quantity: String(i.quantity), voided_quantity: String(i.voided_quantity), tax_class: i.tax_class })),
    service_charge: { rate: cloudSettings.service_charge_rate, service_types: cloudSettings.service_charge_types },
    tax_rules: cloudRules.map((r) => ({ id: r.id, name: r.name, rate: r.rate, inclusive: r.inclusive, tax_classes: r.tax_classes, applies_to_service_charge: r.applies_to_service_charge, valid_from: r.valid_from, valid_to: r.valid_to, is_active: r.is_active })),
  };
  const inputFile = path.join(os.tmpdir(), `bill-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  fs.chmodSync(inputFile, 0o644);
  const py = execSync(`${process.env.E2E_MANAGE} "import json; from restaurant.billing import compute_bill; print(json.dumps(compute_bill(json.load(open('${inputFile}')))))"`).toString().trim().split('\n').pop();
  const cloudBill = JSON.parse(py);
  const hubBill = { subtotal: v.bill.subtotal, discount: v.bill.discount, net: v.bill.net, total: v.bill.total,
    charges: v.bill.charges.map((c) => ({ kind: c.kind, tax_rule_id: c.tax_rule_id, name: c.name, rate: c.rate, inclusive: c.inclusive, base: c.base, amount: c.amount })) };
  check(JSON.stringify(cloudBill) === JSON.stringify({ subtotal: hubBill.subtotal, discount: hubBill.discount, net: hubBill.net, charges: hubBill.charges, total: hubBill.total }),
    'the cloud\'s Python engine gives the same bill, line for line', cloudBill.total);

  // ---- 5. A price change in the cloud mid-service --------------------------------------------
  const second = engine.openOrder(db, { service_type: 'takeaway' }, owner);
  engine.addItems(db, second.id, [{ menu_item_id: chapman.id }], owner);
  await api(ceo, 'PATCH', `/restaurant/menu/items/${chapman.id}/`, { price: '2000.00' }, store);
  await settle();
  const third = engine.openOrder(db, { service_type: 'takeaway' }, owner);
  engine.addItems(db, third.id, [{ menu_item_id: chapman.id }], owner);
  check(engine.orderView(db, second.id).items[0].unit_price === '1500.00' && engine.orderView(db, third.id).items[0].unit_price === '2000.00',
    'the open order keeps its price; a new order gets the new one');
  // The same for the service charge: changed in the cloud while a table is still eating.
  const eating = engine.openOrder(db, { service_type: 'dine_in', table_id: t2.id }, owner);
  engine.addItems(db, eating.id, [{ menu_item_id: chapman.id }], owner);
  await api(ceo, 'PUT', '/restaurant/settings/', { service_charge_rate: '15' }, store);
  await settle();
  const late = engine.openOrder(db, { service_type: 'dine_in', table_id: t1.id }, owner);
  engine.addItems(db, late.id, [{ menu_item_id: chapman.id }], owner);
  const rateOf = (o) => engine.printBill(db, o.id, owner).bill.charges.find((c) => c.kind === 'service_charge').rate;
  check(rateOf(eating) === '10.0000' && rateOf(late) === '15.0000', 'a service charge changed mid-service: the open table keeps 10%, the next one gets 15%',
    `${rateOf(eating)} / ${rateOf(late)}`);

  // ---- 5b. Audited actions while online ---------------------------------------------------------
  engine.setSoldOut(db, jollof.id, true, owner);
  require(D + '/src/main/restaurant/printing').reprint(db, db.prepare(`SELECT id FROM r_tickets LIMIT 1`).get().id, owner);
  await settle();
  const protocol = Number(dbm.getSetting(db, 'cloud_sync_protocol'));
  const failed = db.prepare(`SELECT COUNT(*) n FROM sync_queue WHERE status = 'failed'`).get().n;
  const waiting = db.prepare(`SELECT COUNT(*) n FROM r_audit WHERE queued_at IS NULL`).get().n;
  const pending = db.prepare(`SELECT COUNT(*) n FROM sync_queue WHERE status IN ('pending', 'failed')`).get().n;
  if (protocol < 6) {
    // An older cloud accepts only a few till audit actions: restaurant ones wait on the hub.
    check(failed === 0 && waiting >= 2, `cloud at protocol ${protocol}: audit entries wait on the hub, nothing fails to upload`, `failed ${failed}, kept ${waiting}`);
  } else {
    check(failed === 0 && waiting === 0 && pending === 0, `cloud at protocol ${protocol}: every audit entry uploaded, nothing failed or left over`,
      `failed ${failed}, kept ${waiting}, pending ${pending}`);
  }

  // ---- 6. The cashier's Z-report -------------------------------------------------------------
  const z = dbm.getShiftReport(db, dbm.getOpenShift(db, 'coowner').id);
  check(z.restaurant && z.restaurant.takings === 11162.5 && z.cash.expected === 2000 + 11162.5, 'the Z-report counts the restaurant cash',
    JSON.stringify(z.restaurant));

  // ---- 7. The finished order in the cloud ------------------------------------------------------
  if (protocol < 6) {
    check(db.prepare(`SELECT COUNT(*) n FROM sync_queue WHERE entity_type = 'order_doc'`).get().n === 0 && engine.orderView(db, order.id).queued_at === null,
      'the closed order waits on the hub until the cloud can take orders (protocol 6)');
  } else {
    const cloudOrder = await api(ceo, 'GET', `/restaurant/orders/${order.id}/`, undefined, store);
    check(cloudOrder.status === 'closed' && cloudOrder.bill.total === '11162.50' && cloudOrder.items.length === 2 && cloudOrder.tickets.length === 2,
      'the closed order (taken offline) reached the cloud with its bill, items and tickets', `${cloudOrder.number} ₦${cloudOrder.bill.total}`);
    const sale = await api(ceo, 'GET', `/sales/${cloudOrder.sale_id}/`, undefined, store);
    check(Number(sale.total) === 11162.5, 'it is also a Sale of the same amount, so the existing reports count it', String(sale.total));
    const docs = db.prepare(`SELECT COUNT(*) n FROM sync_queue WHERE entity_type = 'order_doc'`).get().n;
    const cloudOrders = await api(ceo, 'GET', `/restaurant/orders/?date=${cloudOrder.business_date}`, undefined, store);
    check(docs === 1 && cloudOrders.results.length === 1, 'uploaded exactly once', `queued ${docs}, in the cloud ${cloudOrders.results.length}`);
    const summary = await api(ceo, 'GET', `/reports/restaurant/summary/?date=${cloudOrder.business_date}`, undefined, store);
    check(summary.takings === '11162.50' && summary.service_charge === '950.00' && summary.taxes.length === 1 && summary.taxes[0].amount === '712.50',
      'the restaurant summary: takings, service charge and VAT from the frozen bill', JSON.stringify({ takings: summary.takings, taxes: summary.taxes }));
    const audits = await api(ceo, 'GET', `/audit/?action=restaurant.sold_out`, undefined, store);
    const auditRows = Array.isArray(audits) ? audits : audits.results;
    check(auditRows.some((a) => a.action === 'restaurant.sold_out'), 'the sold-out switch is in the cloud audit log');
  }

  engineSync.stop();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
