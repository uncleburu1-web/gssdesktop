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
  ipcMain.handle('pos:createSale', (_e, input) => {
    const result = db.createSale(database)(input);
    syncEngine.pushNow(); // the whole point of this line — a sale should reach the cloud immediately, not up to 15s later
    return result;
  });
  ipcMain.handle('pos:deleteSale', (_e, saleId) => {
    const result = db.deleteSale(database)(saleId);
    syncEngine.pushNow();
    return result;
  });
  ipcMain.handle('pos:addPayment', (_e, { saleId, amount }) => {
    const result = db.addPayment(database)(saleId, amount);
    syncEngine.pushNow();
    return result;
  });
  ipcMain.handle('pos:listSales', (_e, params) => db.listSales(database, params));
  ipcMain.handle('pos:getSale', (_e, saleId) => db.getSale(database, saleId));
  ipcMain.handle('pos:pendingSyncCount', () =>
    database.prepare(`SELECT COUNT(*) AS n FROM sync_queue WHERE status = 'pending'`).get().n
  );
  ipcMain.handle('pos:syncStatus', () => syncEngine.getStatus());
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
  startHeartbeat(database, { deviceName: os.hostname() });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => stopLocalBackend());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
