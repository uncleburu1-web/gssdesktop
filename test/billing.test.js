// The hub's bill must match the cloud's exactly: the same hand-worked cases as gss/restaurant/tests.py.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { computeBillOrError, compareMoney, subMoney } = require('../src/main/restaurant/billing');

const file = path.join(__dirname, 'billing_vectors.json');
const { cases } = JSON.parse(fs.readFileSync(file, 'utf8'));

test('every shared bill case matches', () => {
  assert.ok(cases.length >= 15);
  for (const c of cases) assert.deepEqual(computeBillOrError(c.input), c.expect, c.name);
});

test('the cases file is the same as the cloud copy when both repos are side by side', (t) => {
  const cloud = path.join(__dirname, '..', '..', 'gss', 'restaurant', 'billing_vectors.json');
  if (!fs.existsSync(cloud)) { t.skip('gss repo not next to this one'); return; }
  assert.equal(fs.readFileSync(cloud, 'utf8'), fs.readFileSync(file, 'utf8'));
});

test('a billion-naira bill keeps every kobo (no floating point)', () => {
  const r = computeBillOrError({ service_type: 'counter', business_date: '2026-10-21', discount: null, service_charge: null,
    lines: [{ id: 'x', unit_price: '999999999.99', quantity: '3', tax_class: 'food' }],
    tax_rules: [{ id: 'v', name: 'VAT', rate: '7.5', inclusive: false, tax_classes: [], valid_from: '2026-01-01', valid_to: null, is_active: true }] });
  assert.equal(r.subtotal, '2999999999.97');
  // 2,999,999,999.97 x 0.075 = 224,999,999.99775: that is 0.775 of a kobo past .99, so half-up gives 225,000,000.00
  assert.equal(r.charges[0].amount, '225000000.00');
  assert.equal(r.total, '3224999999.97');
});

test('money helpers', () => {
  assert.equal(compareMoney('10.00', '9.99'), 1);
  assert.equal(subMoney('58800.00', '0.01'), '58799.99');
});
