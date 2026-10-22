/*
 * The restaurant screens' only door into the hub: ONE channel, a fixed list of actions. A screen
 * cannot call anything that is not listed here, and every action runs with the permissions of the
 * person signed in on this till (the engine checks them again). Kitchen printing runs after every
 * action that may have queued a ticket.
 */
const engine = require('./engine');
const printing = require('./printing');
const store = require('./store');
const screens = require('./screens');
const lanServer = require('./server');

let lan = null; // the kitchen-screen server (createLan), once registered

function contextFor(profile) {
  if (!profile || !profile.username) throw new store.RestaurantError('not_signed_in', 'Sign in first.', 401);
  return {
    user: profile.username || '',
    role: profile.role || 'seller',
    isOwner: Boolean(profile.is_owner || profile.is_ceo),
    capabilities: profile.capabilities || {},
  };
}

const ACTIONS = {
  // reads
  menu: (db) => engine.menuView(db),
  tables: (db) => engine.tablesView(db),
  openOrders: (db) => db.prepare(`SELECT id FROM r_orders WHERE status = 'open' ORDER BY opened_at`).all().map((o) => engine.orderView(db, o.id)),
  order: (db, ctx, key, orderId) => engine.orderView(db, orderId),
  kitchen: (db, ctx, key, stationIds) => engine.kitchenView(db, stationIds || store.activeStationIds(db)),
  events: (db, ctx, key, afterSeq) => store.eventsAfter(db, afterSeq || 0),
  printers: (db) => printing.listStationPrinters(db),
  printProblems: (db) => printing.problems(db),
  // changes (T1–T13)
  openOrder: (db, ctx, key, input) => engine.openOrder(db, input, ctx, key),
  addItems: (db, ctx, key, orderId, lines) => engine.addItems(db, orderId, lines, ctx, key),
  changeItem: (db, ctx, key, itemId, change) => engine.changePendingItem(db, itemId, change, ctx, key),
  removeItem: (db, ctx, key, itemId) => engine.removePendingItem(db, itemId, ctx, key),
  send: (db, ctx, key, orderId) => engine.sendToKitchen(db, orderId, ctx, key),
  ticketItemState: (db, ctx, key, ticketItemId, change) => engine.setTicketItemState(db, ticketItemId, change, ctx, key),
  bump: (db, ctx, key, ticketId) => engine.bumpTicket(db, ticketId, ctx, key),
  serve: (db, ctx, key, itemId) => engine.serveItem(db, itemId, ctx, key),
  voidItem: (db, ctx, key, itemId, input) => engine.voidItem(db, itemId, input, ctx, key),
  moveTable: (db, ctx, key, orderId, tableId) => engine.moveTable(db, orderId, tableId, ctx, key),
  printBill: (db, ctx, key, orderId) => engine.printBill(db, orderId, ctx, key),
  discount: (db, ctx, key, orderId, input) => engine.applyDiscount(db, orderId, input, ctx, key),
  pay: (db, ctx, key, orderId, input) => engine.takePayment(db, orderId, input, ctx, key),
  cancel: (db, ctx, key, orderId, input) => engine.cancelOrder(db, orderId, input, ctx, key),
  soldOut: (db, ctx, key, menuItemId, value) => engine.setSoldOut(db, menuItemId, value, ctx, key),
  reprint: (db, ctx, key, ticketId) => printing.reprint(db, ticketId, ctx, key),
  setStationPrinter: (db, ctx, key, stationId, deviceName) => printing.setStationPrinter(db, stationId, deviceName, ctx),
  // kitchen screens on the Wi-Fi (owner / manager)
  screens: (db) => ({ screens: screens.listScreens(db), lan: lan ? lan.status() : null }),
  addScreen: (db, ctx, key, input) => ({ ...screens.createPairingCode(db, input, ctx), lan: lan ? lan.status() : null }),
  removeScreen: (db, ctx, key, screenId) => screens.revokeScreen(db, screenId, ctx),
};

/** Print one kitchen ticket silently to a named Windows printer, through a hidden window. */
function makePrintHtml(BrowserWindow) {
  return (html, deviceName) => new Promise((resolve) => {
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    let settled = false;
    const done = (result) => { if (settled) return; settled = true; clearTimeout(timer); if (!win.isDestroyed()) win.destroy(); resolve(result); };
    const timer = setTimeout(() => done({ ok: false, reason: 'The printer did not answer within 20 seconds.' }), 20_000);
    win.webContents.once('did-finish-load', () => {
      win.webContents.print({ silent: true, deviceName, printBackground: true, margins: { marginType: 'none' } },
        (ok, reason) => done({ ok, reason: ok ? null : reason }));
    });
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((e) => done({ ok: false, reason: e.message }));
  });
}

function register({ ipcMain, database, auth, BrowserWindow, appVersion = '', cloudStatus = () => null, onChange = () => {}, lanOptions = {} }) {
  printing.recoverAfterRestart(database); // never reprint blindly after a power cut
  store.prune(database);
  const printHtml = makePrintHtml(BrowserWindow);
  const kickPrinting = () => printing.runQueue(database, printHtml).catch((e) => console.warn('[restaurant] printing stopped:', e.message));
  if (lan) lan.stop();
  lan = lanServer.createLan(database, { appVersion, cloudStatus, ...lanOptions });

  ipcMain.handle('restaurant:call', (_e, action, key, ...args) => {
    // `status` tells the screens whether this till is the hub (and why not), so they can say so.
    if (action === 'status') return { ok: true, data: store.hubStatus(database) };
    const fn = ACTIONS[action];
    if (!fn) return { ok: false, error: { code: 'unknown_action', message: 'Unknown action.' } };
    try {
      const ctx = contextFor(auth.getUserProfile(database));
      store.assertHub(database); // only the branch's hub runs the restaurant
      const data = fn(database, ctx, key || null, ...args);
      kickPrinting();
      lan.notify();  // kitchen screens hear about it at once
      try { onChange(); } catch {} // e.g. upload a closed order straight away
      return { ok: true, data };
    } catch (e) {
      if (e instanceof store.RestaurantError) {
        return { ok: false, error: { code: e.code, message: e.message, status: e.status, current: e.current, capability: e.capability } };
      }
      console.error('[restaurant]', action, e);
      return { ok: false, error: { code: 'unexpected', message: 'Something went wrong. Nothing was changed.' } };
    }
  });
  if (store.hubStatus(database).is_hub) kickPrinting();
  return { lan };
}

module.exports = { register, contextFor, ACTIONS, makePrintHtml };
