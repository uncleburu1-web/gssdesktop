// A frozen copy of the ORIGINAL (pre-optimisation) list logic from db.js, kept only so tests can
// prove the fast queries return exactly what the slow ones did. Do not "improve" this file.
function computeItemTotals(item) {
  const subtotal = item.unit_price * item.quantity;
  const total = subtotal - item.discount;
  const profit = (item.unit_price - item.unit_cost) * item.quantity - item.discount;
  return { subtotal, total, profit };
}

function legacyComputeStockFields(db, productId) {
  const batches = db.prepare(`SELECT * FROM stock_batches WHERE product_id = ? AND is_deleted = 0`).all(productId);
  const quantity = batches.reduce((sum, b) => sum + b.quantity_remaining, 0);
  const remainingWithStock = batches.filter((b) => b.quantity_remaining > 0);
  const totalQty = remainingWithStock.reduce((s, b) => s + b.quantity_remaining, 0);
  const costPrice = totalQty
    ? remainingWithStock.reduce((s, b) => s + b.quantity_remaining * b.cost_price, 0) / totalQty
    : 0;
  return { quantity, cost_price: Math.round(costPrice * 100) / 100 };
}

function legacyGetSale(db, saleId) {
  const sale = db.prepare(`SELECT * FROM sales WHERE id = ?`).get(saleId);
  if (!sale) return null;
  const items = db.prepare(`SELECT * FROM sale_items WHERE sale_id = ? AND is_deleted = 0 ORDER BY rowid`).all(saleId);
  const itemsWithTotals = items.map((i) => ({ ...i, ...computeItemTotals(i) }));
  const total = itemsWithTotals.reduce((s, i) => s + i.total, 0);
  const profit = itemsWithTotals.reduce((s, i) => s + i.profit, 0);
  const balance_due = sale.status === 'completed' ? 0 : Math.max(total - sale.amount_paid, 0);
  return { ...sale, items: itemsWithTotals, total: Math.round(total * 100) / 100, profit: Math.round(profit * 100) / 100, balance_due };
}

function legacyListSales(db, { status = null } = {}) {
  const rows = db.prepare(`SELECT id FROM sales WHERE is_deleted = 0 ORDER BY date DESC`).all();
  let sales = rows.map((r) => legacyGetSale(db, r.id));
  if (status) sales = sales.filter((s) => s.status === status);
  return sales;
}

function legacyListProducts(db, { category = null, search = '' } = {}) {
  let rows = db.prepare(`SELECT * FROM products WHERE is_deleted = 0 ORDER BY name`).all();
  if (category && category !== 'all') rows = rows.filter((r) => r.category === category);
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => `${r.name} ${r.short_code || ''} ${r.barcode || ''}`.toLowerCase().includes(q));
  }
  return rows.map((r) => ({ ...r, ...legacyComputeStockFields(db, r.id) }));
}

function legacyListCustomers(db, { search = '' } = {}) {
  let rows = db.prepare(`SELECT * FROM customers WHERE is_deleted = 0 ORDER BY name`).all();
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) => `${r.name} ${r.phone || ''} ${r.email || ''}`.toLowerCase().includes(q));
  }
  return rows.map((r) => {
    const outstanding = db.prepare(
      `SELECT amount_paid, id FROM sales WHERE customer_id = ? AND status = 'outstanding' AND is_deleted = 0`
    ).all(r.id);
    const balanceDue = outstanding.reduce((sum, s) => {
      const sale = legacyGetSale(db, s.id);
      return sum + (sale ? sale.balance_due : 0);
    }, 0);
    return { ...r, balance_due: balanceDue, outstanding_sale_count: outstanding.length };
  });
}

module.exports = { legacyGetSale, legacyListSales, legacyListProducts, legacyListCustomers };
