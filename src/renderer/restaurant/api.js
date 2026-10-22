// The restaurant screens' only way into the hub: window.pos.restaurant(action, idempotencyKey, ...args)
// (main/restaurant/ipc.js). Reads go without a key; every change gets a fresh key, so a double tap
// or a retry after a hiccup is answered once by the engine instead of applied twice.
import { useEffect, useRef } from 'react';

const READS = new Set(['status', 'menu', 'tables', 'openOrders', 'order', 'kitchen', 'events', 'seq', 'printers', 'printProblems', 'screens']);

export function newKey() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const b = new Uint8Array(16);
  window.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class RestaurantError extends Error {
  constructor({ code, message, status, current, capability } = {}) {
    super(message || 'Something went wrong. Nothing was changed.');
    this.code = code || 'unexpected';
    this.status = status;
    this.current = current;
    this.capability = capability;
  }
}

/** Call an action; resolves to its data or throws a RestaurantError with a plain-English message. */
export async function r(action, ...args) {
  const key = READS.has(action) ? null : newKey();
  let result;
  try {
    result = await window.pos.restaurant(action, key, ...args);
  } catch (e) {
    throw new RestaurantError({ code: 'ipc', message: 'The till did not answer. Try again.' });
  }
  if (!result || !result.ok) throw new RestaurantError(result ? result.error : {});
  return result.data;
}

/** Money as the bill shows it: kobo included (₦11,162.50). */
export function naira(value) {
  const n = Number(value || 0);
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Minutes since a moment, as "7 min" / "1 h 05". */
export function since(iso, now = Date.now()) {
  if (!iso) return '';
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** What the food comes to before the bill is printed (no service charge or tax yet). */
export function estimate(order) {
  return order.items.reduce((sum, i) => sum + (Number(i.unit_price) + Number(i.modifiers_price)) * (i.quantity - i.voided_quantity), 0);
}

export function can(profile, capability) {
  return Boolean(profile && (profile.is_owner || profile.is_ceo || (profile.capabilities && profile.capabilities[capability])));
}

export const SERVICE_LABEL = { dine_in: 'Dine-in', takeaway: 'Takeaway', counter: 'Counter' };
export const KITCHEN_LABEL = { not_sent: 'Not sent', in_kitchen: 'In the kitchen', ready: 'Ready to serve', served: 'Served' };
export const STATE_LABEL = { queued: 'Waiting', preparing: 'Cooking', ready: 'Ready', served: 'Served', voided: 'Voided' };

/**
 * Calls onChange whenever anything changes on the hub (an order here, a tap on a kitchen screen,
 * a print failure): polls the hub's event log, which is local and cheap.
 */
export function useHubChanges(onChange, active = true) {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (!active) return undefined;
    let seq = null;
    let stopped = false;
    const tick = async () => {
      try {
        if (seq === null) { seq = await r('seq'); return; }
        const events = await r('events', seq);
        if (events.length) {
          seq = events[events.length - 1].seq;
          latest.current(events);
        }
      } catch { /* not the hub or not signed in: the screen shows why */ }
    };
    tick();
    const timer = setInterval(() => { if (!stopped) tick(); }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [active]);
}
