import { useEffect, useMemo, useState } from 'react';
import { money, posErrorMessage } from './format.js';
import { Icons } from './Icons.jsx';
import CashCalculator from './CashCalculator.jsx';
import Receipt from './Receipt.jsx';
import CustomerPicker from './CustomerPicker.jsx';
import { CATEGORY_LABELS } from './categories.js';

function newLine(product) {
  return {
    key: product ? `stock-${product.id}` : `custom-${Date.now()}-${Math.random()}`,
    product_id: product ? product.id : null,
    item_name: product ? product.name : '',
    category: product ? product.category : '',
    quantity: 1,
    unit_price: product ? Number(product.sell_price) : 0,
    unit_cost: product ? Number(product.cost_price) : 0,
    maxQty: product ? product.quantity : null,
  };
}

export default function PosScreen({ onSaleComplete, refreshKey, profile }) {
  const [catalog, setCatalog] = useState([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [cart, setCart] = useState([]);
  const [customerName, setCustomerName] = useState('');
  const [customer, setCustomer] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [installment, setInstallment] = useState(false);
  const [amountPaid, setAmountPaid] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [lastReceipt, setLastReceipt] = useState(null);
  const [cashReceived, setCashReceived] = useState('');
  const [lastCashInfo, setLastCashInfo] = useState({ received: 0, change: 0 });

  function loadCatalog() {
    window.pos.listProducts({}).then((rows) => {
      setCatalog(rows);
      setLoadingCatalog(false);
    });
  }

  useEffect(() => { loadCatalog(); }, [refreshKey]);

  const categories = useMemo(() => Array.from(new Set(catalog.map((i) => i.category).filter(Boolean))), [catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((i) => {
      if (category !== 'all' && i.category !== category) return false;
      if (q && !`${i.name} ${i.short_code || ''} ${i.barcode || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalog, category, search]);

  const subtotal = cart.reduce((sum, l) => sum + l.quantity * Number(l.unit_price || 0), 0);
  const cartCount = cart.reduce((n, l) => n + l.quantity, 0);
  const isCashDue = paymentMethod === 'cash' && !installment;
  const cashShort = isCashDue && Number(cashReceived || 0) < subtotal;

  // Every completed sale auto-prints a receipt: `lastReceipt` becomes a
  // new object each time charge() succeeds, so this fires once per sale.
  // The printable node (Receipt, rendered below) is invisible on screen
  // either way (theme.css) — it only needs to be in the DOM before
  // window.print() runs, which the rAF here waits one paint for.
  useEffect(() => {
    if (!lastReceipt) return;
    const id = requestAnimationFrame(() => window.print());
    return () => cancelAnimationFrame(id);
  }, [lastReceipt]);

  function addItem(product) {
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.product_id === product.id);
      if (idx >= 0) {
        const existing = prev[idx];
        if (existing.maxQty != null && existing.quantity >= existing.maxQty) return prev;
        const copy = [...prev];
        copy[idx] = { ...existing, quantity: existing.quantity + 1 };
        return copy;
      }
      return [...prev, newLine(product)];
    });
  }

  // A barcode scanner is just a keyboard that types fast and finishes
  // with Enter — so scanning is "type into the search box, hit Enter."
  // On Enter, an EXACT barcode match adds straight to cart and clears the
  // box (so the next scan doesn't have to fight leftover text); no match
  // just leaves the text search results showing, same as before.
  function handleSearchKeyDown(e) {
    if (e.key !== 'Enter') return;
    const code = search.trim();
    if (!code) return;
    const hit = catalog.find((i) => i.barcode && i.barcode === code);
    if (hit) {
      addItem(hit);
      setSearch('');
    }
  }

  function addCustom() {
    if (!customName.trim() || customPrice === '') return;
    setCart((prev) => [...prev, { ...newLine(null), item_name: customName.trim(), unit_price: Number(customPrice) }]);
    setCustomName(''); setCustomPrice(''); setCustomOpen(false);
  }

  function updateQty(key, delta) {
    setCart((prev) => prev.map((l) => {
      if (l.key !== key) return l;
      const next = l.quantity + delta;
      if (next <= 0) return null;
      if (l.maxQty != null && next > l.maxQty) return l;
      return { ...l, quantity: next };
    }).filter(Boolean));
  }

  function updatePrice(key, value) {
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, unit_price: value } : l)));
  }

  function removeLine(key) {
    setCart((prev) => prev.filter((l) => l.key !== key));
  }

  async function charge() {
    if (cart.length === 0 || submitting) return;
    if (cashShort) {
      setError('Amount received is less than the total due.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const payload = {
        customer_id: customer?.id || null,
        customer_name: customerName || 'Walk-in',
        payment_method: paymentMethod,
        status: installment ? 'outstanding' : 'completed',
        amount_paid: installment ? Number(amountPaid || 0) : undefined,
        items: cart.map((l) => ({
          product_id: l.product_id,
          item_name: l.item_name,
          category: l.category,
          quantity: l.quantity,
          unit_price: Number(l.unit_price),
          unit_cost: Number(l.unit_cost || 0),
        })),
      };
      const sale = await window.pos.createSale(payload);
      setLastCashInfo({
        received: isCashDue ? Number(cashReceived || 0) : sale.total,
        change: isCashDue ? Number(cashReceived || 0) - sale.total : 0,
      });
      setLastReceipt(sale); // triggers the auto-print effect above
      setCart([]);
      setCustomerName('');
      setCustomer(null);
      setInstallment(false);
      setAmountPaid('');
      setCashReceived('');
      loadCatalog();
      onSaleComplete?.();
    } catch (err) {
      setError(posErrorMessage(err, 'Could not complete this sale.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="pos-layout">
      <div className="pos-catalog">
        <div className="pos-search">
          <input
            placeholder="Search or scan barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            autoFocus
          />
        </div>
        <div className="pos-chips">
          <button className={`pos-chip ${category === 'all' ? 'active' : ''}`} onClick={() => setCategory('all')}>All</button>
          {categories.map((c) => (
            <button key={c} className={`pos-chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
              {CATEGORY_LABELS[c] || c}
            </button>
          ))}
        </div>

        {error && <div className="form-error">{error}</div>}
        {lastReceipt && (
          <div className="form-error" style={{ background: 'rgba(95,191,143,.12)', borderColor: 'var(--good)', color: 'var(--good)' }}>
            Sale complete — {money(lastReceipt.total)} ({lastReceipt.items.length} item{lastReceipt.items.length > 1 ? 's' : ''}).
            <button className="btn ghost small" style={{ marginLeft: 10 }} onClick={() => setLastReceipt(null)}>Dismiss</button>
          </div>
        )}

        <div className="pos-grid">
          <button className="pos-tile custom" onClick={() => setCustomOpen(true)}>
            {Icons.plus}
            <span style={{ fontSize: 12.5, fontWeight: 600, marginTop: 4 }}>Custom item / service</span>
          </button>
          {loadingCatalog ? (
            <div className="empty">Loading…</div>
          ) : filtered.map((product) => {
            const inCartQty = cart.find((l) => l.product_id === product.id)?.quantity || 0;
            const outOfStock = product.quantity <= 0;
            const atLimit = product.quantity != null && inCartQty >= product.quantity;
            return (
              <button
                key={product.id}
                className={`pos-tile ${product.quantity <= product.min_stock ? 'pos-tile-low' : ''}`}
                disabled={outOfStock || atLimit}
                onClick={() => addItem(product)}
              >
                <div className="pos-tile-name">{product.short_code || product.name}</div>
                <div className="pos-tile-stock">
                  {outOfStock ? 'Out of stock' : `${product.quantity} in stock`}
                  {inCartQty ? ` · ${inCartQty} in cart` : ''}
                </div>
                <div className="pos-tile-price num">{money(product.sell_price)}</div>
              </button>
            );
          })}
          {!loadingCatalog && filtered.length === 0 && (
            <div className="empty" style={{ gridColumn: '1 / -1' }}>No products match — add one in Products, or use a custom item.</div>
          )}
        </div>
      </div>

      <div className="cart-panel">
        <div className="cart-head">
          <h3>Cart ({cartCount})</h3>
          {cart.length > 0 && <button className="btn ghost small" onClick={() => setCart([])}>Clear</button>}
        </div>
        <div className="cart-items">
          {cart.length === 0 ? (
            <div className="cart-empty">Tap a product to add it to the cart.</div>
          ) : cart.map((l) => (
            <div className="cart-line" key={l.key}>
              <div className="cart-line-info">
                <div className="cart-line-name" title={l.item_name}>{l.item_name}</div>
                <div className="cart-line-price">
                  ₦<input type="number" value={l.unit_price} onChange={(e) => updatePrice(l.key, e.target.value)} /> each
                </div>
              </div>
              <div className="qty-stepper">
                <button type="button" onClick={() => updateQty(l.key, -1)}>{Icons.minus}</button>
                <span>{l.quantity}</span>
                <button type="button" onClick={() => updateQty(l.key, 1)}>{Icons.plus}</button>
              </div>
              <div className="cart-line-total num">{money(l.quantity * l.unit_price)}</div>
              <button className="cart-line-remove" onClick={() => removeLine(l.key)} aria-label="Remove">{Icons.x}</button>
            </div>
          ))}
        </div>
        <div className="cart-foot">
          <div className="customer-row">
            <CustomerPicker
              customer={customer}
              customerName={customerName}
              onChange={({ customer: c, customerName: n }) => { setCustomer(c); setCustomerName(n); }}
            />
          </div>
          <div className="pay-methods">
            {['cash', 'transfer', 'pos'].map((m) => (
              <button key={m} type="button" className={`pay-method ${paymentMethod === m ? 'active' : ''}`} onClick={() => setPaymentMethod(m)}>
                {m === 'pos' ? 'POS/Card' : m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
          <label className="installment-toggle">
            <input type="checkbox" checked={installment} onChange={(e) => setInstallment(e.target.checked)} />
            Customer is paying in installments
          </label>
          {installment && (
            <div className="field" style={{ marginBottom: 4 }}>
              <label>Amount paid now (₦)</label>
              <input type="number" min="0" max={subtotal} value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="0" />
            </div>
          )}
          <div className="cart-totals-row grand">
            <span>Total</span><span className="num">{money(subtotal)}</span>
          </div>
          {isCashDue && subtotal > 0 && (
            <CashCalculator due={subtotal} received={cashReceived} onChange={setCashReceived} />
          )}
          <button className="charge-btn" disabled={cart.length === 0 || submitting || cashShort} onClick={charge} style={{ marginTop: 10 }}>
            {submitting ? 'Charging…' : `Charge ${money(subtotal)}`}
          </button>
        </div>
      </div>

      <Receipt sale={lastReceipt} cashReceived={lastCashInfo.received} change={lastCashInfo.change} shop={profile} />

      {customOpen && (
        <div className="modal-backdrop" onClick={() => setCustomOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Custom item / service</h3>
            <div className="field">
              <label>Name</label>
              <input autoFocus value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="e.g. Screen repair labour" />
            </div>
            <div className="field">
              <label>Price (₦)</label>
              <input type="number" min="0" value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setCustomOpen(false)}>Cancel</button>
              <button type="button" className="btn" onClick={addCustom}>Add to cart</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
