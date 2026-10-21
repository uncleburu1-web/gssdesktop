/*
 * The restaurant bill on the hub: subtotal, discount, service charge and taxes.
 *
 * The same rules as gss/restaurant/billing.py, held identical by test/billing_vectors.json (a
 * byte-for-byte copy of the cloud's file; every expected figure was worked out by hand). See that
 * file's docstring for the rules. Arithmetic is exact: amounts are fractions of BigInts, so a large
 * bill cannot lose kobo the way floating-point numbers can, and each amount is rounded half-up to
 * the kobo once.
 */
class BillError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// ---- exact fractions over BigInt ----
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
function frac(n, d = 1n) {
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
const ZERO = frac(0n);
const add = (a, b) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => frac(a.n * b.n, a.d * b.d);
const div = (a, b) => frac(a.n * b.d, a.d * b.n);
const cmp = (a, b) => { const l = a.n * b.d, r = b.n * a.d; return l < r ? -1 : l > r ? 1 : 0; };
const isZero = (a) => a.n === 0n;
const HUNDRED = frac(100n);

/** "3500.00", "7.5", "2", 3 -> exact fraction. */
function parse(value) {
  const s = String(value === null || value === undefined || value === '' ? '0' : value).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new BillError('bad_number');
  const decimals = m[3] || '';
  const n = BigInt(m[2] + decimals) * (m[1] ? -1n : 1n);
  return frac(n, 10n ** BigInt(decimals.length));
}

/** Half-up to the kobo (amounts here are >= 0). */
function roundKobo(x) {
  const kobo = mul(x, HUNDRED);
  return frac((kobo.n * 2n + kobo.d) / (kobo.d * 2n), 100n);
}

function money(x) {
  const kobo = (x.n * 100n) / x.d;
  const s = (kobo % 100n).toString().padStart(2, '0');
  return `${kobo / 100n}.${s}`;
}

function rateText(value) {
  const scaled = mul(parse(value), frac(10000n));
  if (scaled.d !== 1n) throw new BillError('rate_precision');
  const s = (scaled.n % 10000n).toString().padStart(4, '0');
  return `${scaled.n / 10000n}.${s}`;
}

function applies(rule, businessDate) {
  if (!rule.is_active) return false;
  if (rule.valid_from > businessDate) return false; // ISO dates compare as text
  return !rule.valid_to || businessDate <= rule.valid_to;
}

const covers = (rule, taxClass) => !(rule.tax_classes && rule.tax_classes.length) || rule.tax_classes.includes(taxClass);
const sum = (values) => values.reduce(add, ZERO);

function computeBill(data) {
  const byClass = new Map();
  let subtotal = ZERO;
  for (const line of data.lines || []) {
    const quantity = sub(parse(line.quantity ?? '1'), parse(line.voided_quantity));
    if (cmp(quantity, ZERO) < 0) throw new BillError('voided_more_than_ordered');
    const amount = roundKobo(mul(add(parse(line.unit_price), parse(line.modifiers_price)), quantity));
    subtotal = add(subtotal, amount);
    const c = line.tax_class || '';
    byClass.set(c, add(byClass.get(c) || ZERO, amount));
  }

  let discount = ZERO;
  const spec = data.discount;
  if (spec) {
    discount = spec.type === 'percent' ? roundKobo(div(mul(subtotal, parse(spec.value)), HUNDRED)) : roundKobo(parse(spec.value));
    if (cmp(discount, subtotal) > 0) throw new BillError('discount_too_large');
  }
  const net = sub(subtotal, discount);
  const share = isZero(subtotal) ? ZERO : div(net, subtotal);
  const netByClass = new Map([...byClass].map(([c, v]) => [c, mul(v, share)]));

  const rules = (data.tax_rules || []).filter((r) => applies(r, data.business_date));
  const inclusive = rules.filter((r) => r.inclusive);
  const inclusiveRate = new Map([...netByClass.keys()].map((c) => [c, sum(inclusive.filter((r) => covers(r, c)).map((r) => parse(r.rate)))]));
  const pretaxByClass = new Map([...netByClass].map(([c, v]) => [c, div(mul(v, HUNDRED), add(HUNDRED, inclusiveRate.get(c)))]));
  const pretax = sum([...pretaxByClass.values()]);

  const charges = [];
  let service = ZERO;
  const sc = data.service_charge;
  if (sc && cmp(parse(sc.rate), ZERO) > 0 && (sc.service_types || []).includes(data.service_type)) {
    service = roundKobo(div(mul(pretax, parse(sc.rate)), HUNDRED));
    charges.push({ kind: 'service_charge', tax_rule_id: null, name: 'Service charge', rate: rateText(sc.rate),
      inclusive: false, base: money(roundKobo(pretax)), amount: money(service) });
  }

  let added = ZERO;
  for (const rule of rules) {
    const rate = parse(rule.rate);
    let base;
    let amount;
    if (rule.inclusive) {
      const covered = [...netByClass.keys()].filter((c) => covers(rule, c));
      base = sum(covered.map((c) => netByClass.get(c)));
      amount = roundKobo(sum(covered.map((c) => div(mul(netByClass.get(c), rate), add(HUNDRED, inclusiveRate.get(c))))));
    } else {
      base = sum([...pretaxByClass].filter(([c]) => covers(rule, c)).map(([, v]) => v));
      if (rule.applies_to_service_charge) base = add(base, service);
      amount = roundKobo(div(mul(base, rate), HUNDRED));
      added = add(added, amount);
    }
    charges.push({ kind: 'tax', tax_rule_id: rule.id, name: rule.name, rate: rateText(rule.rate),
      inclusive: Boolean(rule.inclusive), base: money(roundKobo(base)), amount: money(amount) });
  }

  return { subtotal: money(subtotal), discount: money(discount), net: money(net), charges, total: money(add(add(net, service), added)) };
}

function computeBillOrError(data) {
  try { return computeBill(data); } catch (e) { if (e instanceof BillError) return { error: e.code }; throw e; }
}

/** Compare two money strings exactly: -1, 0, 1. */
const compareMoney = (a, b) => cmp(parse(a), parse(b));
const addMoney = (a, b) => money(add(parse(a), parse(b)));
const subMoney = (a, b) => money(sub(parse(a), parse(b)));

module.exports = { computeBill, computeBillOrError, BillError, compareMoney, addMoney, subMoney };
