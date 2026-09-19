import { useEffect, useState } from 'react';
import { posErrorMessage } from './format.js';

export default function LoginScreen({ onLoggedIn, pairedShopName }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Checked once up front so we know, before the form is even submitted,
  // whether this login is about to trigger the one-time shop-settings
  // download (nothing cached on this till yet) or just a normal sign-in
  // (settings already sitting in local db from a previous login) — see
  // auth.js's hasShopSettings(). Drives which message shows below.
  const [firstTimeSetup, setFirstTimeSetup] = useState(false);

  useEffect(() => {
    window.pos.hasLocalSetup().then((has) => setFirstTimeSetup(!has));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await window.pos.login(username, password);
      onLoggedIn();
    } catch (err) {
      setError(posErrorMessage(err, 'Could not log in — check the shop\'s internet connection and try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={handleSubmit} className="modal" style={{ width: 340, position: 'static' }}>
        <h3 style={{ marginBottom: 4 }}>{pairedShopName || 'Benchline POS'}</h3>
        <p style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 0, marginBottom: 16 }}>
          {pairedShopName
            ? 'This till is set up for this branch — sign in with an account from it.'
            : "Sign in once — after this, the till keeps working even if the internet drops."}
        </p>
        {error && <div className="form-error">{error}</div>}
        <div className="field">
          <label>Username</label>
          <input autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} disabled={submitting} />
        </div>
        <div className="field">
          <label>Password</label>
          <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={submitting} />
        </div>
        {submitting && firstTimeSetup && (
          <p style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: -4, marginBottom: 10 }}>
            First sign-in on this till — downloading your shop's setup (name, receipt, branch details)…
          </p>
        )}
        <button type="submit" className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={submitting}>
          {submitting ? (firstTimeSetup ? 'Setting up your account…' : 'Signing in…') : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
