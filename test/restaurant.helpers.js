// A configured restaurant hub for tests: configuration loaded exactly as a cloud pull delivers it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dbm } = require('./helpers');
const { getOrCreateDeviceId } = require('../src/main/device');

const ID = {
  area: 'a1', t1: 'tbl-1', t2: 'tbl-2', kitchen: 'st-kitchen', bar: 'st-bar', grill: 'st-grill',
  mains: 'cat-mains', drinks: 'cat-drinks', water: 'cat-water',
  jollof: 'it-jollof', suya: 'it-suya', chapman: 'it-chapman', bottled: 'it-water',
  size: 'g-size', extras: 'g-extras', regular: 'o-regular', large: 'o-large', chicken: 'o-chicken', plantain: 'o-plantain',
  vat: 'tax-vat',
};

function hub({ protocol = 6, service = '10', servedRule = false, hubDevice = 'this', modules = ['retail', 'restaurant'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  const file = path.join(dir, 'pos.db');
  const db = dbm.openDb(file);
  dbm.setSetting(db, 'cloud_sync_protocol', String(protocol));
  dbm.setSetting(db, 'shop_settings', JSON.stringify({ name: 'Test Kitchen', modules }));
  // By default this till IS the branch's hub, as the owner would set it in the cloud.
  const hubDeviceId = hubDevice === 'this' ? getOrCreateDeviceId(db) : hubDevice;
  const pull = (type, payload) => dbm.applyPulledOperation(db, type, 'update', payload);
  pull('restaurant_settings', { id: 's1', hub_device_id: hubDeviceId, service_charge_rate: service, service_charge_types: ['dine_in'], require_served_before_payment: servedRule, order_number_prefix: 'K-', business_day_starts_at: '05:00' });
  pull('dining_area', { id: ID.area, name: 'Hall', sort: 0, is_active: true });
  pull('restaurant_table', { id: ID.t1, area_id: ID.area, label: 'T1', seats: 4, sort: 1, is_active: true });
  pull('restaurant_table', { id: ID.t2, area_id: ID.area, label: 'T2', seats: 2, sort: 2, is_active: true });
  pull('kitchen_station', { id: ID.kitchen, name: 'Kitchen', prints: true, shows_on_screen: true, sort: 0, is_active: true });
  pull('kitchen_station', { id: ID.bar, name: 'Bar', prints: true, shows_on_screen: false, sort: 1, is_active: true });
  pull('kitchen_station', { id: ID.grill, name: 'Grill', prints: true, shows_on_screen: false, sort: 2, is_active: false });
  pull('menu_category', { id: ID.mains, name: 'Mains', station_id: ID.kitchen, sort: 0, is_active: true });
  pull('menu_category', { id: ID.drinks, name: 'Drinks', station_id: ID.bar, sort: 1, is_active: true });
  pull('menu_category', { id: ID.water, name: 'Water', station_id: null, sort: 2, is_active: true });
  pull('menu_item', { id: ID.jollof, category_id: ID.mains, name: 'Jollof rice', price: '3500.00', tax_class: 'food', is_available: true, is_active: true });
  pull('menu_item', { id: ID.suya, category_id: ID.mains, name: 'Suya', price: '2000.00', station_id: ID.grill, tax_class: 'food', is_available: true, is_active: true });
  pull('menu_item', { id: ID.chapman, category_id: ID.drinks, name: 'Chapman', price: '1500.00', tax_class: 'drink', is_available: true, is_active: true });
  pull('menu_item', { id: ID.bottled, category_id: ID.water, name: 'Bottled water', price: '300.00', tax_class: 'drink', is_available: true, is_active: true });
  pull('modifier_group', { id: ID.size, name: 'Size', min_select: 1, max_select: 1, is_active: true });
  pull('modifier_group', { id: ID.extras, name: 'Extras', min_select: 0, max_select: 2, is_active: true });
  pull('modifier_option', { id: ID.regular, group_id: ID.size, name: 'Regular', price_delta: '0.00', is_available: true, is_active: true });
  pull('modifier_option', { id: ID.large, group_id: ID.size, name: 'Large', price_delta: '500.00', is_available: true, is_active: true });
  pull('modifier_option', { id: ID.chicken, group_id: ID.extras, name: 'Chicken', price_delta: '1000.00', is_available: true, is_active: true });
  pull('modifier_option', { id: ID.plantain, group_id: ID.extras, name: 'Plantain', price_delta: '300.00', is_available: false, is_active: true });
  pull('menu_item_modifier_group', { id: 'l1', menu_item_id: ID.jollof, group_id: ID.size, sort: 0 });
  pull('menu_item_modifier_group', { id: 'l2', menu_item_id: ID.jollof, group_id: ID.extras, sort: 1 });
  pull('tax_rule', { id: ID.vat, name: 'VAT', rate: '7.5', inclusive: false, tax_classes: [], applies_to_service_charge: false, valid_from: '2026-01-01', valid_to: null, is_active: true });
  return { db, file, cleanup: () => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

const owner = { user: 'ada', isOwner: true };
const waiter = { user: 'wale', role: 'waiter', capabilities: { take_orders: true, send_to_kitchen: true, move_table: true } };
const cashier = { user: 'chi', role: 'cashier', capabilities: { take_orders: true, send_to_kitchen: true, take_payment: true, move_table: true } };
const kitchenScreen = { user: 'kitchen-screen', isScreen: true, stationIds: [ID.kitchen] };
module.exports = { hub, ID, owner, waiter, cashier, kitchenScreen };
