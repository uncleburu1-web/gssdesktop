# Benchline Desktop POS

Electron + React desktop app. Local-first: every normal POS operation
reads and writes only the local SQLite database (`src/main/db.js`) — the
network is never in the critical path of ringing up a sale.

## What's built and actually tested (not just written)

- **`src/main/schema.sql`** — local SQLite schema: products, stock_batches
  (FEFO), sales/sale_items (cart-based, mirrors the cloud `Sale`/`SaleItem`
  split), sale_allocations, and the sync outbox.
- **`src/main/db.js`** — the repository layer. Verified with a real Node
  script (no Electron needed for this part): created products and stock,
  rang up a multi-item cart sale, confirmed FEFO stock deduction and
  correct profit/total math, deleted a sale and confirmed stock fully
  restored + it's hidden from listings (soft delete), ran an installment
  sale through partial-then-full payment, and inspected the outbox to
  confirm every write is queued *except* stock deductions caused by a
  sale — those are intentionally not synced directly (see the comment on
  `enqueueSync` for why: the cloud derives stock from the same
  `sale`/`sale_item` operations independently, event-sourced, per the
  architecture doc's conflict-resolution design).
- **`src/main/main.js` + `preload.js`** — Electron main process and the
  IPC bridge exposed to the renderer as `window.pos.*`.
- **`src/main/auth.js`, `heartbeat.js`, `sync.js`** — login/JWT storage,
  a 30s heartbeat to `/api/devices/heartbeat/`, and an outbox-draining
  sync loop that targets `/api/sync/push/` (see "Not built yet" below).
- **The full React UI** (`src/renderer/`) — a login screen, and three
  screens behind it: Sell (product grid + cart, same design as the web
  app's POS), Products (add product, add stock), Sales history
  (completed/outstanding, record payments).

### Verified with a real, scripted end-to-end run — not just "should work"

Built the renderer with `vite build`, started the real Django backend,
booted this exact Electron app against it, and drove the actual rendered
UI the way a person would — typing into real form fields and clicking
real buttons via scripted DOM events, not calling the IPC bridge
directly:

1. Logged in against the real backend (real JWT issued)
2. Created a product, added 10 units of stock at ₦4,000 cost
3. Went to Sell, tapped the product tile twice → cart showed ₦12,000
4. Charged the sale → confirmation shown
5. Sales history correctly showed the sale: ₦12,000 total, ₦4,000 profit,
   "2× E2E Charger 65W", customer "Walk-in"

Every number in that chain was computed correctly, and this all happened
with the local SQLite database as the only thing either screen ever
talked to for the sale itself — the backend was only involved for login.

## Not built yet

- **`/api/sync/push/` and `/api/sync/pull/`** on the Django backend
  (architecture step 3) — without these, `sync.js` has nothing to
  actually talk to; the outbox will fill up correctly but stay `pending`
  forever until that endpoint exists.
- **Receipt printing** — deferred; the web app's `printSaleReceipt` logic
  could be reused but needs adapting to Electron's print APIs.
- **Customers, staff/users management, reports** screens — the backend
  spec calls for these; only Sell/Products/History exist so far.
- Packaging (`electron-builder` or similar) into a real Windows
  installer — needs to happen on an actual Windows machine; see the
  top-level conversation for why this sandbox can't produce that binary.

## Running it locally

```bash
cd benchline/desktop
npm install
npm run build          # builds the renderer with Vite
BENCHLINE_API_URL=http://localhost:8000/api npx electron .
```

Point `BENCHLINE_API_URL` at your running Django backend (defaults to
`http://localhost:8000/api`).
