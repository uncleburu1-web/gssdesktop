import { useEffect, useMemo, useRef, useState } from 'react';
import { money, posErrorMessage, methodLabel, paymentsSummary, usePaymentMethods } from './format.js';
import { Icons } from './Icons.jsx';
import CashCalculator from './CashCalculator.jsx';
import SplitPaymentModal from './SplitPaymentModal.jsx';
import Receipt from './Receipt.jsx';
import CustomerPicker from './CustomerPicker.jsx';
import { CATEGORY_LABELS } from './categories.js';
import { bestDiscounts } from './promotions.js';

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
    by_weight: Boolean(product && product.sold_by_weight),
  };
}

const q3 = (n) => Math.round(Number(n) * 1000) / 1000;

/**
 * Scale labels: 13 digits starting with "2" = "2" + 5-digit product code (the product's barcode or short
 * code) + 5-digit weight in grams + check digit, the common format for supermarket scales. Returns
 * { product, kg } or null.
 */
export function readScaleLabel(code, catalog) {
  if (!/^2\d{12}$/.test(code)) return null;
  const plu = code.slice(1, 6);
  const grams = Number(code.slice(6, 11));
  const product = catalog.find((i) => i.sold_by_weight && (i.barcode === plu || i.short_code === plu || i.barcode === String(Number(plu)) || i.short_code === String(Number(plu))));
  if (!product || !(grams > 0)) return null;
  return { product, kg: q3(grams / 1000) };
}

