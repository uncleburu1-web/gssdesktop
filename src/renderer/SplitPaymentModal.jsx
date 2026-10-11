import { useState } from 'react';
import { money, methodLabel } from './format.js';

const METHODS = ['cash', 'transfer', 'pos'];
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * "One sale, several ways of paying": the customer gives ₦30,000 cash, transfers ₦50,000 and taps a
 * card for ₦20,000. The cashier adds a line per method; the dialog keeps a running "remaining" so the
 * payments can only be confirmed once they add up to exactly what is due. (The database re-checks the
 * same rule, so this dialog is a convenience, never the only guard.)
 */
export default function SplitPaymentModal({ due, initial, onConfirm, onClose }) {
  const [lines, setLines] = useState(() => (initial && initial.length ? initial.map((p) => ({
    method: p.method, amount: String(p.amount), tendered: p.tendered ? String(p.tendered) : '', reference: p.reference || '',
  })) : []));

  const entered = round2(lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0));
  const remaining = round2(due - entered);
  const problems = [];
  lines.forEach((l, i) => {
    if (!(Number(l.amount) > 0)) problems.push(`Line ${i + 1} needs an amount.`);
    if (l.method === 'cash' && l.tendered !== '' && Number(l.tendered) < Number(l.amount)) problems.push(`Line ${i + 1}: cash handed over is less than the amount.`);
  });
  const canConfirm = lines.length > 0 && Math.abs(remaining) < 0.005 && problems.length === 0;

  const addLine = (method) => setLines((prev) => [...prev, { method, amount: remaining > 0 ? String(remaining) : '', tendered: '', reference: '' }]);
  const update = (i, patch) => setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const remove = (i) => setLines((prev) => prev.filter((_, idx) => idx !== i));

  function confirm() {
    onConfirm(lines.map((l) => ({
      method: l.method,
      amount: round2(l.amount),
      ...(l.method === 'cash' && l.tendered !== '' ? { tendered: round2(l.tendered) } : {}),
      ...(l.method !== 'cash' && l.reference.trim() ? { reference: l.reference.trim() } : {}),
    })));
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Split payment</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: -8 }}>
          Total due <span className="num"><b>{money(due)}</b></span>. Add a line for each way the customer pays.
        </p>

        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {METHODS.map((m) => (
            <button key={m} type="button" className="btn ghost small" onClick={() => addLine(m)}>+ {methodLabel(m)}</button>
          ))}
        </div>

        {lines.length === 0 && <div className="empty" style={{ padding: 12 }}>No payments added yet.</div>}
        {lines.map((l, i) => (
          <div className="split-line" key={i} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr auto', gap: 6, alignItems: 'center', marginBottom: 6 }}>
            <b>{methodLabel(l.method)}</b>
            <input aria-label={`Amount for line ${i + 1}`} type="number" min="0" step="0.01" placeholder="Amount" value={l.amount} onChange={(e) => update(i, { amount: e.target.value })} />
            {l.method === 'cash' ? (
              <input aria-label={`Cash handed over for line ${i + 1}`} type="number" min="0" step="0.01" placeholder="Handed over (optional)" value={l.tendered} onChange={(e) => update(i, { tendered: e.target.value })} />
            ) : (
              <input aria-label={`Reference for line ${i + 1}`} type="text" maxLength={64} placeholder="Reference (optional)" value={l.reference} onChange={(e) => update(i, { reference: e.target.value })} />
            )}
            <button type="button" className="btn ghost small" aria-label={`Remove line ${i + 1}`} onClick={() => remove(i)}>×</button>
          </div>
        ))}

        <div className="cart-totals-row grand" style={{ marginTop: 10 }}>
          <span>{remaining > 0.005 ? 'Still to pay' : remaining < -0.005 ? 'Over by' : 'Fully covered'}</span>
          <span className="num" style={{ color: Math.abs(remaining) < 0.005 ? 'var(--good)' : 'var(--danger)' }}>{money(Math.abs(remaining))}</span>
        </div>
        {problems.length > 0 && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{problems[0]}</div>}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={!canConfirm} onClick={confirm}>Use these payments</button>
        </div>
      </div>
    </div>
  );
}
