// The till's own copy of the stock categories per kind of shop (it works offline, so it cannot ask the
// server each time). Must match gss inventory/models.py CATEGORY_GROUPS, now with restaurants
// (owner's decision 13: a restaurant is a kind of shop; /api/me sends the branch's kind).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const load = () => import(path.join(__dirname, '..', 'src', 'renderer', 'categories.js'));

const SERVER_GROUPS = {
  gadgets: ['laptop', 'part', 'accessory', 'consumable'],
  pharmacy: ['medicine', 'tablet_capsule', 'syrup_liquid', 'injection', 'medical_supply', 'equipment'],
  clothing: ['apparel_top', 'apparel_bottom', 'footwear', 'outerwear', 'clothing_accessory'],
  general: ['grocery', 'household', 'stationery', 'beverage'],
  restaurant: ['beverage', 'ingredient', 'packaging', 'kitchen_supply'],
};

test('each kind of shop offers the server\'s categories, Other last, every one labelled', async () => {
  const { categoriesForBusinessType, CATEGORY_LABELS } = await load();
  for (const [kind, codes] of Object.entries(SERVER_GROUPS)) {
    const got = categoriesForBusinessType(kind);
    assert.deepEqual(got, [...codes, 'other'], kind);
    for (const code of got) assert.ok(CATEGORY_LABELS[code], `${code} has a label`);
  }
  assert.equal(CATEGORY_LABELS.ingredient, 'Food ingredient');
});

test('an unknown kind (a newer server) still offers Other', async () => {
  const { categoriesForBusinessType } = await load();
  assert.deepEqual(categoriesForBusinessType('bakery'), ['other']);
});
