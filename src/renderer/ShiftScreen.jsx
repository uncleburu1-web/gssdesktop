import { useEffect, useState } from 'react';
import { money, fmtDateTime, posErrorMessage, methodLabel } from './format.js';
import { ZReportView, ZReportPrint } from './ZReport.jsx';

/**
 * A cashier's shift: open it with a cash float, take sales, move cash in or out, then close it by
 * counting the drawer. Closing is a BLIND count: the cashier is asked for the cash they counted
 * BEFORE being shown what the books say should be there, so the count can't be nudged to match.
 * The result is a frozen Z-report that can be printed.
 *
 * Selling does not require an open shift (a till must never refuse a paying customer), but only
 * sales made inside a shift appear in a Z-report.
 */
export default function ShiftScreen({ refreshKey, profile }) {
  const [current, setCurrent] = useState(null);     // live numbers for MY open shift, or null
  const [history, setHistory] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null);        // 'open' | 'paid_in' | 'paid_out' | 'close'
  const [form, setForm] = useState({ amount: '', reason: '', notes: '' });
  const [viewing, setViewing] = useState(null);      // a report on screen (and ready to print)
  const [busy, setBusy] = useState(false);

  function refresh() {
    Promise.all([window.pos.currentShift(), window.pos.listShifts()])
      .then(([live, list]) => { setCurrent(live); setHistory(list); setLoaded(true); })
      .catch((err) => { setError(posErrorMessage(err, 'Could not load shifts.')); setLoaded(true); });
  }
  useEffect(refresh, [refreshKey]);

  const openDialog = (kind) => { setError(''); setForm({ amount: '', reason: '', notes: '' }); setDialog(kind); };

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (dialog === 'open') {
        await window.pos.openShift({ openingFloat: form.amount === '' ? '' : Number(form.amount) });
        setDialog(null);
      } else if (dialog === 'paid_in' || dialog === 'paid_out') {
        await window.pos.cashMovement({ kind: dialog, amount: Number(form.amount), reason: form.reason });
        setDialog(null);
      } else if (dialog === 'close') {
        const report = await window.pos.closeShift({ countedCash: form.amount === '' ? '' : Number(form.amount), notes: form.notes });
        setDialog(null);
        setViewing(report);
      }
      refresh();
    } catch (err) {
      setError(posErrorMessage(err, 'That did not work.'));
    } finally {
      setBusy(false);
    }
  }

  async function view(id) {
    try { setViewing(await window.pos.getShiftReport(id)); } catch (err) { setError(posErrorMessage(err, 'Could not open that report.')); }
  }

  const titleFor = { open: 'Open shift', paid_in: 'Cash in', paid_out: 'Cash out', close: 'Close shift' };

  return (
    <div>
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>My shift</h3>
        {!loaded && <div className="empty">Loading…</div>}
        {loaded && !current && (
          <>
            <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
              No shift is open. You can still sell, but those sales won't appear in any Z-report.
            </p>
            <button className="btn" onClick={() => openDialog('open')}>Open shift</button>
          </>
        )}
        {loaded && current && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 12 }}>
              <Stat label="Opened" value={fmtDateTime(current.shift.opened_at)} />
              <Stat label="Opening float" value={money(current.cash.opening_float)} />
              <Stat label="Sales made" value={String(current.sales.count)} />
              <Stat label="Gross sales" value={money(current.sales.gross)} />
              {['cash', 'transfer', 'pos'].map((m) => <Stat key={m} label={`${methodLabel(m)} received`} value={money(current.payments.by_method[m])} />)}
            </div>
            {current.cash_movements && current.cash_movements.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 4 }}>Cash in / out this shift</div>
                {current.cash_movements.map((c, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '2px 0' }}>
                    <span>{fmtDateTime(c.created_at)} · {c.kind === 'paid_in' ? 'In' : 'Out'} · {c.reason}</span>
                    <span className="num" style={{ color: c.kind === 'paid_out' ? 'var(--danger)' : 'var(--good)' }}>{c.kind === 'paid_out' ? '-' : '+'}{money(c.amount)}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, marginTop: 4 }}>
                  <span>Expected in drawer now</span><span className="num">{money(current.cash.expected)}</span>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn ghost" onClick={() => openDialog('paid_in')}>Cash in</button>
              <button className="btn ghost" onClick={() => openDialog('paid_out')}>Cash out</button>
              <button className="btn" onClick={() => openDialog('close')}>Close shift</button>
            </div>
          </>
        )}
        {error && !dialog && <div style={{ color: 'var(--danger)', marginTop: 10, fontSize: 13 }}>{error}</div>}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Closed shifts</h3>
        {history.filter((s) => s.status === 'closed').length === 0 ? <div className="empty">No closed shifts yet.</div> : (
          <table>
            <thead><tr><th>Z</th>{profile?.is_owner && <th>Cashier</th>}<th>Closed</th><th>Counted</th><th>Variance</th><th></th></tr></thead>
            <tbody>
              {history.filter((s) => s.status === 'closed').map((s) => (
                <tr key={s.id}>
                  <td className="mono">#{s.z_number}</td>
                  {profile?.is_owner && <td>{s.owner}</td>}
                  <td className="mono" style={{ fontSize: 12.5 }}>{fmtDateTime(s.closed_at)}</td>
                  <td className="num">{money(s.counted_cash)}</td>
                  <td className="num" style={{ color: s.variance === 0 ? 'var(--good)' : 'var(--danger)' }}>
                    {s.variance === 0 ? 'Balanced' : `${s.variance < 0 ? 'Short' : 'Over'} ${money(Math.abs(s.variance))}`}
                  </td>
                  <td className="row-actions"><button className="btn ghost small" onClick={() => view(s.id)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {dialog && (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{titleFor[dialog]}</h3>
            {dialog === 'close' && (
              <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: -8 }}>
                Count the cash in the drawer and enter it below. You'll see what the books expected afterwards.
              </p>
            )}
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="shift-amount">{dialog === 'open' ? 'Opening cash float (₦)' : dialog === 'close' ? 'Cash counted in the drawer (₦)' : 'Amount (₦)'}</label>
                <input id="shift-amount" required autoFocus type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </div>
              {(dialog === 'paid_in' || dialog === 'paid_out') && (
                <div className="field">
                  <label htmlFor="shift-reason">Reason</label>
                  <input id="shift-reason" required type="text" placeholder={dialog === 'paid_in' ? 'e.g. Owner top-up' : 'e.g. Bought sachet water'} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                </div>
              )}
              {dialog === 'close' && (
                <div className="field">
                  <label htmlFor="shift-notes">Notes (optional)</label>
                  <input id="shift-notes" type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
              )}
              {error && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setDialog(null)}>Cancel</button>
                <button type="submit" className="btn" disabled={busy}>{dialog === 'close' ? 'Close shift' : dialog === 'open' ? 'Open shift' : 'Record'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {viewing && (
        <div className="modal-backdrop" onClick={() => setViewing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <ZReportView report={viewing} />
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setViewing(null)}>Close</button>
              <button type="button" className="btn" onClick={() => window.pos.printReceipt()}>Print</button>
            </div>
          </div>
        </div>
      )}
      {viewing && <ZReportPrint report={viewing} shop={profile} />}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
      <div className="num" style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
