import { useEffect, useState } from 'react';
import { money, posErrorMessage } from './format.js';
import { CATEGORY_LABELS, categoriesForBusinessType } from './categories.js';

export default function ProductsScreen({ refreshKey, isOwner, profile }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [stockOpen, setStockOpen] = useState(null); // product being restocked
  const [damageOpen, setDamageOpen] = useState(null); // product being written off
  const [countOpen, setCountOpen] = useState(null); // product being counted (owners)
  const [historyOpen, setHistoryOpen] = useState(null); // product whose stock history is shown
  const [history, setHistory] = useState([]);
  const [changeForm, setChangeForm] = useState({ quantity: '', reason: '' });
  const [error, setError] = useState('');

  // Scoped to this till's business type (falls back to just "Other" if
  // the type is unrecognized/missing) — a clothing or general-retail
  // shop no longer gets offered "Laptop" here, and a pharmacy shop gets
  // its own Medicine/Tablet/... options instead of gadgets categories.
  const categories = categoriesForBusinessType(profile?.business_type);
  const [form, setForm] = useState({ name: '', category: 'other', sell_price: '', min_stock: 2, barcode: '', sold_by_weight: false });
  const qtyText = (p, q) => (p && p.sold_by_weight ? `${Number(q).toFixed(3)} kg` : q);
  const qtyStep = (p) => (p && p.sold_by_weight ? '0.001' : '1');
  const [batchForm, setBatchForm] = useState({ quantity_received: '', cost_price: '', batch_number: '' });
  const [submitting, setSubmitting] = useState(false);

  function load() {
    setLoading(true);
    window.pos.listProducts({}).then((rows) => { setProducts(rows); setLoading(false); });
  }

  useEffect(() => { load(); }, [refreshKey]);

  async function handleAddProduct(e) {
    e.preventDefault();
    if (submitting) return; // a double-click/double-Enter fired this again before the first request finished
    setSubmitting(true);
    setError('');
    try {
      await window.pos.createProduct({
        name: form.name, category: form.category, barcode: form.barcode,
        sell_price: Number(form.sell_price || 0), min_stock: Number(form.min_stock || 0),
        sold_by_weight: form.sold_by_weight,
      });
      setForm({ name: '', category: 'other', sell_price: '', min_stock: 2, barcode: '', sold_by_weight: false });
      setAddOpen(false);
      load();
    } catch (err) {
      setError(posErrorMessage(err, 'Could not add this product.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddStock(e) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await window.pos.addStockBatch({
        product_id: stockOpen.id,
        quantity_received: Number(batchForm.quantity_received || 0),
        cost_price: Number(batchForm.cost_price || 0),
        batch_number: batchForm.batch_number,
      });
      setBatchForm({ quantity_received: '', cost_price: '', batch_number: '' });
      setStockOpen(null);
      load();
    } catch (err) {
      setError(posErrorMessage(err, 'Could not add stock.'));
    } finally {
      setSubmitting(false);
    }
  }

  function openChange(setter, product, quantity = '') {
    setError('');
    setChangeForm({ quantity, reason: '' });
    setter(product);
  }

  async function handleDamage(e) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await window.pos.recordDamage({ product_id: damageOpen.id, quantity: Number(changeForm.quantity), reason: changeForm.reason });
      setDamageOpen(null);
      load();
    } catch (err) {
      setError(posErrorMessage(err, 'Could not record the damage.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCount(e) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await window.pos.recordStockCount({ product_id: countOpen.id, counted_quantity: Number(changeForm.quantity), reason: changeForm.reason });
      setCountOpen(null);
      load();
    } catch (err) {
      setError(posErrorMessage(err, 'Could not save the count.'));
    } finally {
      setSubmitting(false);
    }
  }

  async function showHistory(product) {
    setHistoryOpen(product);
    setHistory([]);
    try {
      setHistory(await window.pos.listStockMovements({ productId: product.id }));
    } catch (err) {
      setError(posErrorMessage(err, 'Could not load the stock history.'));
    }
  }

  const KIND_LABEL = { damage: 'Damaged', adjustment: 'Count adjustment', repair_part: 'Used on service job', repair_part_return: 'Returned from service job', return: 'Customer return', transfer: 'Transfer' };

  return (
    <div className="section">
      <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="page-sub" style={{ margin: 0 }}>Products & stock</div>
        {isOwner && <button className="btn small" onClick={() => setAddOpen(true)}>+ New product</button>}
      </div>
      <div className="section-body">
        {error && <div className="form-error">{error}</div>}
        {loading ? (
          <div className="empty">Loading…</div>
        ) : products.length === 0 ? (
          <div className="empty">No products yet.{isOwner && ' Add your first one to start selling.'}</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>Name</th><th>Barcode</th><th>Category</th><th>Stock</th><th>Cost price</th><th>Sell price</th><th></th></tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="num">{p.barcode || '—'}</td>
                    <td>{CATEGORY_LABELS[p.category] || p.category}</td>
                    <td className="num" style={{ color: p.quantity <= p.min_stock ? 'var(--warn)' : undefined }}>{qtyText(p, p.quantity)}</td>
                    <td className="num">{money(p.cost_price)}</td>
                    <td className="num">{money(p.sell_price)}{p.sold_by_weight ? ' /kg' : ''}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {isOwner && <button className="btn ghost small" onClick={() => setStockOpen(p)}>+ Stock</button>}
                      <button className="btn ghost small" onClick={() => openChange(setDamageOpen, p)} disabled={!p.quantity}>Damage</button>
                      {isOwner && <button className="btn ghost small" onClick={() => openChange(setCountOpen, p, String(p.quantity))}>Count</button>}
                      <button className="btn ghost small" onClick={() => showHistory(p)}>History</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {addOpen && (
        <div className="modal-backdrop" onClick={() => setAddOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New product</h3>
            <form onSubmit={handleAddProduct}>
              <div className="field">
                <label>Name</label>
                <input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="field">
                <label>Barcode (optional — scan or type)</label>
                <input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} placeholder="Leave blank if this product has none" />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Category</label>
                  <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    {categories.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Low-stock alert at</label>
                  <input type="number" min="0" value={form.min_stock} onChange={(e) => setForm({ ...form, min_stock: e.target.value })} />
                </div>
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 10 }}>
                <input type="checkbox" checked={form.sold_by_weight} onChange={(e) => setForm({ ...form, sold_by_weight: e.target.checked })} />
                Sold by weight (kg) — the price below is per kg and the cashier enters the weight
              </label>
              <div className="field">
                <label>Sell price (₦{form.sold_by_weight ? ' per kg' : ''})</label>
                <input required type="number" min="0" value={form.sell_price} onChange={(e) => setForm({ ...form, sell_price: e.target.value })} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setAddOpen(false)}>Cancel</button>
                <button type="submit" className="btn" disabled={submitting}>{submitting ? 'Adding…' : 'Add product'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {stockOpen && (
        <div className="modal-backdrop" onClick={() => setStockOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add stock — {stockOpen.name}</h3>
            <form onSubmit={handleAddStock}>
              <div className="field-row">
                <div className="field">
                  <label>Quantity received{stockOpen.sold_by_weight ? ' (kg)' : ''}</label>
                  <input required autoFocus type="number" min={qtyStep(stockOpen)} step={qtyStep(stockOpen)} value={batchForm.quantity_received} onChange={(e) => setBatchForm({ ...batchForm, quantity_received: e.target.value })} />
                </div>
                <div className="field">
                  <label>Cost price (₦ per {stockOpen.sold_by_weight ? 'kg' : 'unit'})</label>
                  <input required type="number" min="0" value={batchForm.cost_price} onChange={(e) => setBatchForm({ ...batchForm, cost_price: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label>Batch / reference (optional)</label>
                <input value={batchForm.batch_number} onChange={(e) => setBatchForm({ ...batchForm, batch_number: e.target.value })} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setStockOpen(null)}>Cancel</button>
                <button type="submit" className="btn" disabled={submitting}>{submitting ? 'Adding…' : 'Add stock'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {damageOpen && (
        <div className="modal-backdrop" onClick={() => setDamageOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Record damage — {damageOpen.name}</h3>
            <p className="page-sub" style={{ marginTop: 0 }}>In stock: {qtyText(damageOpen, damageOpen.quantity)}. Damaged, expired or missing stock comes off now; the owner sees who recorded it and why.</p>
            <form onSubmit={handleDamage}>
              <div className="field">
                <label>Quantity damaged{damageOpen.sold_by_weight ? ' (kg)' : ''}</label>
                <input required autoFocus type="number" min={qtyStep(damageOpen)} step={qtyStep(damageOpen)} max={damageOpen.quantity} value={changeForm.quantity} onChange={(e) => setChangeForm({ ...changeForm, quantity: e.target.value })} />
              </div>
              <div className="field">
                <label>Reason (required)</label>
                <input required value={changeForm.reason} onChange={(e) => setChangeForm({ ...changeForm, reason: e.target.value })} placeholder="e.g. Bottles broke when the shelf fell" />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setDamageOpen(null)}>Cancel</button>
                <button type="submit" className="btn" disabled={submitting || !changeForm.reason.trim()}>{submitting ? 'Saving…' : 'Write off'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {countOpen && (
        <div className="modal-backdrop" onClick={() => setCountOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Stock count — {countOpen.name}</h3>
            <p className="page-sub" style={{ marginTop: 0 }}>The till says {qtyText(countOpen, countOpen.quantity)}. Enter what is physically on the shelf; the difference is recorded with your name and reason.</p>
            <form onSubmit={handleCount}>
              <div className="field">
                <label>Counted quantity{countOpen.sold_by_weight ? ' (kg)' : ''}</label>
                <input required autoFocus type="number" min="0" step={qtyStep(countOpen)} value={changeForm.quantity} onChange={(e) => setChangeForm({ ...changeForm, quantity: e.target.value })} />
              </div>
              <div className="field">
                <label>Reason (required)</label>
                <input required value={changeForm.reason} onChange={(e) => setChangeForm({ ...changeForm, reason: e.target.value })} placeholder="e.g. Month-end count" />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setCountOpen(null)}>Cancel</button>
                <button type="submit" className="btn" disabled={submitting || !changeForm.reason.trim()}>{submitting ? 'Saving…' : 'Save count'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="modal-backdrop" onClick={() => setHistoryOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <h3>Stock changes — {historyOpen.name}</h3>
            {history.length === 0 ? (
              <div className="empty">No damage or count adjustments recorded{isOwner ? '' : ' by you'}.</div>
            ) : (
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>When</th><th>What</th><th>Qty</th><th>Who</th><th>Reason</th></tr></thead>
                  <tbody>
                    {history.map((m) => (
                      <tr key={m.id}>
                        <td>{new Date(m.created_at).toLocaleString()}</td>
                        <td>{KIND_LABEL[m.kind] || m.kind}</td>
                        <td className="num">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
                        <td>{m.actor || '—'}</td>
                        <td>{m.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="modal-actions"><button className="btn ghost" onClick={() => setHistoryOpen(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
