import { money, fmtDateTime, methodLabel } from './format.js';

/**
 * The rows of a shift report, in the order a manager reads a Z-report. ONE list feeds both the
 * on-screen card and the printed slip, so the two can never disagree.
 */
function reportRows(r) {
  const rows = [
    ['Opened', fmtDateTime(r.shift.opened_at)],
    r.shift.closed_at ? ['Closed', fmtDateTime(r.shift.closed_at)] : null,
    ['Cashier', r.shift.owner],
    r.first_receipt ? ['Receipts', `${r.first_receipt} to ${r.last_receipt}`] : null,
    { divider: true },
    ['Sales made', String(r.sales.count)],
    ['Gross sales', money(r.sales.gross)],
    ['Discounts given', money(r.sales.discounts)],
    r.outstanding.count ? [`Still owed (${r.outstanding.count})`, money(r.outstanding.balance)] : null,
    r.voided.count ? [`Voided sales (${r.voided.count})`, money(r.voided.paid)] : null,
    { divider: true },
    ...['cash', 'transfer', 'pos'].map((m) => [`${methodLabel(m)} received`, money(r.payments.by_method[m])]),
    ['Total received', money(r.payments.total), true],
    { divider: true },
    ['Opening float', money(r.cash.opening_float)],
    ['Cash sales', money(r.cash.cash_sales)],
    r.cash.paid_in ? ['Cash paid in', money(r.cash.paid_in)] : null,
    r.cash.paid_out ? ['Cash paid out', `-${money(r.cash.paid_out)}`] : null,
    ['Expected in drawer', money(r.cash.expected), true],
    r.cash.counted !== null ? ['Counted', money(r.cash.counted)] : null,
    r.cash.variance !== null ? [r.cash.variance === 0 ? 'Balanced' : r.cash.variance < 0 ? 'SHORT by' : 'OVER by', money(Math.abs(r.cash.variance)), true] : null,
    r.shift.notes ? ['Notes', r.shift.notes] : null,
  ];
  return rows.filter(Boolean);
}

const title = (r) => (r.shift.z_number ? `Z-REPORT #${r.shift.z_number}` : 'SHIFT SO FAR (not closed)');

/** On-screen version. */
export function ZReportView({ report }) {
  return (
    <div className="zreport">
      <h3 style={{ marginBottom: 4 }}>{title(report)}</h3>
      {reportRows(report).map((row, i) => (row.divider
        ? <hr key={i} style={{ border: 0, borderTop: '1px solid var(--border)', margin: '8px 0' }} />
        : (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0', fontWeight: row[2] ? 700 : 400 }}>
            <span>{row[0]}</span><span className="num">{row[1]}</span>
          </div>
        )))}
    </div>
  );
}

/**
 * Printable version: rendered into `.receipt-print`, which is invisible on screen and the ONLY thing
 * visible when the till prints (see theme.css). Same print path as a sale receipt, so it goes to the
 * same thermal printer.
 */
export function ZReportPrint({ report, shop }) {
  if (!report) return null;
  return (
    <div className="receipt-print">
      <div className="receipt-center receipt-total">{shop?.shop_name || 'My Shop'}</div>
      <div className="receipt-center receipt-sub">{title(report)}</div>
      <div className="receipt-divider" />
      {reportRows(report).map((row, i) => (row.divider
        ? <div className="receipt-divider" key={i} />
        : <div className={`receipt-row ${row[2] ? 'receipt-total' : ''}`} key={i}><span>{row[0]}</span><span>{row[1]}</span></div>))}
      <div className="receipt-divider" />
      <div className="receipt-center receipt-sub">Signature: ____________________</div>
    </div>
  );
}
