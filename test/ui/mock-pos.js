// A stand-in for the preload bridge (window.pos), persisted in localStorage so a page reload
// behaves like the app being killed and restarted: in-memory React state is gone, the "database"
// survives. It mirrors the SEMANTICS of the real db.js cart functions, which are tested for real
// in test/cart.recovery.test.js; this file exists only to exercise the React screen's logic.
(function () {
  const KEY = 'mock-till-db';
  const read = () => JSON.parse(localStorage.getItem(KEY) || '{"draft":null,"parked":[],"sales":[]}');
  const write = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  const sum = (cart) => cart.lines.reduce((t, l) => t + l.quantity * l.unit_price, 0);
  const count = (cart) => cart.lines.reduce((n, l) => n + l.quantity, 0);
  const summary = (p) => ({ id: p.id, label: p.label, item_count: count(p.cart), total: sum(p.cart) });
  const parkInto = (s, cart) => { const f = cart.lines[0]; s.parked.unshift({ id: `park-${Math.random().toString(36).slice(2)}`, label: f.item_name + (cart.lines.length > 1 ? ` +${cart.lines.length - 1} more` : ''), cart }); };
  window.__calls = [];
  const log = (name) => window.__calls.push(name);
  const products = [
    { id: 'p1', name: 'Cola', category: 'drinks', sell_price: '100.00', cost_price: 40, quantity: 10, min_stock: 2, short_code: '', barcode: null },
    { id: 'p2', name: 'Charger', category: 'phones', sell_price: '2500.00', cost_price: 1500, quantity: 3, min_stock: 1, short_code: '', barcode: null },
  ];
  window.pos = {
    listProducts: async () => products,
    listCustomers: async () => [],
    loadDraft: async () => { log('loadDraft'); return read().draft; },
    saveDraft: async (cart) => { log('saveDraft'); const s = read(); s.draft = cart.lines.length ? cart : null; write(s); return { saved: cart.lines.length > 0 }; },
    parkCart: async (cart) => { log('parkCart'); const s = read(); parkInto(s, cart); s.draft = null; write(s); return summary(s.parked[0]); },
    listParked: async () => read().parked.map(summary),
    resumeParked: async (id) => {
      log('resumeParked'); const s = read();
      const p = s.parked.find((x) => x.id === id); s.parked = s.parked.filter((x) => x.id !== id);
      if (s.draft && s.draft.lines.length) parkInto(s, s.draft);
      s.draft = p.cart; write(s); return p.cart;
    },
    discardParked: async (id) => { const s = read(); s.parked = s.parked.filter((x) => x.id !== id); write(s); return 1; },
    createSale: async (input) => {
      log('createSale'); const s = read(); s.draft = null; s.sales.push(input); write(s);
      const total = input.items.reduce((t, i) => t + i.quantity * i.unit_price, 0);
      // Mirrors db.js: split payments must add up to the total or the sale is refused.
      let payments = [{ id: 'p0', method: input.payment_method || 'cash', amount: total }];
      if (input.payments) {
        const entered = input.payments.reduce((t, p) => t + p.amount, 0);
        if (Math.abs(entered - total) > 0.005) throw new Error('Payments must add up to the total.');
        payments = input.payments.map((p, i) => ({ id: 'p' + i, ...p, change_given: p.tendered ? p.tendered - p.amount : 0 }));
      }
      return { id: `sale-${s.sales.length}`, invoice_number: s.sales.length, receipt_no: `ABCDEF-${String(s.sales.length).padStart(6, '0')}`, items: input.items.map((i) => ({ ...i, subtotal: i.quantity * i.unit_price, total: i.quantity * i.unit_price })), payments, total, amount_paid: total, date: new Date().toISOString(), customer_name: 'Walk-in', staff_name: 'alice', payment_method: payments[0].method, status: 'completed', balance_due: 0 };
    },
    printReceipt: async () => { log('printReceipt'); },
  };
})();
