// The restaurant screens' only door into the hub: fixed actions, the signed-in person's permissions,
// plain-English errors, and kitchen printing after a send.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm } = require('./helpers');
const ipc = require('../src/main/restaurant/ipc');
const printing = require('../src/main/restaurant/printing');
const { hub, ID, owner } = require('./restaurant.helpers');

class FakeWindow {
  static printed = [];
  constructor() { this.listeners = {}; this.destroyed = false; const self = this;
    this.webContents = {
      once: (ev, fn) => { self.listeners[ev] = fn; },
      print: (opts, cb) => { FakeWindow.printed.push({ deviceName: opts.deviceName, silent: opts.silent, html: self.html }); cb(true, null); },
    };
  }
  loadURL(url) { this.html = decodeURIComponent(url.split(',').slice(1).join(',')); setImmediate(() => this.listeners['did-finish-load']()); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}

const lans = [];
function wire(db, profile) {
  let handler;
  const { lan } = ipc.register({ ipcMain: { handle: (ch, fn) => { assert.equal(ch, 'restaurant:call'); handler = fn; } }, database: db,
    auth: { getUserProfile: () => profile.current }, BrowserWindow: FakeWindow, lanOptions: { port: 0, host: '127.0.0.1' } });
  lans.push(lan);
  return (action, key, ...args) => handler(null, action, key, ...args);
}
test.afterEach(async () => { while (lans.length) await lans.pop().stop(); });

test('screens can call only the listed actions, as the signed-in person', async () => {
  const { db, cleanup } = hub();
  try {
    FakeWindow.printed = [];
    const profile = { current: { username: 'wale', role: 'waiter', is_owner: false, capabilities: { take_orders: true, send_to_kitchen: true } } };
    const call = wire(db, profile);
    assert.deepEqual(call('dropTables', null), { ok: false, error: { code: 'unknown_action', message: 'Unknown action.' } });

    const opened = call('openOrder', 'k1', { service_type: 'dine_in', table_id: ID.t1 });
    assert.equal(opened.ok, true);
    const again = call('openOrder', 'k1', { service_type: 'dine_in', table_id: ID.t1 });
    assert.equal(again.data.id, opened.data.id, 'a double tap opens one order');
    const clash = call('openOrder', null, { service_type: 'dine_in', table_id: ID.t1 });
    assert.deepEqual([clash.ok, clash.error.code, clash.error.message], [false, 'table_occupied', 'That table already has an open order.']);

    assert.equal(call('addItems', null, opened.data.id, [{ menu_item_id: ID.chapman, quantity: 2 }]).ok, true);
    const refused = call('pay', null, opened.data.id, { method: 'transfer' });
    assert.deepEqual([refused.ok, refused.error.code, refused.error.capability], [false, 'not_allowed', 'take_payment'], 'a waiter cannot take payment');

    printing.setStationPrinter(db, ID.bar, 'XP-80 Bar', owner);
    assert.equal(call('send', 's1', opened.data.id).ok, true);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(FakeWindow.printed.map((p) => [p.deviceName, p.silent]), [['XP-80 Bar', true]]);
    assert.match(FakeWindow.printed[0].html, /Chapman/);

    const menu = call('menu', null);
    assert.ok(menu.data.find((c) => c.id === ID.mains).items.find((i) => i.id === ID.jollof).modifier_groups.length === 2);
    assert.equal(call('tables', null).data.find((t) => t.id === ID.t1).status, 'occupied');
    assert.ok(call('events', null, 0).data.length > 0);
  } finally { cleanup(); }
});

test('bad input from a screen is answered plainly and changes nothing', () => {
  const { db, cleanup } = hub();
  try {
    const call = wire(db, { current: { username: 'ada', is_owner: true } });
    assert.deepEqual(call('order', null, undefined).error.code, 'not_found');
    assert.deepEqual(call('send', null, { not: 'an id' }).error.code, 'not_found');
    const crash = call('addItems', null, 'no-such-order', 'not-a-list');
    assert.equal(crash.ok, false);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM r_orders`).get().n, 0);
  } finally { cleanup(); }
});

test('only the branch hub runs the restaurant; anyone signed out is refused', () => {
  const profile = { current: { username: 'ada', is_owner: true } };
  for (const [opts, code] of [[{ hubDevice: 'another-till' }, 'not_the_hub'], [{ hubDevice: null }, 'no_hub'], [{ modules: ['retail'] }, 'module_disabled']]) {
    const { db, cleanup } = hub(opts);
    try {
      const call = wire(db, profile);
      const r = call('openOrder', null, { service_type: 'takeaway' });
      assert.deepEqual([r.ok, r.error.code, r.error.status], [false, code, 403], code);
      assert.equal(call('menu', null).error.code, code, 'reads too: a non-hub till would show empty tables');
      assert.equal(call('status', null).data.is_hub, false);
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM r_orders`).get().n, 0);
    } finally { cleanup(); }
  }
  const { db, cleanup } = hub();
  try {
    const call = wire(db, { current: null });
    assert.deepEqual([call('openOrder', null, { service_type: 'takeaway' }).error.code], ['not_signed_in']);
    assert.equal(call('status', null).data.is_hub, true);
  } finally { cleanup(); }
});
