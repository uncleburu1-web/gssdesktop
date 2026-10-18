# Desktop tests and checks

    npm test        # 64 tests; needs Node >= 22.5 (uses the built-in node:sqlite)

These run the REAL `src/main/db.js` and `src/main/sync.js`. `better-sqlite3` is swapped for a small shim over Node's
built-in SQLite (`better-sqlite3-shim.js`) because the native module is compiled for Electron's ABI and usually will not
load under plain Node. The cloud is a fake (`FakeCloud` in `helpers.js`) installed as global `fetch`, so outages, 5xx
responses, lost responses, 401s and rejections can be produced on demand. No network, no Electron needed.
Each test is named after the finding it guards.

## Browser checks (optional, `test/ui/*.ui.js`)
Drive the REAL React screens in headless Chromium against a mocked bridge. They need `playwright` (with a browser),
`esbuild`, `react` and `react-dom` resolvable from `NODE_PATH`:

    node test/ui/pos-cart-recovery.ui.js      # crash/restore, park, resume, no double-ringing
    node test/ui/sidebar-and-history.ui.js    # sync status messages, retry, sales-history paging
    node test/ui/split-and-shift.ui.js        # split payments, receipt, shift open/close, blind count, Z-report, print

## Upgrade dry-run (`tools/check-upgrade-on-copy.js`)
Before rolling this out, try the database upgrade on a COPY of a real till's database:

    node tools/check-upgrade-on-copy.js "C:\path\to\copy-of-your-till.db"

It never touches the file you give it; it prints PASS/FAIL for every thing that must not change (sales, money, stock,
sync queue) and what must now be true (every naira represented by a payment record). Copy the .db while the app is closed.
