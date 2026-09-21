import { useEffect, useState } from 'react';
import { money, fmtDateTime, posErrorMessage } from './format.js';

function ItemsSummary({ items }) {
  if (!items || items.length === 0) return '—';
  const first = items[0];
  const label = `${first.quantity}× ${first.item_name}`;
  return items.length > 1 ? `${label} +${items.length - 1} more` : label;
}

export default function SalesHistoryScreen({ refreshKey }) {
  const [tab, setTab] = useState('completed');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [payModal, setPayModal] = useState(null);
  const [payAmount, setPayAmount] = useState('');

  function load() {
    setLoading(true);
    window.pos.listSales({ status: tab }).then((data) => { setRows(data); setLoading(false); });
  }

  useEffect(() => { load(); }, [tab, refreshKey]);

  async function handleDelete(id) {
    if (!confirm('Delete this sale? Stock will be restored.')) return;
    await window.pos.deleteSale(id);
    load();
  }

  async function handlePaySubmit(e) {
    e.preventDefault();
    setError('');
    const amt = Number(payAmount);
    if (!amt || amt <= 0) return;
    try {
      await window.pos.addPayment(payModal.id, amt);
      setPayModal(null);
      load();
    } catch (err) {
      setError(posErrorMessage(err, 'Could not record this payment.'));
    }
  }

  return (
    <div className="section">
      <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="subtabs" style={{ margin: 0 }}>
          <button className={`subtab ${tab === 'completed' ? 'active' : ''}`} onClick={() => setTab('completed')}>Completed</button>
          <button className={`subtab ${tab === 'outstanding' ? 'active' : ''}`} onClick={() => setTab('outstanding')}>Outstanding</button>
        </div>
      </div>
      <div className="section-body">
        {error && <div className="form-error">{error}</div>}
        {loading ? (
          <div className="empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">
            {tab === 'completed' ? 'No completed sales yet.' : 'No outstanding balances — nobody owes you anything.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th><th>Items</th><th>Customer</th><th>Total</th>
                  {tab === 'outstanding' ? <><th>Paid</th><th>Balance</th></> : <th>Profit</th>}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td className="mono" style={{ fontSize: 12.5 }}>{fmtDateTime(s.date)}</td>
                    <td><ItemsSummary items={s.items} /></td>
                    <td>{s.customer_name || 'Walk-in'}</td>
                    <td className="num">{money(s.total)}</td>
                    {tab === 'outstanding' ? (
                      <>
                        <td className="num">{money(s.amount_paid)}</td>
                        <td className="num" style={{ color: 'var(--warn)' }}>{money(s.balance_due)}</td>
                      </>
                    ) : (
                      <td className="num" style={{ color: 'var(--good)' }}>{money(s.profit)}</td>
                    )}
                    <td className="row-actions">
                      {tab === 'outstanding' && (
                        <button className="btn small" onClick={() => { setPayModal(s); setPayAmount(''); }}>Pay</button>
                      )}
                      <button className="btn ghost small" onClick={() => handleDelete(s.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {payModal && (
        <div className="modal-backdrop" onClick={() => setPayModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Record a payment</h3>
            <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: -8 }}>
              {payModal.customer_name || 'Walk-in'} owes <span className="num" style={{ color: 'var(--warn)' }}>{money(payModal.balance_due)}</span>.
            </p>
            <form onSubmit={handlePaySubmit}>
              <div className="field">
                <label>Payment amount (₦)</label>
                <input required autoFocus type="number" min="1" max={payModal.balance_due} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setPayModal(null)}>Cancel</button>
                <button type="submit" className="btn">Record payment</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
