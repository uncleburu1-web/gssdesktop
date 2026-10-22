import { useEffect, useState } from 'react';
import { r, since, can, STATE_LABEL } from './api.js';
import { ErrorNote } from './ui.jsx';

const NEXT = { queued: 'preparing', preparing: 'ready' };

/**
 * The kitchen as the hub sees it: tickets still being worked on, and kitchen tickets that did not
 * print (out of paper, printer off, or not confirmed before a power cut) with a reprint button.
 * Kitchen staff signed in here (or the owner) can also move items on, as a kitchen screen would.
 */
export default function KitchenTab({ profile, tick }) {
  const [tickets, setTickets] = useState([]);
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [now, setNow] = useState(Date.now());
  const isKitchen = profile?.is_owner || profile?.is_ceo || profile?.role === 'kitchen';
  const mayReprint = can(profile, 'reprint_ticket');

  const load = () => Promise.all([r('kitchen'), r('printProblems')]).then(([t, p]) => { setTickets(t); setProblems(p); })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, [tick]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);

  async function run(fn, ok) {
    setError(''); setNote('');
    try { await fn(); if (ok) setNote(ok); load(); } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <ErrorNote error={error} />
      {note && <div className="r-ok">{note}</div>}
      {problems.length > 0 && (
        <div className="section">
          <div className="section-head"><h3 style={{ color: 'var(--danger)' }}>Not printed ({problems.length})</h3><span className="r-sub" style={{ margin: 0 }}>Fix the printer, then reprint</span></div>
          <div className="section-body">
            {problems.map((p) => (
              <div className="r-list-row" key={p.id}>
                <span className="mono" style={{ fontWeight: 700 }}>{p.ticket_number}</span>
                <span className="grow">{p.station}{p.kind === 'void' ? ' · VOID' : p.kind === 'copy' ? ' · copy' : ''}
                  <div className="r-sub" style={{ margin: 0 }}>{p.status === 'no_printer' ? 'No printer chosen for this station on this till (Set-up).' : p.last_error}</div>
                </span>
                {mayReprint && <button className="btn small" onClick={() => run(() => r('reprint', p.ticket_id), `Ticket ${p.ticket_number} sent to the printer again (marked COPY).`)}>Reprint</button>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="section">
        <div className="section-head"><h3>In the kitchen</h3><span className="r-sub" style={{ margin: 0 }}>Amber after 10 minutes, red after 20</span></div>
        <div className="section-body">
          {tickets.length === 0 && <div className="empty">Nothing waiting in the kitchen.</div>}
          <div className="r-tickets">
            {tickets.map((t) => {
              const minutes = (now - Date.parse(t.sent_at)) / 60000;
              const open = t.items.some((i) => i.state === 'queued' || i.state === 'preparing');
              return (
                <div key={t.id} className={`r-ticket${open && minutes >= 20 ? ' late' : open && minutes >= 10 ? ' warn' : ''}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span className="mono" style={{ fontWeight: 700 }}>{t.number}</span>
                    <span>{t.table_label ? `Table ${t.table_label}` : t.service_type === 'takeaway' ? 'Takeaway' : 'Counter'}</span>
                    <span className="num" style={{ color: 'var(--text-dim)' }}>{since(t.sent_at, now)}</span>
                  </div>
                  {t.items.map((i) => (
                    <div className="r-list-row" key={i.id} style={{ padding: '6px 0' }}>
                      <span className="q" style={{ fontWeight: 700 }}>{i.quantity - i.voided_quantity}</span>
                      <span className="grow">{i.name}{i.modifiers.length ? <span className="r-sub" style={{ margin: 0 }}> + {i.modifiers.join(', ')}</span> : null}
                        {i.notes && <div className="r-line"><span className="note">! {i.notes}</span></div>}</span>
                      {isKitchen && NEXT[i.state] ? (
                        <button className={`btn small${i.state === 'preparing' ? '' : ' ghost'}`}
                          onClick={() => run(() => r('ticketItemState', i.id, { to: NEXT[i.state], version: i.version }))}>
                          {i.state === 'queued' ? 'Start' : 'Ready'}
                        </button>
                      ) : <span className={`r-chip ${i.state}`}>{STATE_LABEL[i.state] || i.state}</span>}
                    </div>
                  ))}
                  {isKitchen && open && <button className="btn small" style={{ marginTop: 6 }} onClick={() => run(() => r('bump', t.id))}>All ready</button>}
                  {mayReprint && <button className="btn ghost small" style={{ marginTop: 6, marginLeft: 6 }} onClick={() => run(() => r('reprint', t.id), `Ticket ${t.number} reprinted (COPY).`)}>Reprint</button>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
