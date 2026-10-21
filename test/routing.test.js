// Kitchen routing on the hub must match the cloud exactly: same cases as gss/restaurant/tests.py.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { stationFor, route } = require('../src/main/restaurant/routing');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'routing_vectors.json'), 'utf8'));

test('station rules match the shared cases', () => {
  for (const c of vectors.station_for) assert.equal(stationFor(c.item, c.category, c.active), c.expect, c.name);
});

test('routing matches the shared cases', () => {
  for (const c of vectors.route) assert.deepEqual(route(c.lines), c.expect, c.name);
});

test('the vectors file is the same as the cloud copy when both repos are side by side', (t) => {
  const cloud = path.join(__dirname, '..', '..', 'gss', 'restaurant', 'routing_vectors.json');
  if (!fs.existsSync(cloud)) { t.skip('gss repo not next to this one'); return; }
  assert.equal(fs.readFileSync(cloud, 'utf8'), fs.readFileSync(path.join(__dirname, 'routing_vectors.json'), 'utf8'));
});
