// Extra window.pos pieces for the app shell + sales history. Test-only; loaded after mock-pos.js.
(function () {
  window.__sync = { queue: { pending: 0, failed: 0 }, cloudSync: { state: 'ok', message: '' }, liveConnected: true, lastPushError: null };
  window.__historyCalls = [];
  const TOTAL_SALES = 250;
  Object.assign(window.pos, {
    isLoggedIn: async () => true,
    getProfile: async () => ({ username: 'alice', full_name: 'Alice', role: 'seller', is_owner: true, capabilities: {} }),
    logout: async () => {},
    onDataChanged: () => () => {},
    pendingSyncCount: async () => window.__sync.queue.pending,
    syncStatus: async () => ({ ...window.__sync, lastPullAt: null, lastPushError: window.__sync.lastPushError }),
    retryFailedSync: async () => {
      const n = window.__sync.queue.failed;
      window.__sync.queue = { pending: window.__sync.queue.pending + n, failed: 0 };
      window.__sync.lastPushError = null; window.__calls.push('retryFailedSync'); return n;
    },
    listSales: async ({ status, limit, offset }) => {
      window.__historyCalls.push({ status, limit, offset });
      const rows = [];
      for (let i = offset || 0; i < Math.min(TOTAL_SALES, (offset || 0) + (limit || TOTAL_SALES)); i += 1) {
        rows.push({ id: `s${i}`, date: new Date(Date.UTC(2026, 9, 1) - i * 60000).toISOString(), items: [{ quantity: 1, item_name: `Item ${i}` }], customer_name: 'Walk-in', total: 100, profit: 60, amount_paid: 100, balance_due: 0, status });
      }
      return rows;
    },
  });
  // ---- shifts: canned numbers, so the UI can be checked without re-implementing the accounting
  // (the real accounting is tested against the real database in test/shifts.test.js)
  window.__shiftState = { open: null, closed: [], z: 1, calls: [] };
  const EXPECTED = 6550;                                   // float 5000 + cash 1500 - paid out 150 + 200 paid in: a distinctive number
  const liveReport = (sh) => ({
    shift: { id: sh.id, owner: 'alice', status: sh.status, opened_at: sh.opened_at, closed_at: sh.closed_at || null, z_number: sh.z_number || null, notes: sh.notes || '' },
    sales: { count: 4, gross: 3000, discounts: 0 },
    payments: { total: 3000, by_method: { cash: 1500, transfer: 1000, pos: 500 } },
    cash: { opening_float: sh.opening_float, cash_sales: 1500, paid_in: 200, paid_out: 150, expected: EXPECTED, counted: null, variance: null },
    voided: { count: 0, paid: 0 }, outstanding: { count: 0, balance: 0 }, first_receipt: 'ABCDEF-000001', last_receipt: 'ABCDEF-000004',
  });
  Object.assign(window.pos, {
    openShift: async ({ openingFloat }) => {
      window.__shiftState.calls.push(['openShift', openingFloat]);
      if (openingFloat === '' || openingFloat < 0) throw new Error('Enter the opening cash float (zero or more).');
      window.__shiftState.open = { id: 'sh1', status: 'open', opened_at: new Date().toISOString(), opening_float: openingFloat };
      return window.__shiftState.open;
    },
    currentShift: async () => (window.__shiftState.open ? liveReport(window.__shiftState.open) : null),
    cashMovement: async (m) => { window.__shiftState.calls.push(['cashMovement', m]); return m; },
    closeShift: async ({ countedCash, notes }) => {
      window.__shiftState.calls.push(['closeShift', countedCash, notes]);
      if (countedCash === '' || countedCash < 0) throw new Error('Enter the cash you counted in the drawer (zero or more).');
      const sh = { ...window.__shiftState.open, status: 'closed', closed_at: new Date().toISOString(), z_number: window.__shiftState.z++, notes: notes || '' };
      const report = liveReport(sh);
      report.cash.counted = countedCash; report.cash.variance = Math.round((countedCash - EXPECTED) * 100) / 100;
      window.__shiftState.closed.unshift({ ...sh, report, counted_cash: countedCash, variance: report.cash.variance });
      window.__shiftState.open = null;
      return report;
    },
    listShifts: async () => window.__shiftState.closed.map((c) => ({ id: c.id + c.z_number, owner: 'alice', status: 'closed', opened_at: c.opened_at, closed_at: c.closed_at, opening_float: c.opening_float, counted_cash: c.counted_cash, expected_cash: EXPECTED, variance: c.variance, z_number: c.z_number })),
    getShiftReport: async (id) => (window.__shiftState.closed.find((c) => c.id + c.z_number === id) || {}).report,
  });
  // Make the 5-second status polling happen every 0.5s so the test doesn't sit around.
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => realSetInterval(fn, ms >= 1000 ? ms / 10 : ms, ...rest);
})();
