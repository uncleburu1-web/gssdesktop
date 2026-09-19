// Mirrors backend/inventory/models.py CATEGORY_CHOICES / CATEGORY_GROUPS.
// The desktop till is offline-capable, so it can't just fetch this from
// the API on every render the way the web/mobile Inventory pages read
// `available_categories` off /api/me/ — it needs its own copy here. Keep
// this in sync with the backend list by hand if categories ever change
// there; there's no build-time sharing between the Python and Electron
// sides of this repo.
export const CATEGORY_LABELS = {
  laptop: 'Laptop', part: 'Part', accessory: 'Accessory', consumable: 'Consumable',
  medicine: 'Medicine / Drug', tablet_capsule: 'Tablet / Capsule', syrup_liquid: 'Syrup / Liquid',
  injection: 'Injection', medical_supply: 'Medical supply', equipment: 'Equipment',
  apparel_top: 'Top / Shirt', apparel_bottom: 'Trousers / Skirt', footwear: 'Footwear',
  outerwear: 'Outerwear', clothing_accessory: 'Bag / Fashion accessory',
  grocery: 'Grocery', household: 'Household item', stationery: 'Stationery', beverage: 'Beverage',
  other: 'Other',
};

const CATEGORY_GROUPS = {
  gadgets: ['laptop', 'part', 'accessory', 'consumable'],
  pharmacy: ['medicine', 'tablet_capsule', 'syrup_liquid', 'injection', 'medical_supply', 'equipment'],
  clothing: ['apparel_top', 'apparel_bottom', 'footwear', 'outerwear', 'clothing_accessory'],
  general: ['grocery', 'household', 'stationery', 'beverage'],
};

// Category codes relevant to one business type, 'other' always last —
// what the "Category" picker on Products should offer, instead of the
// old hard-coded ['laptop','part','accessory','consumable','other'] that
// showed on every till regardless of what the shop actually sells.
export function categoriesForBusinessType(businessType) {
  const codes = CATEGORY_GROUPS[businessType] || [];
  return [...codes, 'other'];
}
