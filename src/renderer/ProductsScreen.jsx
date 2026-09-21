import { useEffect, useState } from 'react';
import { money, posErrorMessage } from './format.js';
import { CATEGORY_LABELS, categoriesForBusinessType } from './categories.js';

export default function ProductsScreen({ refreshKey, isOwner, profile }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [stockOpen, setStockOpen] = useState(null); // product being restocked
  const [error, setError] = useState('');

  // Scoped to this till's business type (falls back to just "Other" if
  // the type is unrecognized/missing) — a clothing or general-retail
  // shop no longer gets offered "Laptop" here, and a pharmacy shop gets
  // its own Medicine/Tablet/... options instead of gadgets categories.
  const categories = categoriesForBusinessType(profile?.business_type);
  const [form, setForm] = useState({ name: '', category: 'other', sell_price: '', min_stock: 2, barcode: '' });
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
      });
      setForm({ name: '', category: 'other', sell_price: '', min_stock: 2, barcode: '' });
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
                <tr><th>Name</th><th>Barcode</th><th>Category</th><th>Stock</th><th>Cost price</th><th>Sell price</th>{isOwner && <th></th>}</tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="num">{p.barcode || '—'}</td>
                    <td>{CATEGORY_LABELS[p.category] || p.category}</td>
                    <td className="num" style={{ color: p.quantity <= p.min_stock ? 'var(--warn)' : undefined }}>{p.quantity}</td>
                    <td className="num">{money(p.cost_price)}</td>
                    <td className="num">{money(p.sell_price)}</td>
                    {isOwner && <td><button className="btn ghost small" onClick={() => setStockOpen(p)}>+ Stock</button></td>}
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
              <div className="field">
                <label>Sell price (₦)</label>
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
                  <label>Quantity received</label>
                  <input required autoFocus type="number" min="1" value={batchForm.quantity_received} onChange={(e) => setBatchForm({ ...batchForm, quantity_received: e.target.value })} />
                </div>
                <div className="field">
                  <label>Cost price (₦ per unit)</label>
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
    </div>
  );
}
