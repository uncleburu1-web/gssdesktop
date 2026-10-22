import { useCallback, useEffect, useState } from 'react';
import { r, naira, since, can, estimate, useHubChanges, SERVICE_LABEL, KITCHEN_LABEL } from './api.js';
import { Modal, ErrorNote } from './ui.jsx';
import OrderPad from './OrderPad.jsx';
import KitchenTab from './KitchenTab.jsx';
import SetupTab from './SetupTab.jsx';
import './restaurant.css';

/**
 * The restaurant on the hub till: floor, orders, kitchen, set-up. Only the branch's hub runs it
 * (main/restaurant/store.js assertHub); any other till explains why instead.
 */
export default function RestaurantScreen({ profile }) {
  const [status, setStatus] = useState(null);
  const [tab, setTab] = useState('floor');
  const [orderId, setOrderId] = useState(null);
  const [tick, setTick] = useState(0);

  const loadStatus = useCallback(() => r('status').then(setStatus).catch(() => setStatus({ restaurant: false })), []);
  useEffect(() => { loadStatus(); const t = setInterval(loadStatus, 10000); return () => clearInterval(t); }, [loadStatus]);
  useHubChanges(() => setTick((t) => t + 1), Boolean(status && status.is_hub));

  if (!status) return null;
  if (!status.restaurant) {
    return <Notice title="This branch does not use the restaurant">The owner switches it on for a branch on the web, in Settings → Branches.</Notice>;
  }
  if (!status.is_hub) {
    return status.hub_device_id ? (
      <Notice title="Orders are taken on the restaurant hub">
        Another till in this branch is the restaurant hub. Open and send orders there: only one till runs the restaurant,
        so two tills can never each hold a different set of open tables.
      </Notice>
    ) : (
      <Notice title="Choose the restaurant hub first">
        No till runs the restaurant yet. The owner picks one till as the hub in the restaurant settings on the web.
        This till's id is <span className="mono">{status.device_id}</span>.
      </Notice>
    );
  }
  if (orderId) {
    return <OrderPad orderId={orderId} profile={profile} tick={tick} onClose={() => { setOrderId(null); setTick((t) => t + 1); }} />;
  }
  const tabs = [['floor', 'Floor'], ['kitchen', 'Kitchen'], ...(can(profile, 'mark_sold_out') || profile?.is_owner ? [['menu', 'Sold out']] : []),
    ...(profile?.is_owner || profile?.is_ceo ? [['setup', 'Set-up']] : [])];
  return (
    <div>
      <div className="r-head">
        <div>
          <div className="r-title">Restaurant</div>
          <div className="r-sub">This till is the restaurant hub. Everything works without internet.</div>
        </div>
        <div className="tabs">
          {tabs.map(([id, label]) => (
            <button key={id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      </div>
      {tab === 'floor' && <Floor profile={profile} tick={tick} onOpen={setOrderId} />}
      {tab === 'kitchen' && <KitchenTab profile={profile} tick={tick} />}
      {tab === 'menu' && <SoldOut tick={tick} />}
      {tab === 'setup' && <SetupTab profile={profile} tick={tick} />}
    </div>
  );
}

function Notice({ title, children }) {
  return <div className="r-notice"><h3>{title}</h3><p>{children}</p></div>;
}

function Floor({ profile, tick, onOpen }) {
  const [tables, setTables] = useState([]);
  const [orders, setOrders] = useState([]);
  const [opening, setOpening] = useState(null); // a free table being opened
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const mayTake = can(profile, 'take_orders');

  useEffect(() => {
    Promise.all([r('tables'), r('openOrders')]).then(([t, o]) => { setTables(t); setOrders(o); setError(''); })
      .catch((e) => setError(e.message));
  }, [tick]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const byTable = Object.fromEntries(orders.filter((o) => o.table_id).map((o) => [o.table_id, o]));
  const others = orders.filter((o) => !o.table_id);
  const areas = [];
  for (const t of tables) {
    let a = areas.find((x) => x.name === (t.area || 'Tables'));
    if (!a) { a = { name: t.area || 'Tables', tables: [] }; areas.push(a); }
    a.tables.push(t);
  }

  async function newOrder(serviceType, tableId = null, guests = null) {
    setError('');
    try {
      const o = await r('openOrder', { service_type: serviceType, table_id: tableId, guests });
      onOpen(o.id);
    } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <ErrorNote error={error} />
      <div className="r-head" style={{ marginBottom: 12 }}>
        <div className="r-legend"><span>Free</span><span className="occupied">Eating</span><span className="billing">Bill printed</span><span className="ready">Food ready</span></div>
        {mayTake && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => newOrder('takeaway')}>New takeaway</button>
            <button className="btn ghost" onClick={() => newOrder('counter')}>Counter order</button>
          </div>
        )}
      </div>
      {areas.length === 0 && <div className="empty">No tables yet. The owner adds areas and tables on the web.</div>}
      {areas.map((a) => (
        <div className="r-area" key={a.name}>
          <div className="r-area-name">{a.name}</div>
          <div className="r-tables">
            {a.tables.map((t) => {
              const o = byTable[t.id];
              const ready = o && o.kitchen_status === 'ready';
              return (
                <button key={t.id} className={`r-table ${t.status}`} data-table={t.label}
                  onClick={() => (o ? onOpen(o.id) : mayTake && setOpening(t))} disabled={!o && !mayTake}>
                  {ready && <span className="r-flag ready">READY</span>}
                  {!ready && t.status === 'billing' && <span className="r-flag billing">BILL</span>}
                  <span className="label">{t.label}</span>
                  <span className="meta">{o ? `${o.guests ? `${o.guests} guests · ` : ''}${since(o.opened_at, now)}` : `${t.seats} seats`}</span>
                  {o && <span className="meta">{o.waiter}</span>}
                  {o && <span className="total">{o.bill ? naira(o.bill.total) : naira(estimate(o))}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {others.length > 0 && (
        <div className="r-area">
          <div className="r-area-name">Takeaway and counter</div>
          <div className="r-orders">
            {others.map((o) => (
              <button key={o.id} className="r-order-row" onClick={() => onOpen(o.id)}>
                <span className="mono" style={{ fontWeight: 700 }}>{o.number}</span>
                <span>{SERVICE_LABEL[o.service_type]}</span>
                <span style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>{KITCHEN_LABEL[o.kitchen_status]} · {since(o.opened_at, now)}</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600 }} className="num">{o.bill ? naira(o.bill.total) : naira(estimate(o))}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {opening && <OpenTable table={opening} onClose={() => setOpening(null)} onOpen={(guests) => { setOpening(null); newOrder('dine_in', opening.id, guests); }} />}
    </div>
  );
}

function OpenTable({ table, onClose, onOpen }) {
  const [guests, setGuests] = useState(Math.min(2, table.seats || 2));
  return (
    <Modal title={`Open table ${table.label}`} onClose={onClose}>
      <label className="r-label">Guests</label>
      <div className="r-options" style={{ marginBottom: 14 }}>
        {Array.from({ length: Math.max(table.seats || 4, 4) }, (_, i) => i + 1).map((n) => (
          <button key={n} className={`r-option${guests === n ? ' on' : ''}`} onClick={() => setGuests(n)}>{n}</button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={() => onOpen(guests)}>Open table</button>
      </div>
    </Modal>
  );
}

function SoldOut({ tick }) {
  const [menu, setMenu] = useState([]);
  const [error, setError] = useState('');
  const load = () => r('menu').then(setMenu).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [tick]);
  async function toggle(item) {
    setError('');
    try { await r('soldOut', item.id, !item.sold_out_today); load(); } catch (e) { setError(e.message); }
  }
  return (
    <div className="section">
      <div className="section-head"><h3>Sold out today</h3><span className="r-sub" style={{ margin: 0 }}>Back on the menu tomorrow by itself</span></div>
      <div className="section-body">
        <ErrorNote error={error} />
        {menu.map((c) => (
          <div key={c.id}>
            <div className="r-group-title">{c.name}</div>
            {c.items.map((i) => (
              <div className="r-list-row" key={i.id}>
                <span className="grow">{i.name}{!i.is_available && <span className="r-chip" style={{ marginLeft: 8 }}>off the menu</span>}</span>
                <span className="num" style={{ color: 'var(--text-dim)' }}>{naira(i.price)}</span>
                <button className={`btn small${i.sold_out_today ? ' danger' : ' ghost'}`} disabled={!i.is_available} onClick={() => toggle(i)}>
                  {i.sold_out_today ? 'Sold out — put back' : 'Mark sold out'}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
