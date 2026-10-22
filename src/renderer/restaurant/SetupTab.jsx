import { useEffect, useState } from 'react';
import { r } from './api.js';
import { Modal, ErrorNote } from './ui.jsx';

/**
 * Owner set-up on the hub PC. The menu, tables, stations and taxes are set up on the web; what only
 * this PC can know is here: which Windows printer each kitchen station prints to (apart from the
 * receipt printer), and which kitchen screens may connect over the Wi-Fi.
 */
export default function SetupTab({ tick }) {
  const [stations, setStations] = useState([]);
  const [printers, setPrinters] = useState([]);
  const [screens, setScreens] = useState({ screens: [], lan: null });
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = () => Promise.all([r('printers'), r('screens')]).then(([s, sc]) => { setStations(s); setScreens(sc); })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, [tick]);
  useEffect(() => { window.pos.listPrinters().then((list) => setPrinters(Array.isArray(list) ? list : [])).catch(() => {}); }, []);
  useEffect(() => { const t = setInterval(() => r('screens').then(setScreens).catch(() => {}), 5000); return () => clearInterval(t); }, []);

  async function run(fn, ok) {
    setError(''); setNote('');
    try { const out = await fn(); if (ok) setNote(ok); load(); return out; } catch (e) { setError(e.message); return null; }
  }

  const lan = screens.lan;
  const printing = stations.filter((s) => s.active && s.prints);
  return (
    <div>
      <ErrorNote error={error} />
      {note && <div className="r-ok">{note}</div>}

      <div className="section">
        <div className="section-head"><h3>Kitchen printers on this PC</h3><span className="r-sub" style={{ margin: 0 }}>Separate from the receipt printer</span></div>
        <div className="section-body">
          {printing.length === 0 && <div className="empty">No station prints tickets. Stations are set up on the web.</div>}
          {printing.map((s) => (
            <div className="r-list-row" key={s.station_id}>
              <span className="grow" style={{ fontWeight: 600 }}>{s.station}</span>
              <select className="r-input" style={{ maxWidth: 320 }} value={s.printer} aria-label={`Printer for ${s.station}`}
                onChange={(e) => run(() => r('setStationPrinter', s.station_id, e.target.value), `${s.station} now prints to ${e.target.value || 'nothing'}.`)}>
                <option value="">— No printer —</option>
                {printers.map((p) => <option key={p.name} value={p.name}>{p.displayName || p.name}{p.isDefault ? ' (Windows default)' : ''}</option>)}
                {s.printer && !printers.some((p) => p.name === s.printer) && <option value={s.printer}>{s.printer} (not found)</option>}
              </select>
            </div>
          ))}
          <p className="r-sub">Send a test order to check each printer. A ticket that does not print shows on the Kitchen tab with a reprint button.</p>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h3>Kitchen screens on the Wi-Fi</h3>
          <button className="btn small" onClick={() => setAdding(true)}>Add a kitchen screen</button>
        </div>
        <div className="section-body">
          {lan && (lan.listening ? (
            <div style={{ marginBottom: 10 }}>
              <div className="r-sub">On the kitchen tablet or TV, open:</div>
              {lan.urls.length ? lan.urls.map((u) => <div className="r-url" key={u}>{u}</div>) : <div className="r-sub">This PC has no Wi-Fi or network address right now.</div>}
              <div className="r-sub">{lan.screens_connected} screen{lan.screens_connected === 1 ? '' : 's'} connected now. The first time, Windows may ask whether GSS POS may use the network: choose <b>Private networks</b> and Allow.</div>
            </div>
          ) : (
            <div className="r-error" style={{ background: 'transparent' }}>
              {lan.error || 'The kitchen screen server is off: no station is set to show on a screen. Switch "shows on screen" on for a station on the web.'}
            </div>
          ))}
          {screens.screens.length === 0 && <div className="empty">No kitchen screens yet.</div>}
          {screens.screens.map((s) => (
            <div className="r-list-row" key={s.id}>
              <span className="grow"><b>{s.name}</b><div className="r-sub" style={{ margin: 0 }}>{s.stations.map((x) => x.name).join(', ')} · last seen {s.last_seen_at ? new Date(s.last_seen_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : 'never'}</div></span>
              <button className="btn ghost small" style={{ color: 'var(--danger)' }} onClick={() => run(() => r('removeScreen', s.id), `${s.name} removed. It can no longer see or change tickets.`)}>Remove</button>
            </div>
          ))}
        </div>
      </div>

      {adding && (
        <AddScreen stations={stations.filter((s) => s.active)} error={error} onClose={() => setAdding(false)}
          onAdd={async (input) => { const out = await run(() => r('addScreen', input)); if (out) { setAdding(false); setPairing(out); } }} />
      )}
      {pairing && <PairingCode pairing={pairing} lan={lan} onClose={() => { setPairing(null); load(); }} />}
    </div>
  );
}

function AddScreen({ stations, onClose, onAdd, error }) {
  const [name, setName] = useState('Kitchen screen');
  const [chosen, setChosen] = useState(stations.length === 1 ? [stations[0].station_id] : []);
  const toggle = (id) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <Modal title="Add a kitchen screen" onClose={onClose}>
      <ErrorNote error={error} />
      <label className="r-label">Name</label>
      <input className="r-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Hot pass tablet" />
      <label className="r-label" style={{ marginTop: 12 }}>It shows tickets for</label>
      <div className="r-options">
        {stations.map((s) => <button key={s.station_id} className={`r-option${chosen.includes(s.station_id) ? ' on' : ''}`} onClick={() => toggle(s.station_id)}>{s.station}</button>)}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!chosen.length} onClick={() => onAdd({ name, station_ids: chosen })}>Get a pairing code</button>
      </div>
    </Modal>
  );
}

function PairingCode({ pairing, lan, onClose }) {
  const [left, setLeft] = useState(Math.max(0, Date.parse(pairing.expires_at) - Date.now()));
  useEffect(() => { const t = setInterval(() => setLeft(Math.max(0, Date.parse(pairing.expires_at) - Date.now())), 1000); return () => clearInterval(t); }, [pairing]);
  const mm = Math.floor(left / 60000);
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
  return (
    <Modal title={`Pair "${pairing.name}"`} onClose={onClose}>
      <p className="r-sub" style={{ marginTop: 0 }}>On the screen, open the address below and type this code. It works once.</p>
      <div className="r-code" data-code>{left > 0 ? pairing.code : '——————'}</div>
      <div className="r-sub" style={{ textAlign: 'center' }}>{left > 0 ? `Expires in ${mm}:${ss}` : 'Expired. Close and add the screen again.'}</div>
      {lan && lan.urls && lan.urls.map((u) => <div className="r-url" key={u}>{u}</div>)}
      <div className="r-sub">Shows: {pairing.stations.map((s) => s.name).join(', ')}</div>
      <div className="modal-actions"><button className="btn" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
