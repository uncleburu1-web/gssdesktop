import { useCallback, useEffect, useState } from 'react';
import { r, naira, since, can, estimate, SERVICE_LABEL, KITCHEN_LABEL, STATE_LABEL } from './api.js';
import { Modal, ErrorNote, BillPrint } from './ui.jsx';
import { usePaymentMethods, methodLabel } from '../format.js';

const ORDER = ['queued', 'preparing', 'ready', 'served'];

/** Where an item is in the kitchen, from its ticket items (the slowest one decides). */
function kitchenState(item) {
  const live = (item.tickets || []).filter((t) => t.state !== 'voided');
  if (item.state === 'served') return 'served';
  if (!live.length) return item.state === 'sent' ? 'no_kitchen' : item.state;
  return live.map((t) => t.state).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0];
}

export default function OrderPad({ orderId, profile, tick, onClose }) {
  const [order, setOrder] = useState(null);
  const [menu, setMenu] = useState([]);
  const [tables, setTables] = useState([]);
  const [cat, setCat] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null); // { kind, item? }
  const [print, setPrint] = useState(null); // { kind, change }
  const [done, setDone] = useState(null);   // closed: { change }

  const load = useCallback(() => r('order', orderId).then((o) => { setOrder(o); return o; }).catch((e) => setError(e.message)), [orderId]);
  useEffect(() => { load(); }, [load, tick]);
  useEffect(() => {
    r('menu').then((m) => { setMenu(m); setCat((c) => c || (m[0] && m[0].id)); }).catch((e) => setError(e.message));
    r('tables').then(setTables).catch(() => {});
  }, [tick]);
  useEffect(() => {
    if (!print) return undefined;
    const id = requestAnimationFrame(() => { window.pos.printReceipt(); });
    return () => cancelAnimationFrame(id);
  }, [print]);

  const table = order && tables.find((t) => t.id === order.table_id);
  const view = order && { ...order, table_label: table && table.label };

  /** Run one action; on success refresh, on refusal say why in plain words. */
  async function act(fn, after) {
    setBusy(true);
    setError('');
    try {
      const out = await fn();
      const fresh = await load();
      if (after) after(out, fresh);
      return out;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (!order) return <div><ErrorNote error={error} /><button className="btn ghost" onClick={onClose}>← Floor</button></div>;
  if (done || order.status !== 'open') {
    return (
      <div className="r-notice" style={{ maxWidth: 480 }}>
        <h3>Order {order.number} {order.status === 'cancelled' ? 'cancelled' : 'paid and closed'}</h3>
        {done && Number(done.change) > 0 && <p>Change to give: <span className="r-change">{naira(done.change)}</span></p>}
        {order.status === 'closed' && <p>The receipt was sent to the printer{table ? ` and table ${table.label} is free again` : ''}.</p>}
        <button className="btn" onClick={onClose}>Back to the floor</button>
        <BillPrint order={view} shop={profile} kind={print ? print.kind : 'receipt'} change={print && print.change} />
      </div>
    );
  }

  const live = order.items.filter((i) => i.quantity - i.voided_quantity > 0 || i.state === 'voided' || i.voided_quantity > 0);
  const pending = order.items.filter((i) => i.state === 'pending');
  const sent = live.filter((i) => i.state !== 'pending');
  const bill = order.bill;
  const balance = bill ? Number(bill.total) - Number(bill.paid) : null;
  const category = menu.find((c) => c.id === cat) || menu[0];

  function addFromMenu(item) {
    if (!item.available) return;
    if (item.modifier_groups.length) { setModal({ kind: 'choices', item }); return; }
    const same = pending.find((p) => p.menu_item_id === item.id && !p.modifiers.length && !p.notes);
    act(() => (same ? r('changeItem', same.id, { quantity: same.quantity + 1 }) : r('addItems', orderId, [{ menu_item_id: item.id, quantity: 1 }])));
  }

  return (
    <div>
      <div className="r-head" style={{ marginBottom: 12 }}>
        <button className="btn ghost" onClick={onClose}>← Floor</button>
        <ErrorNote error={error} />
      </div>
      <div className="r-pad">
        <div>
          <div className="r-cats">
            {menu.map((c) => <button key={c.id} className={`r-cat${category && category.id === c.id ? ' active' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>)}
          </div>
          <div className="r-menu">
            {category && category.items.map((i) => (
              <button key={i.id} className={`r-item${i.available ? '' : ' off'}`} onClick={() => addFromMenu(i)} disabled={busy || !i.available} data-item={i.name}>
                <span className="name">{i.name}</span>
                {i.modifier_groups.length > 0 && <span className="r-sub" style={{ margin: 0, fontSize: 11.5 }}>Choices</span>}
                <span className="price">{i.available ? naira(i.price) : 'Sold out'}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="r-panel">
          <div className="r-panel-head">
            <div className="no">{order.number} · {table ? `Table ${table.label}` : SERVICE_LABEL[order.service_type]}</div>
            <div className="r-sub">{order.guests ? `${order.guests} guests · ` : ''}{order.waiter} · open {since(order.opened_at)} · {KITCHEN_LABEL[order.kitchen_status]}</div>
          </div>
          <div className="r-panel-body">
            {pending.length > 0 && <div className="r-group-title">Not sent yet</div>}
            {pending.map((i) => (
              <div className="r-line" key={i.id}>
                <div className="what">
                  <div className="nm">{i.name}</div>
                  {i.modifiers.map((m) => <div className="mod" key={m.option_id}>+ {m.name}</div>)}
                  {i.notes && <div className="note">! {i.notes}</div>}
                  <div className="acts">
                    <span className="r-qty">
                      <button aria-label="One less" disabled={busy || i.quantity <= 1} onClick={() => act(() => r('changeItem', i.id, { quantity: i.quantity - 1 }))}>−</button>
                      <span className="q">{i.quantity}</span>
                      <button aria-label="One more" disabled={busy} onClick={() => act(() => r('changeItem', i.id, { quantity: i.quantity + 1 }))}>+</button>
                    </span>
                    <button className="btn ghost small" onClick={() => setModal({ kind: 'note', item: i })}>Note</button>
                    <button className="btn ghost small" disabled={busy} onClick={() => act(() => r('removeItem', i.id))}>Remove</button>
                  </div>
                </div>
                <div className="amt">{naira((Number(i.unit_price) + Number(i.modifiers_price)) * i.quantity)}</div>
              </div>
            ))}
            {sent.length > 0 && <div className="r-group-title">Sent</div>}
            {sent.map((i) => {
              const left = i.quantity - i.voided_quantity;
              const ks = kitchenState(i);
              return (
                <div className={`r-line${left <= 0 ? ' voided' : ''}`} key={i.id} data-line={i.name}>
                  <span className="q">{i.quantity}</span>
                  <div className="what">
                    <div className="nm">{i.name}</div>
                    {i.modifiers.map((m) => <div className="mod" key={m.option_id}>+ {m.name}</div>)}
                    {i.notes && <div className="note">! {i.notes}</div>}
                    {i.voided_quantity > 0 && <div className="void">{i.voided_quantity} voided{i.void_reason ? `: ${i.void_reason}` : ''}{i.waste ? ' (waste)' : ''}</div>}
                    <div className="acts">
                      {left > 0 && <span className={`r-chip ${ks}`}>{ks === 'no_kitchen' ? 'No kitchen' : STATE_LABEL[ks] || ks}</span>}
                      {left > 0 && i.state === 'sent' && can(profile, 'take_orders') && (
                        <button className="btn small" disabled={busy} onClick={() => act(() => r('serve', i.id))}>Served</button>
                      )}
                      {left > 0 && can(profile, 'void_sent_item') && (
                        <button className="btn ghost small" onClick={() => setModal({ kind: 'void', item: i })}>Void</button>
                      )}
                    </div>
                  </div>
                  <div className="amt">{naira((Number(i.unit_price) + Number(i.modifiers_price)) * Math.max(left, 0))}</div>
                </div>
              );
            })}
            {order.items.length === 0 && <div className="empty">Tap items on the left to start the order.</div>}
          </div>
          <div className="r-panel-foot">
            {bill ? (
              <>
                <div className="r-sum"><span>Subtotal</span><span>{naira(bill.subtotal)}</span></div>
                {Number(bill.discount) > 0 && <div className="r-sum"><span>Discount</span><span>−{naira(bill.discount)}</span></div>}
                {bill.charges.map((c) => (
                  <div className="r-sum" key={`${c.kind}-${c.name}`}><span>{c.name} {Number(c.rate)}%{c.inclusive ? ' (in prices)' : ''}</span><span>{naira(c.amount)}</span></div>
                ))}
                <div className="r-sum total"><span>Total</span><span data-total>{naira(bill.total)}</span></div>
                {Number(bill.paid) > 0 && <div className="r-sum paid"><span>Paid</span><span>{naira(bill.paid)}</span></div>}
                {Number(bill.paid) > 0 && <div className="r-sum total"><span>To pay</span><span>{naira(balance)}</span></div>}
              </>
            ) : (
              <div className="r-sum total"><span>Food so far</span><span>{naira(estimate(order))}</span></div>
            )}
            {pending.length > 0 && can(profile, 'send_to_kitchen') && (
              <button className="btn r-big" disabled={busy} onClick={() => act(() => r('send', orderId))}>
                Send {pending.reduce((n, i) => n + i.quantity, 0)} to the kitchen
              </button>
            )}
            <div className="r-actions">
              <button className="btn ghost" disabled={busy || live.length === 0}
                onClick={() => act(() => r('printBill', orderId), () => setPrint({ kind: 'bill', at: Date.now() }))}>Print bill</button>
              {can(profile, 'take_payment') && (
                <button className="btn" disabled={busy || live.length === 0} onClick={() => setModal({ kind: 'pay' })}>Take payment</button>
              )}
              {can(profile, 'apply_discount') && <button className="btn ghost" onClick={() => setModal({ kind: 'discount' })}>Discount</button>}
              {order.table_id && can(profile, 'move_table') && <button className="btn ghost" onClick={() => setModal({ kind: 'move' })}>Move table</button>}
            </div>
            <button className="btn ghost small" style={{ alignSelf: 'flex-start', color: 'var(--danger)' }} onClick={() => setModal({ kind: 'cancel' })}>Cancel order</button>
          </div>
        </div>
      </div>

      {print && <BillPrint order={view} shop={profile} kind={print.kind} change={print.change} />}
      {modal && modal.kind === 'choices' && (
        <Choices item={modal.item} onClose={() => setModal(null)}
          onAdd={(line) => act(() => r('addItems', orderId, [line]), () => setModal(null))} error={error} />
      )}
      {modal && modal.kind === 'note' && (
        <NoteModal item={modal.item} onClose={() => setModal(null)} onSave={(notes) => act(() => r('changeItem', modal.item.id, { notes }), () => setModal(null))} />
      )}
      {modal && modal.kind === 'void' && (
        <VoidModal item={modal.item} error={error} onClose={() => setModal(null)}
          onVoid={(input) => act(() => r('voidItem', modal.item.id, input), () => setModal(null))} />
      )}
      {modal && modal.kind === 'discount' && (
        <DiscountModal bill={bill} error={error} onClose={() => setModal(null)}
          onApply={(input) => act(() => r('discount', orderId, input), () => setModal(null))} />
      )}
      {modal && modal.kind === 'move' && (
        <MoveModal tables={tables.filter((t) => t.status === 'free')} onClose={() => setModal(null)}
          onMove={(tableId) => act(() => r('moveTable', orderId, tableId), () => setModal(null))} />
      )}
      {modal && modal.kind === 'cancel' && (
        <CancelModal error={error} onClose={() => setModal(null)} onCancel={(reason) => act(() => r('cancel', orderId, { reason }), () => setModal(null))} />
      )}
      {modal && modal.kind === 'pay' && (
        <PayModal order={order} profile={profile} error={error} busy={busy} onClose={() => setModal(null)}
          onPay={(input) => act(() => r('pay', orderId, input), (out, fresh) => {
            setModal(null);
            if (fresh && fresh.status === 'closed') { setDone({ change: out.change }); setPrint({ kind: 'receipt', change: out.change, at: Date.now() }); }
          })} />
      )}
    </div>
  );
}

function Choices({ item, onClose, onAdd, error }) {
  const [picked, setPicked] = useState({}); // group id -> [option ids]
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');
  const toggle = (g, o) => setPicked((p) => {
    const cur = p[g.id] || [];
    if (cur.includes(o.id)) return { ...p, [g.id]: cur.filter((x) => x !== o.id) };
    if (g.max_select === 1) return { ...p, [g.id]: [o.id] };
    if (g.max_select && cur.length >= g.max_select) return p;
    return { ...p, [g.id]: [...cur, o.id] };
  });
  const missing = item.modifier_groups.filter((g) => (picked[g.id] || []).length < (g.min_select || 0));
  const extra = item.modifier_groups.reduce((sum, g) => sum + g.options.filter((o) => (picked[g.id] || []).includes(o.id)).reduce((s, o) => s + Number(o.price_delta), 0), 0);
  return (
    <Modal title={item.name} onClose={onClose} width={480}>
      <ErrorNote error={error} />
      {item.modifier_groups.map((g) => (
        <div className="r-group" key={g.id}>
          <div className="r-group-head">{g.name}<span>{g.min_select ? `choose ${g.min_select === g.max_select ? g.min_select : `${g.min_select}–${g.max_select}`}` : `optional${g.max_select ? `, up to ${g.max_select}` : ''}`}</span></div>
          <div className="r-options">
            {g.options.map((o) => (
              <button key={o.id} className={`r-option${(picked[g.id] || []).includes(o.id) ? ' on' : ''}`} disabled={!o.available} onClick={() => toggle(g, o)}>
                {o.name}{Number(o.price_delta) ? ` +${naira(o.price_delta)}` : ''}{!o.available ? ' (out)' : ''}
              </button>
            ))}
          </div>
        </div>
      ))}
      <label className="r-label">Note for the kitchen</label>
      <input className="r-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. no pepper" maxLength={200} />
      <div className="modal-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="r-qty">
          <button onClick={() => setQuantity((q) => Math.max(1, q - 1))}>−</button><span className="q">{quantity}</span>
          <button onClick={() => setQuantity((q) => q + 1)}>+</button>
        </span>
        <button className="btn" disabled={missing.length > 0}
          onClick={() => onAdd({ menu_item_id: item.id, quantity, modifiers: Object.values(picked).flat(), notes })}>
          Add {naira((Number(item.price) + extra) * quantity)}
        </button>
      </div>
      {missing.length > 0 && <div className="r-sub">Choose: {missing.map((g) => g.name).join(', ')}</div>}
    </Modal>
  );
}

function NoteModal({ item, onClose, onSave }) {
  const [notes, setNotes] = useState(item.notes || '');
  return (
    <Modal title={`Note: ${item.name}`} onClose={onClose}>
      <input className="r-input" autoFocus value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} placeholder="e.g. no pepper, well done" />
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn" onClick={() => onSave(notes)}>Save</button></div>
    </Modal>
  );
}

const VOID_REASONS = ['Customer changed mind', 'Wrong order', 'Kitchen mistake', 'Ran out'];
function VoidModal({ item, onClose, onVoid, error }) {
  const left = item.quantity - item.voided_quantity;
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');
  return (
    <Modal title={`Void ${item.name}`} onClose={onClose}>
      <ErrorNote error={error} />
      <p className="r-sub" style={{ marginTop: 0 }}>The kitchen gets a VOID ticket. If cooking had started it is recorded as waste.</p>
      <label className="r-label">How many (of {left})</label>
      <span className="r-qty" style={{ marginBottom: 12 }}>
        <button onClick={() => setQuantity((q) => Math.max(1, q - 1))}>−</button><span className="q">{quantity}</span>
        <button onClick={() => setQuantity((q) => Math.min(left, q + 1))}>+</button>
      </span>
      <label className="r-label" style={{ marginTop: 10 }}>Why</label>
      <div className="r-options" style={{ marginBottom: 8 }}>
        {VOID_REASONS.map((v) => <button key={v} className={`r-option${reason === v ? ' on' : ''}`} onClick={() => setReason(v)}>{v}</button>)}
      </div>
      <input className="r-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or type the reason" />
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Keep it</button>
        <button className="btn danger" disabled={!reason.trim()} onClick={() => onVoid({ quantity, reason })}>Void {quantity}</button></div>
    </Modal>
  );
}

function DiscountModal({ bill, onClose, onApply, error }) {
  const [type, setType] = useState('percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Modal title="Discount" onClose={onClose}>
      <ErrorNote error={error} />
      <div className="r-options" style={{ marginBottom: 10 }}>
        <button className={`r-option${type === 'percent' ? ' on' : ''}`} onClick={() => setType('percent')}>Percent</button>
        <button className={`r-option${type === 'amount' ? ' on' : ''}`} onClick={() => setType('amount')}>Amount (₦)</button>
      </div>
      <input className="r-input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))} placeholder={type === 'percent' ? 'e.g. 10' : 'e.g. 1000'} />
      <label className="r-label" style={{ marginTop: 10 }}>Why</label>
      <input className="r-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. regular customer, late food" />
      <div className="modal-actions">
        {bill && Number(bill.discount) > 0 && <button className="btn ghost" onClick={() => onApply({ type, value: 0, reason: '' })}>Remove discount</button>}
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!(Number(value) > 0) || !reason.trim()} onClick={() => onApply({ type, value, reason })}>Apply</button>
      </div>
    </Modal>
  );
}

function MoveModal({ tables, onClose, onMove }) {
  return (
    <Modal title="Move to which table?" onClose={onClose}>
      {tables.length === 0 && <div className="empty">No free table.</div>}
      <div className="r-options">{tables.map((t) => <button key={t.id} className="r-option" onClick={() => onMove(t.id)}>{t.label}</button>)}</div>
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function CancelModal({ onClose, onCancel, error }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="Cancel this order?" onClose={onClose}>
      <ErrorNote error={error} />
      <p className="r-sub" style={{ marginTop: 0 }}>Anything already sent gets a VOID ticket in the kitchen. An order that has payments cannot be cancelled.</p>
      <input className="r-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (e.g. guests left)" />
      <div className="modal-actions"><button className="btn ghost" onClick={onClose}>Keep the order</button>
        <button className="btn danger" disabled={!reason.trim()} onClick={() => onCancel(reason)}>Cancel order</button></div>
    </Modal>
  );
}

function PayModal({ order, profile, onClose, onPay, error, busy }) {
  const methods = usePaymentMethods();
  const total = order.bill ? Number(order.bill.total) : null;
  const due = order.bill ? total - Number(order.bill.paid) : null;
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState(due !== null ? due.toFixed(2) : '');
  const [tendered, setTendered] = useState('');
  const [tip, setTip] = useState('');
  const [reference, setReference] = useState('');
  const [override, setOverride] = useState(false);
  const needOverride = /Serve everything/.test(error || '');
  const handed = Number(tendered || 0);
  const change = method === 'cash' && tendered ? handed - Number(amount || 0) - Number(tip || 0) : 0;
  return (
    <Modal title={`Payment · ${order.number}`} onClose={onClose} width={460}>
      <ErrorNote error={error && /shift/i.test(error) ? `${error} Go to Shift and open it.` : error} />
      {due === null && <p className="r-sub" style={{ marginTop: 0 }}>The bill is worked out when you take payment.</p>}
      {due !== null && <div className="r-sum total" style={{ marginBottom: 12 }}><span>To pay</span><span>{naira(due)}</span></div>}
      <div className="r-methods">
        {methods.map((m) => <button key={m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>{methodLabel(m)}</button>)}
      </div>
      <div className="field-row">
        <div><label className="r-label">Amount</label><input className="r-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="Whole bill" /></div>
        <div><label className="r-label">Tip (optional)</label><input className="r-input" inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" /></div>
      </div>
      {method === 'cash' ? (
        <div style={{ marginTop: 10 }}>
          <label className="r-label">Cash handed over</label>
          <input className="r-input" inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="e.g. 12000" />
          {change > 0 && <div style={{ marginTop: 8 }}>Change: <span className="r-change">{naira(change)}</span></div>}
          {tendered && change < 0 && <div className="r-sub" style={{ color: 'var(--danger)' }}>That is less than the amount.</div>}
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <label className="r-label">Reference (optional)</label>
          <input className="r-input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transfer or POS reference" />
        </div>
      )}
      {needOverride && can(profile, 'override_served_rule') && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 13 }}>
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Take payment anyway (recorded)
        </label>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || (method === 'cash' && tendered && change < 0)}
          onClick={() => onPay({ method, amount: amount || undefined, tendered: method === 'cash' && tendered ? tendered : null, tip: tip || '0', reference, override })}>
          Take {amount ? naira(amount) : 'payment'}
        </button>
      </div>
    </Modal>
  );
}
