import { useEffect, useState } from 'react';
import { money } from './format.js';

/**
 * Replaces a plain "customer name" text box with a real search-or-add
 * picker against the customers table — so a repeat customer gets linked
 * to their actual record (and their running balance shows up right here,
 * which matters for a shop that sells on credit) instead of every visit
 * just being a fresh unlinked string.
 *
 * `customer` is the selected record (or null — free-text "Walk-in" mode,
 * same as before this existed). `onChange({ customer, customerName })`
 * fires on every relevant change; PosScreen just stores both.
 */
export default function CustomerPicker({ customer, customerName, onChange }) {
  const [query, setQuery] = useState(customerName || '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => { setQuery(customerName || ''); }, [customerName]);

  useEffect(() => {
    if (customer || !query.trim()) { setResults([]); return; }
    let cancelled = false;
    window.pos.listCustomers({ search: query }).then((rows) => {
      if (!cancelled) setResults(rows);
    });
    return () => { cancelled = true; };
  }, [query, customer]);

  function selectCustomer(c) {
    onChange({ customer: c, customerName: c.name });
    setOpen(false);
  }

  async function addNew() {
    if (adding) return; // a fast double-click otherwise fires this twice before the first create resolves
    const name = query.trim();
    if (!name) return;
    setAdding(true);
    try {
      const created = await window.pos.createCustomer({ name });
      selectCustomer(created);
    } finally {
      setAdding(false);
    }
  }

  function clear() {
    onChange({ customer: null, customerName: '' });
    setQuery('');
  }

  if (customer) {
    return (
      <div className="customer-picker-selected">
        <span className="customer-picker-name">{customer.name}</span>
        {customer.phone && <span className="customer-picker-sub">{customer.phone}</span>}
        {customer.balance_due > 0 && (
          <span className="customer-picker-owes">Owes {money(customer.balance_due)}</span>
        )}
        <button type="button" className="btn ghost small" onClick={clear}>Change</button>
      </div>
    );
  }

  return (
    <div className="customer-picker">
      <input
        placeholder="Customer (optional — Walk-in)"
        value={query}
        onChange={(e) => { setQuery(e.target.value); onChange({ customer: null, customerName: e.target.value }); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && query.trim() && (
        <div className="customer-picker-dropdown">
          {results.map((c) => (
            <div key={c.id} className="customer-picker-option" onMouseDown={() => selectCustomer(c)}>
              <span>{c.name}</span>
              <span className="customer-picker-option-sub">
                {c.phone || ''}{c.balance_due > 0 ? `${c.phone ? ' · ' : ''}owes ${money(c.balance_due)}` : ''}
              </span>
            </div>
          ))}
          <div className="customer-picker-option customer-picker-add" onMouseDown={addNew}>
            {adding ? 'Adding…' : `+ Add "${query.trim()}" as new customer`}
          </div>
        </div>
      )}
    </div>
  );
}
