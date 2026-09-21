import { useEffect, useState } from 'react';
import { money, posErrorMessage } from './format.js';

export default function CustomersScreen({ refreshKey }) {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);

  function load() {
    setLoading(true);
    window.pos.listCustomers({ search }).then((rows) => { setCustomers(rows); setLoading(false); });
  }

  useEffect(() => { load(); }, [search, refreshKey]);

  async function handleAdd(e) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await window.pos.createCustomer(form);
      setForm({ name: '', phone: '', email: '', address: '', notes: '' });
      setAddOpen(false);
      load();
    } catch (err) {
      setError(posErrorMessage(err, 'Could not add this customer.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="section">
      <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="page-sub" style={{ margin: 0 }}>Customers</div>
        <button className="btn small" onClick={() => setAddOpen(true)}>+ New customer</button>
      </div>
      <div className="section-body">
        {error && <div className="form-error">{error}</div>}
        <div className="field" style={{ maxWidth: 320, marginBottom: 12 }}>
          <input placeholder="Search name or phone…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {loading ? (
          <div className="empty">Loading…</div>
        ) : customers.length === 0 ? (
          <div className="empty">
            {search ? 'No customers match that search.' : 'No customers yet. Add one, or they get created automatically the first time you pick "New customer" on the Sell screen.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>Name</th><th>Phone</th><th>Email</th><th>Owes</th></tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="num">{c.phone || '—'}</td>
                    <td>{c.email || '—'}</td>
                    <td className="num" style={{ color: c.balance_due > 0 ? 'var(--warn)' : undefined }}>
                      {c.balance_due > 0 ? `${money(c.balance_due)} (${c.outstanding_sale_count})` : '—'}
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
            <h3>New customer</h3>
            <form onSubmit={handleAdd}>
              <div className="field">
                <label>Name</label>
                <input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Phone</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div className="field">
                  <label>Email (optional)</label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label>Address (optional)</label>
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="field">
                <label>Notes (optional)</label>
                <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. usually buys on credit, pays end of month" />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setAddOpen(false)}>Cancel</button>
                <button type="submit" className="btn" disabled={submitting}>{submitting ? 'Adding…' : 'Add customer'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
