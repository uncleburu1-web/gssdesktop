import { useEffect, useState } from 'react';
import { ThemeProvider, useTheme } from './ThemeContext.jsx';
import LoginScreen from './LoginScreen.jsx';
import PosScreen from './PosScreen.jsx';
import ProductsScreen from './ProductsScreen.jsx';
import CustomersScreen from './CustomersScreen.jsx';
import SalesHistoryScreen from './SalesHistoryScreen.jsx';
import PrinterSettingsScreen from './PrinterSettingsScreen.jsx';
import { Icons } from './Icons.jsx';
import { fmtRelative } from './format.js';

function Shell() {
  const [loggedIn, setLoggedIn] = useState(null); // null = still checking
  const [profile, setProfile] = useState(null); // { is_owner, role, full_name, username }
  const [view, setView] = useState('sell');
  const [saleTick, setSaleTick] = useState(0);
  const [pendingSync, setPendingSync] = useState(0);
  const [syncStatus, setSyncStatus] = useState(null);
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    window.pos.isLoggedIn().then(setLoggedIn);
    // Fetched unconditionally (not gated on loggedIn) purely so the login
    // screen itself can show which shop this till is paired to — see
    // device.js/auth.js's login() and backend core.auth_serializers for
    // what "paired" means. getProfile() just reads a local cached row, so
    // this is free even before anyone has logged in this session; a real
    // login below re-fetches it fresh anyway.
    window.pos.getProfile().then(setProfile);
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    window.pos.getProfile().then(setProfile);
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    const check = () => window.pos.pendingSyncCount().then(setPendingSync);
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    const check = () => window.pos.syncStatus().then(setSyncStatus);
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    // The actual fix for "web sale doesn't show up on desktop": the sync
    // engine (main process) was already correctly pulling fresh data into
    // local SQLite, but nothing ever told these already-open screens to
    // look at it again. Bumping the SAME tick both PosScreen and
    // SalesHistoryScreen already re-fetch on (previously only bumped by
    // this device's OWN sales) now also fires the instant anything synced
    // in from elsewhere — the cloud, another till, the web app.
    const unsubscribe = window.pos.onDataChanged(() => setSaleTick((t) => t + 1));
    return unsubscribe;
  }, [loggedIn]);

  if (loggedIn === null) return null; // avoid a login-screen flash while checking
  if (!loggedIn) {
    return (
      <LoginScreen
        pairedShopName={profile?.shop_name}
        onLoggedIn={() => {
          setLoggedIn(true);
          setView('sell'); // always land on Sell — the one screen every role has
        }}
      />
    );
  }

  // Owner (first/superuser account, or a Worker with role='owner') gets
  // every screen, same as the web app. But the web app's owner-only split
  // is Reports/Liabilities/Workers/Billing/Settings — NONE of which exist
  // on desktop yet — so on the screens that DO exist here (Sell/Products/
  // Customers/History), a seller gets the same access a seller gets on
  // web: Sell always; Products (~ web's Inventory) and History (~ web's
  // Sales) are viewable, just like a seller can view Inventory/Sales on
  // web; only the owner-only actions *inside* those screens (adding a
  // product, adding a stock batch) stay gated, matching web's Inventory
  // page exactly. Customers has no web equivalent restriction at all, so
  // it's open to every role.
  const isOwner = Boolean(profile?.is_owner);

  function handleLogout() {
    window.pos.logout().then(() => {
      setLoggedIn(false);
      setProfile(null);
    });
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ width: 200, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', padding: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 18, padding: '0 6px' }}>{profile?.shop_name || 'My Shop'}</div>
        <NavButton active={view === 'sell'} onClick={() => setView('sell')}>{Icons.cart} Sell</NavButton>
        <NavButton active={view === 'products'} onClick={() => setView('products')}>Products</NavButton>
        <NavButton active={view === 'customers'} onClick={() => setView('customers')}>Customers</NavButton>
        <NavButton active={view === 'history'} onClick={() => setView('history')}>Sales history</NavButton>
        <NavButton active={view === 'printer'} onClick={() => setView('printer')}>Printer</NavButton>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', padding: '0 6px', marginBottom: 4 }}>
          {pendingSync > 0 ? `${pendingSync} change${pendingSync > 1 ? 's' : ''} waiting to sync` : 'All changes synced'}
        </div>
        <div
          style={{ fontSize: 11, color: 'var(--text-dim)', padding: '0 6px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}
          title={syncStatus?.lastPushError ? `Last error: ${syncStatus.lastPushError.last_error}` : undefined}
        >
          <span style={{
            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
            background: syncStatus?.liveConnected ? 'var(--good)' : 'var(--danger)',
            boxShadow: syncStatus?.liveConnected ? '0 0 6px var(--good)' : 'none',
          }} />
          {syncStatus?.liveConnected ? 'Live' : 'Reconnecting…'} · last update from cloud {fmtRelative(syncStatus?.lastPullAt)}
        </div>
        <div className="nav-footer mono" style={{ padding: '0 6px', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{profile?.full_name || profile?.username}</div>
          <div style={{ opacity: 0.6, fontSize: 10.5, marginTop: 2, textTransform: 'uppercase', letterSpacing: '.5px' }}>
            {isOwner ? 'Owner' : 'Seller'}
          </div>
          <button
            className="btn ghost small"
            style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
            onClick={handleLogout}
          >
            {Icons.logout} Log out
          </button>
        </div>
        <button className="theme-toggle" onClick={toggleTheme}>
          {theme === 'dark' ? Icons.sun : Icons.moon}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {view === 'sell' && <PosScreen onSaleComplete={() => setSaleTick((t) => t + 1)} refreshKey={saleTick} profile={profile} />}
        {view === 'products' && <ProductsScreen refreshKey={saleTick} isOwner={isOwner} profile={profile} />}
        {view === 'customers' && <CustomersScreen refreshKey={saleTick} />}
        {view === 'history' && <SalesHistoryScreen refreshKey={saleTick} />}
        {view === 'printer' && <PrinterSettingsScreen profile={profile} />}
      </div>
    </div>
  );
}

function NavButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: '9px 10px', marginBottom: 2,
        borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 600,
        background: active ? 'var(--accent-dim)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text-dim)',
      }}
    >
      {children}
    </button>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}