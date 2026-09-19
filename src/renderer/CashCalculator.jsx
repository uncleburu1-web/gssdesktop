import { money } from './format.js';

// Quick-add chips for a Nigerian till — the denominations a cashier
// actually reaches for. Each chip ADDS to whatever's already typed, same
// as a real calculator's memory-add, so mixing e.g. two ₦1,000 notes and
// one ₦500 note just means tapping the ₦1,000 chip twice then the ₦500
// chip once.
const QUICK_ADD = [100, 200, 500, 1000, 2000, 5000];

/**
 * The "powerful calculator" on the Sell screen: how much cash the
 * customer handed over, and the change due back — the one piece of
 * mental math a busy till shouldn't have to do by hand. Only meaningful
 * for cash; transfer/POS-card payments are assumed exact, same as before.
 */
export default function CashCalculator({ due, received, onChange }) {
  const receivedNum = Number(received || 0);
  const change = receivedNum - due;

  function addDigit(d) {
    onChange(received === '' ? d : `${received}${d}`);
  }
  function addAmount(n) {
    onChange(String(receivedNum + n));
  }
  function backspace() {
    onChange(received.slice(0, -1));
  }
  function clear() {
    onChange('');
  }
  function exact() {
    onChange(String(due));
  }

  return (
    <div className="cash-calc">
      <div className="cash-calc-display">
        <div className="cash-calc-row">
          <span>Received</span>
          <span className="num">{money(receivedNum)}</span>
        </div>
        <div className={`cash-calc-row change ${change < 0 ? 'short' : ''}`}>
          <span>{change < 0 ? 'Still owed' : 'Change due'}</span>
          <span className="num">{money(Math.abs(change))}</span>
        </div>
      </div>

      <div className="cash-calc-chips">
        <button type="button" className="btn ghost small" onClick={exact}>Exact</button>
        {QUICK_ADD.map((n) => (
          <button type="button" key={n} className="btn ghost small" onClick={() => addAmount(n)}>
            +{n >= 1000 ? `${n / 1000}k` : n}
          </button>
        ))}
      </div>

      <div className="cash-calc-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0', '⌫'].map((k) => (
          <button
            type="button"
            key={k}
            className="cash-calc-key"
            onClick={() => (k === '⌫' ? backspace() : addDigit(k))}
          >
            {k}
          </button>
        ))}
      </div>
      <button type="button" className="btn ghost small" style={{ width: '100%', marginTop: 6 }} onClick={clear}>
        Clear
      </button>
    </div>
  );
}
