import { useEffect } from 'react';
import { naira, SERVICE_LABEL } from './api.js';

/** The app's modal (theme.css .modal), closed by the backdrop or Escape. */
export function Modal({ title, onClose, children, width = 440 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function ErrorNote({ error }) {
  return error ? <div className="r-error" role="alert">{error}</div> : null;
}

const lineText = (i) => {
  const mods = (i.modifiers || []).map((m) => m.name);
  return mods.length ? `${i.name} (${mods.join(', ')})` : i.name;
};

/**
 * The customer's bill or receipt on the receipt printer: rendered into .receipt-print (the only thing
 * visible when the till prints, see theme.css) exactly like the supermarket receipt.
 */
export function BillPrint({ order, shop, kind = 'bill', change }) {
  if (!order || !order.bill) return null;
  const b = order.bill;
  const lines = order.items.filter((i) => i.quantity - i.voided_quantity > 0);
  const row = (left, right, strong) => (
    <div className={`receipt-row${strong ? ' receipt-total' : ''}`}><span>{left}</span><span>{right}</span></div>
  );
  return (
    <div className="receipt-print">
      <div className="receipt-center">
        <div className="receipt-shop">{shop?.shop_name || 'Restaurant'}</div>
        {(shop?.shop_address || shop?.shop_phone) && <div className="receipt-sub">{[shop?.shop_address, shop?.shop_phone].filter(Boolean).join(' · ')}</div>}
        <div className="receipt-total" style={{ margin: '4px 0' }}>{kind === 'receipt' ? 'RECEIPT' : 'BILL'}</div>
      </div>
      <div>Order {order.number} · {order.table_label ? `Table ${order.table_label}` : SERVICE_LABEL[order.service_type]}</div>
      <div className="receipt-sub">
        {new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
        {order.waiter ? ` · served by ${order.waiter}` : ''}
      </div>
      <div className="receipt-divider" />
      {lines.map((i) => (
        <div key={i.id}>{row(`${i.quantity - i.voided_quantity} × ${lineText(i)}`, naira((Number(i.unit_price) + Number(i.modifiers_price)) * (i.quantity - i.voided_quantity)))}</div>
      ))}
      <div className="receipt-divider" />
      {row('Subtotal', naira(b.subtotal))}
      {Number(b.discount) > 0 && row('Discount', `-${naira(b.discount)}`)}
      {b.charges.map((c) => (
        <div key={`${c.kind}-${c.name}`}>{row(`${c.name} ${Number(c.rate)}%${c.inclusive ? ' (included)' : ''}`, naira(c.amount))}</div>
      ))}
      <div className="receipt-divider" />
      {row('TOTAL', naira(b.total), true)}
      {b.payments.map((p) => <div key={p.id}>{row(`Paid (${p.method})`, naira(p.amount))}</div>)}
      {kind === 'receipt' && Number(change) > 0 && row('Change', naira(change))}
      {kind === 'bill' && Number(b.paid) < Number(b.total) && row('To pay', naira(Number(b.total) - Number(b.paid)), true)}
      <div className="receipt-divider" />
      <div className="receipt-center">Thank you</div>
      <div className="receipt-center receipt-sub">Software by Gavin's Software Solutions (GSS)</div>
    </div>
  );
}
