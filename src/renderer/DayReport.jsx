import { useEffect, useState } from 'react';
import { money, fmtDateTime, methodLabel, posErrorMessage } from './format.js';

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Rows shared by the screen and the printed slip, so they can never disagree. */
function reportRows(r) {
  const rows = [
    ['Day', r.date],
    ['Report for', r.scope === 'everyone' ? 'Everyone' : r.seller],
    ['Printed', fmtDateTime(r.generated_at)],
    { divider: true },
    ['Sales made', String(r.sales.count)],
    ['Items sold', String(r.sales.items_sold)],
    ['Gross sales', money(r.sales.gross), true],
    r.sales.discounts ? ['Discounts given', money(r.sales.discounts)] : null,
    r.sales.profit !== null ? ['Profit', money(r.sales.profit)] : null,
    r.outstanding.count ? [`Still owed (${r.outstanding.count})`, money(r.outstanding.balance)] : null,
    r.voided.count ? [`Voided sales (${r.voided.count})`, money(r.voided.paid)] : null,
    { divider: true, label: 'MONEY RECEIVED' },
    ...['cash', 'transfer', 'pos'].map((m) => [`${methodLabel(m)}`, money(r.payments.by_method[m])]),
    r.payments.by_method.mobile ? [methodLabel('mobile'), money(r.payments.by_method.mobile)] : null,
    r.payments.by_method.other ? ['Other', money(r.payments.by_method.other)] : null,
    ['Total received', money(r.payments.total), true],
    r.cash.paid_in ? ['Cash paid in', money(r.cash.paid_in)] : null,
    r.cash.paid_out ? ['Cash paid out', `-${money(r.cash.paid_out)}`] : null,
  ];
  if (r.cash.movements.length) {
    rows.push({ divider: true, label: 'CASH IN / OUT' });
    for (const c of r.cash.movements) {
      rows.push([`${time(c.created_at)} ${c.kind === 'paid_in' ? 'In' : 'Out'} · ${c.owner}: ${c.reason}`, `${c.kind === 'paid_out' ? '-' : ''}${money(c.amount)}`]);
    }
  }
  if (r.by_seller && r.by_seller.length) {
    rows.push({ divider: true, label: 'BY SELLER' });
    for (const s of r.by_seller) rows.push([`${s.seller} (${s.sales} sale${s.sales === 1 ? '' : 's'})`, money(s.total)]);
  }
  if (r.shifts.length) {
    rows.push({ divider: true, label: 'SHIFTS' });
    for (const s of r.shifts) {
      rows.push([`${s.owner} ${s.z_number ? `Z#${s.z_number}` : '(open)'}`,
        s.status === 'closed' ? (s.variance === 0 ? 'Balanced' : `${s.variance < 0 ? 'Short' : 'Over'} ${money(Math.abs(s.variance))}`) : 'Open']);
    }
  }
  if (r.stock_changes.length) {
    rows.push({ divider: true, label: 'STOCK WRITTEN OFF / COUNTED' });
    for (const m of r.stock_changes) {
      rows.push([`${m.product_name || 'Item'} — ${m.reason}${m.actor ? ` (${m.actor})` : ''}`, m.quantity > 0 ? `+${m.quantity}` : String(m.quantity)]);
    }
  }
  if (r.top_items.length) {
    rows.push({ divider: true, label: 'TOP ITEMS' });
    for (const it of r.top_items) rows.push([`${it.quantity} x ${it.name}`, money(it.total)]);
  }
  return rows.filter(Boolean);
}

export default function DayReportScreen({ profile, seesEveryone }) {
  const [date, setDate] = useState(localToday());
  const [seller, setSeller] = useState('');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    window.pos.dayReport({ date, seller: seller || null })
      .then(setReport)
      .catch((err) => { setReport(null); setError(posErrorMessage(err, 'Could not build the report.')); });
  }, [date, seller]);

  const rows = report ? reportRows(report) : [];
  return (
    <div>
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Day report</h3>
        <p style={{ color: 'var(--text-dim)', marginTop: -6, fontSize: 13 }}>
          {seesEveryone
            ? 'Everything that happened on this till that day, across every seller. Pick one seller to print just theirs.'
            : 'Your own sales, money taken and cash in/out for the day.'}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="date" value={date} max={localToday()} onChange={(e) => setDate(e.target.value)} />
          {seesEveryone && (
            <select value={seller} onChange={(e) => setSeller(e.target.value)}>
              <option value="">Everyone</option>
              {(report?.sellers || []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <button className="btn" disabled={!report} onClick={() => window.pos.printReceipt()}>Print</button>
        </div>
        {error && <div style={{ color: 'var(--danger)', marginTop: 10, fontSize: 13 }}>{error}</div>}
      </div>

      {report && (
        <div className="card zreport" style={{ padding: 16, maxWidth: 520 }}>
          {rows.map((row, i) => (row.divider
            ? <div key={i} style={{ borderTop: '1px solid var(--border)', margin: '10px 0 6px', paddingTop: 6, fontSize: 11, color: 'var(--text-dim)', letterSpacing: '.5px' }}>{row.label || ''}</div>
            : (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0', fontWeight: row[2] ? 700 : 400 }}>
                <span>{row[0]}</span><span className="num">{row[1]}</span>
              </div>
            )))}
        </div>
      )}

      {report && (
        <div className="receipt-print">
          <div className="receipt-center receipt-total">{profile?.shop_name || 'My Shop'}</div>
          <div className="receipt-center receipt-sub">DAY REPORT</div>
          <div className="receipt-divider" />
          {rows.map((row, i) => (row.divider
            ? <div key={i}><div className="receipt-divider" />{row.label && <div className="receipt-sub">{row.label}</div>}</div>
            : <div className={`receipt-row ${row[2] ? 'receipt-total' : ''}`} key={i}><span>{row[0]}</span><span>{row[1]}</span></div>))}
          <div className="receipt-divider" />
          <div className="receipt-center receipt-sub">Signature: ____________________</div>
        </div>
      )}
    </div>
  );
}
