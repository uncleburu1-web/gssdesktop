const path = require('path');

// Load desktop/.env FIRST — before auth.js/heartbeat.js/sync.js/backendLauncher.js
// are required below, since each of those reads process.env.BENCHLINE_API_URL
// once, at module-load time (`const API_BASE = process.env.BENCHLINE_API_URL || ...`).
// Without this, BENCHLINE_API_URL would only ever come from a manually-set shell
// env var, which is easy to forget on a real shop PC / packaged install.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { app, BrowserWindow, ipcMain } = require('electron');
const os = require('os');
const db = require('./db');
const auth = require('./auth');
const { startHeartbeat } = require('./heartbeat');
const { startSyncEngine } = require('./sync');
const { startLocalBackend, stopLocalBackend } = require('./backendLauncher');
const { startUpdateChecks } = require('./updater');

// One SQLite file per machine, in the OS's standard per-user app data
// folder — this is the desktop's entire operational database. Nothing
// about normal POS operation ever depends on anything else existing.
const DB_PATH = path.join(app.getPath('userData'), 'everyday-wine-store-pos.db');

let mainWindow;
let database;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer-dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  database = db.openDb(DB_PATH);
  const syncEngine = startSyncEngine(database, () => {
    // Tell whatever window is open right now that fresh data landed —
    // see sync.js's pullTick for why this is the piece that was missing.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pos:dataChanged');
    }
  });

  // --- IPC bridge: every one of these hits the LOCAL db only. ----------
  ipcMain.handle('pos:listProducts', (_e, params) => db.listProducts(database, params));
  ipcMain.handle('pos:createProduct', (_e, input) => {
    const result = db.createProduct(database, input);
    syncEngine.pushNow();
    return result;
  });
  ipcMain.handle('pos:listCustomers', (_e, params) => db.listCustomers(database, params));
  ipcMain.handle('pos:createCustomer', (_e, input) => {
    const result = db.createCustomer(database, input);
    syncEngine.pushNow();
    return result;
  });
  ipcMain.handle('pos:addStockBatch', (_e, input) => {
    const result = db.addStockBatch(database, input);
    syncEngine.pushNow();
    return result;
  });
  // Who may see every seller's sales, shifts and reports on this till: owners/managers/CEO, and any
  // role the owner allowed 'view_all_sales' in the Control Center (kept in the profile for offline).
  const seesEveryone = () => {
    const p = auth.getUserProfile(database);
    return Boolean(p.is_owner || (p.capabilities && p.capabilities.view_all_sales));
  };
  // Day report: everyone's day for those allowed; otherwise only the signed-in seller's own.
  ipcMain.handle('pos:dayReport', (_e, { date, seller = null } = {}) =>
    db.getDayReport(database, { date, seller: seesEveryone() ? (seller || null) : cartOwner() }));

  // Customer returns (stage 8): owners, and roles the owner allowed 'process_return'.
  ipcMain.handle('pos:createReturn', (_e, input) => {
    const p = auth.getUserProfile(database);
    if (!(p.is_owner || (p.capabilities && p.capabilities.process_return))) {
      const err = new Error("Your role can't take returns — ask an owner or manager.");
      err.code = 'forbidden';
      throw err;
    }
    const result = db.createReturn(database, input, cartOwner());
    syncEngine.pushNow();
    return result;
  });

  // Stock ledger (stage 4). Damage: anyone signed in, with a reason. A stock count: owners only;
  // the cloud checks the same thing again when the count is uploaded.
  ipcMain.handle('pos:recordDamage', (_e, input) => {
    const result = db.recordDamage(database, input);
    syncEngine.pushNow();
    return result;
  });
  ipcMain.handle('pos:recordStockCount', (_e, input) => {
    if (!auth.getUserProfile(database).is_owner) {
      const err = new Error('Only an owner can adjust stock after a count.');
      err.code = 'forbidden';
      throw err;
    }
    const result = db.recordStockCount(database, input);
    syncEngine.pushNow();
    return result;
  });
  ipcMain.handle('pos:listStockMovements', (_e, params = {}) => {
    const profile = auth.getUserProfile(database);
    // Sellers see the movements they recorded; owners see everything.
    return db.listStockMovements(database, { ...params, actor: seesEveryone() ? (params.actor || null) : (profile.username || '') });
  });
  // Unfinished carts belong to whoever is logged in on this till; the renderer never names the owner.
  const cartOwner = () => auth.getUserProfile(database).username || '';
  ipcMain.handle('pos:saveDraft', (_e, cart) => db.saveDraft(database, cartOwner(), cart));
  ipcMain.handle('pos:loadDraft', () => db.loadDraft(database, cartOwner()));
  ipcMain.handle('pos:parkCart', (_e, cart) => db.parkCart(database, cartOwner(), cart));
  ipcMain.handle('pos:listParked', () => db.listParked(database, cartOwner()));
  ipcMain.handle('pos:resumeParked', (_e, id) => db.resumeParked(database, cartOwner(), id));
  ipcMain.handle('pos:discardParked', (_e, id) => db.discardParked(database, cartOwner(), id));

  // Shifts belong to whoever is signed in; non-owners only ever see their own.
  ipcMain.handle('pos:openShift', (_e, { openingFloat }) => db.openShift(database, cartOwner(), openingFloat));
  ipcMain.handle('pos:currentShift', () => {
    const shift = db.getOpenShift(database, cartOwner());
    return shift ? db.getShiftReport(database, shift.id) : null;
  });
  ipcMain.handle('pos:cashMovement', (_e, movement) => db.addCashMovement(database, cartOwner(), movement));
  ipcMain.handle('pos:closeShift', (_e, args) => db.closeShift(database, cartOwner(), args));
  ipcMain.handle('pos:listShifts', () => db.listShifts(database, { owner: seesEveryone() ? null : cartOwner() }));
  ipcMain.handle('pos:getShiftReport', (_e, shiftId) => {
    const report = db.getShiftReport(database, shiftId);
    if (report && !seesEveryone() && report.shift.owner !== cartOwner()) {
      const err = new Error("You can only open your own shifts' reports.");
      err.code = 'forbidden';
      throw err;
    }
    return report;
  });

  ipcMain.handle('pos:createSale', (_e, input) => {
    const me = auth.getUserProfile(database);
    // Who rang it up is decided here, never by the screen: the signed-in user.
    const result = db.createSale(database)({ ...input, cart_owner: cartOwner(), staff_name: me.full_name || me.username || '' });
    syncEngine.pushNow(); // the whole point of this line — a sale should reach the cloud immediately, not up to 15s later
    return result;
  });
  ipcMain.handle('pos:deleteSale', (_e, saleId) => {
    const result = db.deleteSale(database)(saleId);
    syncEngine.pushNow();
    return result;
  });
  ipcMain.handle('pos:addPayment', (_e, { saleId, amount, method, reference }) => {
    const result = db.addPayment(database)(saleId, amount, { method, reference, owner: cartOwner() });
    syncEngine.pushNow();
    return result;
  });
  // Sellers see only the sales they made; owners and roles allowed to see every sale see all.
  ipcMain.handle('pos:listSales', (_e, params = {}) => db.listSales(database, { ...params, seller: seesEveryone() ? null : cartOwner() }));
  ipcMain.handle('pos:getSale', (_e, saleId) => {
    const sale = db.getSale(database, saleId);
    if (sale && !seesEveryone() && sale.seller !== cartOwner()) {
      const err = new Error('You can only open your own sales.');
      err.code = 'forbidden';
      throw err;
    }
    return sale;
  });
  ipcMain.handle('pos:pendingSyncCount', () =>
    database.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'pending'`).get().n
  );
  ipcMain.handle('pos:syncStatus', () => syncEngine.getStatus());
  // Puts every change the cloud rejected (or that gave up) back in line and tries again now.
  ipcMain.handle('pos:paymentMethods', () => db.paymentMethods(database));
  ipcMain.handle('pos:promotions', () => db.listPromotions(database));
  ipcMain.handle('pos:retryFailedSync', () => {
    const retried = db.retryFailedSync(database);
    if (retried > 0) db.recordAuditEvent(database, 'sync.retry', { summary: `Retried ${retried} change(s) that had failed to sync`, data: { retried } });
    syncEngine.pushNow();
    return retried;
  });
  ipcMain.handle('pos:login', async (_e, { username, password }) => {
    await auth.login(database, username, password);
    return { ok: true };
  });
  ipcMain.handle('pos:isLoggedIn', () => Boolean(auth.getAccessToken(database)));
  ipcMain.handle('pos:getProfile', () => auth.getUserProfile(database));
  // Lets LoginScreen.jsx know, BEFORE anyone submits the form, whether
  // this till has ever finished its one-time shop-settings download —
  // if not, this login is about to do that download, so it shows
  // "Setting up your account…" instead of a plain "Signing in…".
  ipcMain.handle('pos:hasLocalSetup', () => auth.hasShopSettings(database));
  ipcMain.handle('pos:logout', () => {
    auth.logout(database);
    return { ok: true };
  });

  // --- Printing ----------------------------------------------------------
  // Receipts print via THIS process's webContents.print(), not the
  // renderer's window.print() — only the main process can pass `silent`
  // plus a specific `deviceName`, which is what turns "sale complete -> a
  // print dialog pops up and someone has to click Print" into "sale
  // complete -> paper just comes out." Until a printer has actually been
  // picked (Printer nav screen), RECEIPT_PRINTER_KEY is unset, deviceName
  // stays '', and print:receipt falls back to the exact old behaviour —
  // the normal pick-a-printer-and-click-Print dialog — so a fresh install
  // never silently drops a receipt on the floor.
  const RECEIPT_PRINTER_KEY = 'receipt_printer_name';

  ipcMain.handle('printers:list', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return [];
    return mainWindow.webContents.getPrintersAsync();
  });
  ipcMain.handle('printers:getSelected', () => db.getSetting(database, RECEIPT_PRINTER_KEY) || '');
  ipcMain.handle('printers:setSelected', (_e, deviceName) => {
    db.setSetting(database, RECEIPT_PRINTER_KEY, deviceName || '');
    return { ok: true };
  });
  ipcMain.handle('print:receipt', () => new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) { resolve({ ok: false, reason: 'no-window' }); return; }
    const deviceName = db.getSetting(database, RECEIPT_PRINTER_KEY) || '';
    const printOptions = { printBackground: true, margins: { marginType: 'none' } };

    function printWithDialog() {
      mainWindow.webContents.print({ ...printOptions, silent: false }, (ok, reason) => {
        resolve({ ok, reason: ok ? null : reason });
      });
    }

    if (!deviceName) { printWithDialog(); return; } // never configured yet — behave exactly like the old window.print()

    mainWindow.webContents.print({ ...printOptions, silent: true, deviceName }, (ok, reason) => {
      if (ok) { resolve({ ok, reason: null }); return; }
      // Saved printer is off, unplugged, or was renamed/uninstalled —
      // rather than silently losing the receipt, fall back to the normal
      // pick-a-printer dialog once instead of just failing.
      console.warn(`[print] silent print to "${deviceName}" failed (${reason}) — falling back to the print dialog`);
      printWithDialog();
    });
  }));

  createWindow();
  // Passed as a getter, not the value itself, since a user can close and
  // reopen the window (see the app.on('activate') handler below) — the
  // updater's dialogs need whichever window is actually open right now.
  startUpdateChecks(() => mainWindow);

  // Local-testing convenience only — see backendLauncher.js. The window
  // is created immediately regardless; login just fails gracefully (same
  // as any other offline moment) until this finishes coming up, or
  // does nothing at all if a real remote backend URL is configured.
  startLocalBackend({
    onReady: () => console.log('[backend-launcher] backend is reachable'),
    onFail: (err) => console.warn('[backend-launcher] not running a local backend:', err.message),
  });

  // Background loops — see heartbeat.js and sync.js. Both are pure
  // "try, and quietly skip if offline" loops; neither can block or break
  // anything the cashier is doing at the till.
  // appVersion: the heartbeat used to fall back to a hard-coded '0.1.0', so every till reported
  // the same version to the dashboard no matter what was actually installed.
  startHeartbeat(database, {
    deviceName: os.hostname(),
    appVersion: app.getVersion(),
    // Stage 1b: while the live socket is up its pongs are the heartbeat; HTTP only fills the gaps.
    isLiveConnected: () => syncEngine.getStatus().liveConnected,
    queueStats: () => db.getSyncQueueStats(database),
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => stopLocalBackend());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});