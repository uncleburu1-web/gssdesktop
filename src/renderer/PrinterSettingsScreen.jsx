import { useEffect, useState } from 'react';
import Receipt from './Receipt.jsx';

// A tiny fake sale so "Send test print" runs the exact same Receipt
// component + print pipeline a real sale uses, without ringing anything up.
function testSale() {
  const now = new Date().toISOString();
  return {
    id: 'test-print',
    invoice_number: 0,
    date: now,
    customer_name: 'Test print',
    payment_method: 'cash',
    status: 'completed',
    staff_name: 'Printer setup',
    total: 500,
    items: [
      { id: 'test-item', item_name: 'Test line item', quantity: 1, unit_price: 500, total: 500, subtotal: 500, discount: 0 },
    ],
  };
}

export default function PrinterSettingsScreen({ profile }) {
  const [printers, setPrinters] = useState([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [testReceipt, setTestReceipt] = useState(null);

  function loadPrinters() {
    setLoading(true);
    Promise.all([window.pos.listPrinters(), window.pos.getSelectedPrinter()]).then(([list, current]) => {
      setPrinters(list);
      setSelected(current || '');
      setLoading(false);
    });
  }

  useEffect(() => { loadPrinters(); }, []);

  // Mirrors PosScreen's own auto-print effect — see its comment for why
  // the rAF wait matters: the receipt has to actually be painted before
  // print:receipt asks the main process to print this window's contents.
  useEffect(() => {
    if (!testReceipt) return;
    const id = requestAnimationFrame(() => {
      window.pos.printReceipt().then((result) => {
        setStatus(result.ok ? 'Test receipt sent — check the printer.' : `Print failed: ${result.reason || 'unknown error'}`);
        setTestReceipt(null);
      });
    });
    return () => cancelAnimationFrame(id);
  }, [testReceipt]);

  async function choose(deviceName) {
    setSelected(deviceName);
    await window.pos.setSelectedPrinter(deviceName);
    setStatus(deviceName
      ? `Saved. Sales now print silently to "${deviceName}" — no dialog.`
      : 'Saved. Sales will show the "choose a printer" popup again.');
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <h2 style={{ marginBottom: 4 }}>Receipt printer</h2>
      <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 18 }}>
        Pick the physical printer this till should use. Once set, a completed sale prints straight to it —
        no dialog, no extra click. This is per-machine — each till can point at a different printer.
      </p>

      {loading ? (
        <div className="empty">Loading printers…</div>
      ) : printers.length === 0 ? (
        <div className="empty">
          No printers found. Make sure the receipt printer is plugged in, powered on, and installed in
          Windows, then hit refresh below.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          <PrinterOption
            checked={selected === ''}
            label="Ask every time (show the print dialog)"
            onSelect={() => choose('')}
          />
          {printers.map((p) => (
            <PrinterOption
              key={p.name}
              checked={selected === p.name}
              label={`${p.displayName || p.name}${p.isDefault ? ' (Windows default)' : ''}`}
              onSelect={() => choose(p.name)}
            />
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn ghost small" onClick={loadPrinters} disabled={loading}>Refresh printer list</button>
        <button
          className="btn small"
          disabled={printers.length === 0 || Boolean(testReceipt)}
          onClick={() => setTestReceipt(testSale())}
        >
          Send test print
        </button>
      </div>

      {status && <div className="form-error" style={{ marginTop: 14, background: 'rgba(95,191,143,.12)', borderColor: 'var(--good)', color: 'var(--good)' }}>{status}</div>}

      <Receipt sale={testReceipt} cashReceived={testReceipt?.total || 0} change={0} shop={profile} />
    </div>
  );
}

function PrinterOption({ checked, label, onSelect }) {
  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
        border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer',
        background: checked ? 'var(--accent-dim)' : 'transparent',
      }}
    >
      <input type="radio" name="printer" checked={checked} onChange={onSelect} />
      <span>{label}</span>
    </label>
  );
}