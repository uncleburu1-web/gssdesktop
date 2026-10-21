/*
 * Kitchen routing on the hub: which station makes which line, and which tickets a "send" creates.
 *
 * The same pure functions as gss/restaurant/routing.py, kept identical by the shared cases in
 * test/routing_vectors.json (a byte-for-byte copy of gss/restaurant/routing_vectors.json; ADR-018).
 * Design: gss docs/restaurant/KITCHEN_WORKFLOW.md §1.
 *
 *  - A line goes to its item's station if that station is active, otherwise to its category's
 *    station if active, otherwise nowhere ("unrouted"), which is reported, never dropped.
 *  - Only PENDING lines are routed. A line already sent is never routed again, so retrying a send
 *    after a network drop cannot create a duplicate ticket.
 *  - One ticket per station per send, in the order stations first appear; items keep line order.
 */
function stationFor(itemStationId, categoryStationId, activeStationIds) {
  const active = new Set(activeStationIds || []);
  if (itemStationId && active.has(itemStationId)) return itemStationId;
  if (categoryStationId && active.has(categoryStationId)) return categoryStationId;
  return null;
}

function route(lines) {
  const tickets = [];
  const byStation = new Map();
  const unrouted = [];
  const skipped = [];
  for (const line of lines) {
    if ((line.state || 'pending') !== 'pending') { skipped.push(line.id); continue; }
    const station = line.station_id;
    if (!station) { unrouted.push(line.id); continue; }
    if (!byStation.has(station)) {
      const ticket = { station_id: station, items: [] };
      byStation.set(station, ticket);
      tickets.push(ticket);
    }
    byStation.get(station).items.push(line.id);
  }
  return { tickets, unrouted, skipped };
}

module.exports = { stationFor, route };
