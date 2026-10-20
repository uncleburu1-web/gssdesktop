import { useEffect, useMemo, useState } from 'react';
import { money, methodLabel, posErrorMessage, usePaymentMethods } from './format.js';

/**
 * Take items back on a completed sale. Pick how many of each line come back and whether they can be
 * sold again (restock) or are damaged (written off), how the money goes back, and why. The refund
 * defaults to what those items were sold for (after their share of any discount) and can be lowered.
 */
export default function ReturnModal({ saleId, onClose, onDone }) {
  const methods = usePaymentMethods();
  const [sale, setSale] = useState(null);
  const [qty, setQty] = useState({});
  const [damaged, setDamaged] = useState({});
  const [method, setMethod] = useState('cash');
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.pos.getSale(saleId).then((s) => { setSale(s); setMethod(s.payment_method || 'cash'); })
      .catch((err) => setError(posErrorMessage(err, 'Could not open this sale.')));
  }, [saleId]);

  const left = (item) => item.quantity - ((sale && sale.returned_quantities && sale.returned_quantities[item.id]) || 0);
  const value = useMemo(() => {
    if (!sale) return 0;
    return Math.round(sale.items.reduce((t, i) => t + (Number(qty[i.id]) || 0) * (i.total / i.quantity), 0) * 100) / 100;
  }, [sale, qty]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const lines = sale.items.filter((i) => Number(qty[i.id]) > 0)
      .map((i) => ({ sale_item_id: i.id, quantity: Number(qty[i.id]), restock: !damaged[i.id] }));
    setBusy(true); setError('');
    try {
      const result = await window.pos.createReturn({ sale_id: saleId, lines, refund_method: method, reason, refund_amount: refund === '' ? null : Number(refund) });
      onDone(result);
    } catch (err) {
      setError(posErrorMessage(err, 'Could not record the return.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h3>Return items{sale ? ` — receipt ${sale.receipt_no || `#${sale.invoice_number}`}` : ''}</h3>
        {!sale ? <div className="empty">{error || 'Loading…'}</div> : (
          <form onSubmit={submit}>
            <table>
              <thead><tr><th>Item</th><th>Sold</th><th>Return</th><th>Damaged?</th></tr></thead>
              <tbody>
                {sale.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.item_name}<div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{money(i.total / i.quantity)} each</div></td>
                    <td className="num">{i.quantity}{left(i) < i.quantity ? ` (${i.quantity - left(i)} back)` : ''}</td>
                    <td><input type="number" min="0" max={left(i)} step="1" style={{ width: 70 }} disabled={left(i) <= 0}
                      value={qty[i.id] ?? ''} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /></td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" title="Damaged: write it off instead of putting it back in stock"
                        checked={Boolean(damaged[i.id])} onChange={(e) => setDamaged({ ...damaged, [i.id]: e.target.checked })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="field-row" style={{ marginTop: 12 }}>
              <div className="field">
                <label htmlFor="ret-method">Refund by</label>
                <select id="ret-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                  {methods.map((m) => <option key={m} value={m}>{methodLabel(m)}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ret-refund">Refund (₦) — up to {money(value)}</label>
                <input id="ret-refund" type="number" min="0" max={value} step="0.01" placeholder={String(value)}
                  value={refund} onChange={(e) => setRefund(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="ret-reason">Reason (required)</label>
              <input id="ret-reason" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong size, customer changed mind" />
            </div>
            {error && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn" disabled={busy || value <= 0 || !reason.trim()}>
                {busy ? 'Saving…' : `Refund ${money(refund === '' ? value : Number(refund))}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