export default function PosScreen({ onSaleComplete, refreshKey, profile }) {
  const [promotions, setPromotions] = useState([]);
  const paymentMethods = usePaymentMethods();
  const [catalog, setCatalog] = useState([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [cart, setCart] = useState([]);
  useEffect(() => { window.pos.promotions?.().then((p) => setPromotions(Array.isArray(p) ? p : [])).catch(() => {}); }, [refreshKey]);
  const [customerName, setCustomerName] = useState('');
  const [customer, setCustomer] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [installment, setInstallment] = useState(false);
  // "Split payment": one sale paid by several methods. null = not splitting (the ordinary one-method flow).
  const [splitPayments, setSplitPayments] = useState(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [amountPaid, setAmountPaid] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [lastReceipt, setLastReceipt] = useState(null);
  const [cashReceived, setCashReceived] = useState('');
  const [lastCashInfo, setLastCashInfo] = useState({ received: 0, change: 0 });
  // Unfinished-cart recovery. `restoredRef` stays false until the saved draft (if any) has been
  // looked at, so the empty starting cart can never overwrite it.
  const restoredRef = useRef(false);
  const [restoredNote, setRestoredNote] = useState(false);
  const [parked, setParked] = useState([]);
  const [parkedOpen, setParkedOpen] = useState(false);

  function loadCatalog() {
    window.pos.listProducts({}).then((rows) => {
      setCatalog(rows);
      setLoadingCatalog(false);
    });
  }

  useEffect(() => { loadCatalog(); }, [refreshKey]);

  // ---- unfinished carts: restore after a crash / power cut, autosave, park and resume ----------
  // Put a saved cart on screen. Prices and quantities stay as the cashier left them; only the
  // "can't sell more than we have" ceiling is refreshed from the current stock.
  function showCart(saved) {
    const stock = new Map(catalog.map((p) => [p.id, p.quantity]));
    setCart((saved.lines || []).map((l) => (l.product_id && stock.has(l.product_id) ? { ...l, maxQty: stock.get(l.product_id) } : l)));
    setCustomer(saved.customer || null);
    setCustomerName(saved.customerName || '');
  }
  const currentCart = () => ({ lines: cart, customer, customerName });
  function refreshParked() { window.pos.listParked().then(setParked).catch(() => {}); }

  useEffect(() => {
    if (loadingCatalog || restoredRef.current) return;
    window.pos.loadDraft().then((draft) => {
      if (draft && draft.lines && draft.lines.length > 0) { showCart(draft); setRestoredNote(true); }
    }).catch(() => {}).finally(() => { restoredRef.current = true; });
    refreshParked();
  }, [loadingCatalog]);

  // Saved shortly after every change, so even an abrupt power loss costs at most a fraction of a second.
  useEffect(() => {
    if (!restoredRef.current) return undefined;
    const id = setTimeout(() => { window.pos.saveDraft({ lines: cart, customer, customerName }).catch(() => {}); }, 400);
    return () => clearTimeout(id);
  }, [cart, customer, customerName]);

  async function parkCurrent() {
    try {
      await window.pos.parkCart(currentCart());
      setCart([]); setCustomer(null); setCustomerName(''); setRestoredNote(false);
      refreshParked();
    } catch (err) { setError(posErrorMessage(err, 'Could not park this cart.')); }
  }
  async function resumeCart(id) {
    try {
      await window.pos.saveDraft(currentCart());          // make sure an active cart is stored; it gets parked, not lost
      showCart(await window.pos.resumeParked(id));
      setParkedOpen(false); setRestoredNote(false);
      refreshParked();
    } catch (err) { setError(posErrorMessage(err, 'Could not resume that cart.')); refreshParked(); }
  }
  async function discardCart(id) {
    if (!confirm('Discard this parked cart?')) return;
    await window.pos.discardParked(id);
    refreshParked();
  }

  const categories = useMemo(() => Array.from(new Set(catalog.map((i) => i.category).filter(Boolean))), [catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((i) => {
      if (category !== 'all' && i.category !== category) return false;
      if (q && !`${i.name} ${i.short_code || ''} ${i.barcode || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalog, category, search]);

  const grossTotal = cart.reduce((sum, l) => sum + l.quantity * Number(l.unit_price || 0), 0);
  // Promotions the owner set up, applied the same way the cloud would (renderer/promotions.js).
  const promoById = useMemo(() => new Map(promotions.map((p) => [String(p.id), p])), [promotions]);
  const lineDiscounts = useMemo(() => bestDiscounts(cart, promotions, new Date()), [cart, promotions]);
  const discountTotal = Math.round(lineDiscounts.reduce((t, d) => t + d.discount, 0) * 100) / 100;
  // What the customer pays. Named `subtotal` because every payment control below already uses it.
  const subtotal = Math.round((grossTotal - discountTotal) * 100) / 100;
  const cartCount = cart.reduce((n, l) => n + (l.by_weight ? 1 : Number(l.quantity) || 0), 0); // a weighed line counts as one item
  const isSplit = splitPayments !== null;
  const isCashDue = paymentMethod === 'cash' && !installment && !isSplit;
  const cashShort = isCashDue && Number(cashReceived || 0) < subtotal;
  // A split is only valid for the total it was entered against: if the cart changes, drop it rather
  // than let a stale split be charged against a different amount.
  useEffect(() => {
    if (splitPayments && Math.abs(splitPayments.reduce((s, p) => s + p.amount, 0) - subtotal) > 0.005) setSplitPayments(null);
  }, [subtotal]);

  // Every completed sale auto-prints a receipt: `lastReceipt` becomes a
  // new object each time charge() succeeds, so this fires once per sale.
  // The printable node (Receipt, rendered below) is invisible on screen
  // either way (theme.css) — it only needs to be in the DOM before print
  // runs, which the rAF here waits one paint for. print:receipt (main.js)
  // replaces the old window.print(): once a printer is picked on the
  // Printer screen it prints silently straight to it; until then it falls
  // back to the same pick-a-printer dialog window.print() used to show.
  useEffect(() => {
    if (!lastReceipt) return;
    const id = requestAnimationFrame(() => { window.pos.printReceipt(); });
    return () => cancelAnimationFrame(id);
  }, [lastReceipt]);

  // A product sold by weight asks for the weight first (or takes it from a scale label).
  const [weighing, setWeighing] = useState(null); // { product, kg }
  function addWeighed(product, kg) {
    const qty = q3(kg);
    if (!(qty > 0)) return;
    if (product.quantity != null && qty > product.quantity) { setError(`Only ${product.quantity} kg of ${product.name} in stock.`); return; }
    setCart((prev) => [...prev, { ...newLine(product), key: `weigh-${product.id}-${Date.now()}`, quantity: qty }]);
  }

  function addItem(product) {
    if (product.sold_by_weight) { setError(''); setWeighing({ product, kg: '' }); return; }
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
      return;
    }
    const label = readScaleLabel(code, catalog);
    if (label) {
      addWeighed(label.product, label.kg);
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

  function updateWeight(key, value) {
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, quantity: value === '' ? '' : q3(value) } : l)));
  }

  function updatePrice(key, value) {
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, unit_price: value } : l)));
  }

  function removeLine(key) {
    setCart((prev) => prev.filter((l) => l.key !== key));
  }

  async function charge() {
    if (cart.length === 0 || submitting) return;
    if (cart.some((l) => !(Number(l.quantity) > 0))) {
      setError('Every line needs a quantity — enter the weight for weighed items.');
      return;
    }
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
        payment_method: isSplit ? splitPayments[0].method : paymentMethod,
        status: installment ? 'outstanding' : 'completed',
        amount_paid: installment ? Number(amountPaid || 0) : undefined,
        ...(isSplit ? { payments: splitPayments } : {}),
        items: cart.map((l, idx) => ({
          discount: lineDiscounts[idx].discount,
          promotion_id: lineDiscounts[idx].promotion_id,
          product_id: l.product_id,
          item_name: l.item_name,
          category: l.category,
          quantity: l.quantity,
          unit_price: Number(l.unit_price),
          unit_cost: Number(l.unit_cost || 0),
        })),
      };
      const sale = await window.pos.createSale(payload);
      const splitCash = isSplit ? splitPayments.find((p) => p.method === 'cash' && p.tendered) : null;
      setLastCashInfo({
        received: isCashDue ? Number(cashReceived || 0) : splitCash ? splitCash.tendered : sale.total,
        change: isCashDue ? Number(cashReceived || 0) - sale.total : splitCash ? splitCash.tendered - splitCash.amount : 0,
      });
      setLastReceipt(sale); // triggers the auto-print effect above
      setCart([]);
      setCustomerName('');
      setCustomer(null);
      setInstallment(false);
      setAmountPaid('');
      setCashReceived('');
      setSplitPayments(null);
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
        {lastReceipt && lastReceipt.items.some((i) => i.stock_shortfall > 0) && (
          // Surfaces the exact race this whole feature exists for: two
          // tills (or a till and the web) both sold the last of
          // something before either knew about the other's sale. This
          // till's own local batches ran out mid-sale — the customer
          // already has the item, so the sale still went through; this
          // is purely so whoever's on this till finds out right now
          // instead of only via a report days later.
          <div className="form-error" style={{ background: 'rgba(232,162,60,.12)', borderColor: 'var(--warn)', color: 'var(--warn)' }}>
            Sold more of an item than this till had tracked stock for — likely sold on another till or online
            at nearly the same time. Flagged for the owner; no action needed here.
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
          <div style={{ display: 'flex', gap: 6 }}>
            {parked.length > 0 && <button className="btn ghost small" onClick={() => setParkedOpen(true)}>Parked ({parked.length})</button>}
            {cart.length > 0 && <button className="btn ghost small" onClick={parkCurrent}>Park</button>}
            {cart.length > 0 && <button className="btn ghost small" onClick={() => setCart([])}>Clear</button>}
          </div>
        </div>
        {restoredNote && (
          <div style={{ fontSize: 12, padding: '6px 12px', color: 'var(--warn)' }}>
            Restored the sale you were in the middle of.
            <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={() => setRestoredNote(false)}>OK</button>
          </div>
        )}
        <div className="cart-items">
          {cart.length === 0 ? (
            <div className="cart-empty">Tap a product to add it to the cart.</div>
          ) : cart.map((l, idx) => (
            <div className="cart-line" key={l.key}>
              <div className="cart-line-info">
                <div className="cart-line-name" title={l.item_name}>{l.item_name}</div>
                <div className="cart-line-price">
                  ₦<input type="number" value={l.unit_price} onChange={(e) => updatePrice(l.key, e.target.value)} /> {l.by_weight ? 'per kg' : 'each'}
                </div>
              </div>
              {l.by_weight ? (
                <div className="qty-stepper" title="Weight in kg">
                  <input type="number" min="0.001" step="0.001" style={{ width: 70 }} value={l.quantity}
                    onChange={(e) => updateWeight(l.key, e.target.value)} /> kg
                </div>
              ) : (
                <div className="qty-stepper">
                  <button type="button" onClick={() => updateQty(l.key, -1)}>{Icons.minus}</button>
                  <span>{l.quantity}</span>
                  <button type="button" onClick={() => updateQty(l.key, 1)}>{Icons.plus}</button>
                </div>
              )}
              <div className="cart-line-total num">
                {money(l.quantity * l.unit_price - (lineDiscounts[idx]?.discount || 0))}
                {lineDiscounts[idx]?.discount > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--good)', fontWeight: 500 }} title={promoById.get(lineDiscounts[idx].promotion_id)?.name}>
                    {promoById.get(lineDiscounts[idx].promotion_id)?.name || 'Promotion'} −{money(lineDiscounts[idx].discount)}
                  </div>
                )}
              </div>
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
          {isSplit ? (
            <div className="split-summary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12.5, padding: '6px 0' }}>
              <span><b>Split:</b> {paymentsSummary(splitPayments)}</span>
              <span style={{ display: 'flex', gap: 4 }}>
                <button type="button" className="btn ghost small" onClick={() => setSplitOpen(true)}>Edit</button>
                <button type="button" className="btn ghost small" onClick={() => setSplitPayments(null)}>Clear</button>
              </span>
            </div>
          ) : (
            <div className="pay-methods">
              {paymentMethods.map((m) => (
                <button key={m} type="button" className={`pay-method ${paymentMethod === m ? 'active' : ''}`} onClick={() => setPaymentMethod(m)}>
                  {methodLabel(m)}
                </button>
              ))}
              <button type="button" className="pay-method" disabled={installment || subtotal <= 0} onClick={() => setSplitOpen(true)}>Split</button>
            </div>
          )}
          <label className="installment-toggle">
            <input type="checkbox" checked={installment} disabled={isSplit} onChange={(e) => setInstallment(e.target.checked)} />
            Customer is paying in installments
          </label>
          {installment && (
            <div className="field" style={{ marginBottom: 4 }}>
              <label>Amount paid now (₦)</label>
              <input type="number" min="0" max={subtotal} value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="0" />
            </div>
          )}
          {discountTotal > 0 && (
            <div className="cart-totals-row" style={{ color: 'var(--good)' }}>
              <span>Promotions</span><span className="num">−{money(discountTotal)}</span>
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

      {splitOpen && (
        <SplitPaymentModal
          due={subtotal}
          initial={splitPayments}
          onClose={() => setSplitOpen(false)}
          onConfirm={(payments) => { setSplitPayments(payments); setSplitOpen(false); }}
        />
      )}

      {parkedOpen && (
        <div className="modal-backdrop" onClick={() => setParkedOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Parked carts</h3>
            {parked.length === 0 ? <div className="empty">Nothing parked.</div> : parked.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div>{p.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{p.item_count} item{p.item_count === 1 ? '' : 's'} · <span className="num">{money(p.total)}</span></div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn small" onClick={() => resumeCart(p.id)}>Resume</button>
                  <button type="button" className="btn ghost small" onClick={() => discardCart(p.id)}>Discard</button>
                </div>
              </div>
            ))}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setParkedOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {weighing && (
        <div className="modal-backdrop" onClick={() => setWeighing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Weigh — {weighing.product.name}</h3>
            <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: -8 }}>
              {money(weighing.product.sell_price)} per kg · {weighing.product.quantity} kg in stock
            </p>
            <form onSubmit={(e) => { e.preventDefault(); addWeighed(weighing.product, weighing.kg); setWeighing(null); }}>
              <div className="field">
                <label htmlFor="weigh-kg">Weight (kg)</label>
                <input id="weigh-kg" required autoFocus type="number" min="0.001" step="0.001" value={weighing.kg}
                  onChange={(e) => setWeighing({ ...weighing, kg: e.target.value })} placeholder="e.g. 1.250" />
              </div>
              {Number(weighing.kg) > 0 && (
                <div style={{ fontSize: 14, marginBottom: 8 }}>
                  {Number(weighing.kg).toFixed(3)} kg = <b>{money(Math.round(Number(weighing.kg) * weighing.product.sell_price * 100) / 100)}</b>
                </div>
              )}
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setWeighing(null)}>Cancel</button>
                <button type="submit" className="btn">Add to cart</button>
              </div>
            </form>
          </div>
        </div>
      )}

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