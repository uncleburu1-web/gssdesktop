export function money(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });
}

export function fmtDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return (
    dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) +
    ' ' +
    dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  );
}

export function fmtRelative(iso) {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// IPC errors arrive as `Error: Error invoking remote method 'x': Error: <message>`
// — strip the Electron wrapper noise down to the actual message we threw.
export function posErrorMessage(err, fallback) {
  const raw = err?.message || '';
  const match = raw.match(/Error:\s*(.+)$/);
  return (match ? match[1] : raw) || fallback;
}
