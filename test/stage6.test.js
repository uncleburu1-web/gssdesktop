// Stage 6: sign-in tokens encrypted at rest with the OS keychain (Electron safeStorage).
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbm, makeDb } = require('./helpers');
const secrets = require('../src/main/secrets');
const { getStoredTokens, getAccessToken } = require('../src/main/auth');

const fakeKeychain = {
  isEncryptionAvailable: () => true,
  encryptString: (t) => Buffer.from(`sealed:${Buffer.from(t).toString('hex')}`),
  decryptString: (b) => {
    const s = b.toString();
    if (!s.startsWith('sealed:')) throw new Error('bad');
    return Buffer.from(s.slice(7), 'hex').toString();
  },
};
const raw = (db) => db.prepare(`SELECT value FROM app_settings WHERE key = 'auth_tokens'`).get().value;

test('without a keychain (plain Node) tokens are stored exactly as before', () => {
  const { db, cleanup } = makeDb();
  try {
    secrets._setSafeStorageForTests(null);
    dbm.setSetting(db, 'auth_tokens', JSON.stringify({ access: 'a1', refresh: 'r1' }));
    assert.equal(getAccessToken(db), 'a1');
    assert.equal(raw(db), JSON.stringify({ access: 'a1', refresh: 'r1' }));
  } finally { cleanup(); }
});

test('with a keychain, an old plaintext row is encrypted on first read and still works', () => {
  const { db, cleanup } = makeDb();
  try {
    secrets._setSafeStorageForTests(fakeKeychain);
    dbm.setSetting(db, 'auth_tokens', JSON.stringify({ access: 'a1', refresh: 'r1' }));
    assert.deepEqual(getStoredTokens(db), { access: 'a1', refresh: 'r1' });
    assert.ok(raw(db).startsWith('enc:v1:'), 'now sealed');
    assert.ok(!raw(db).includes('r1'), 'the refresh token is not readable in the file');
    assert.equal(getAccessToken(db), 'a1');
  } finally { secrets._setSafeStorageForTests(null); cleanup(); }
});

test('a database copied to a machine that cannot decrypt it just reads as signed out', () => {
  const { db, cleanup } = makeDb();
  try {
    secrets._setSafeStorageForTests(fakeKeychain);
    dbm.setSetting(db, 'auth_tokens', JSON.stringify({ access: 'a1', refresh: 'r1' }));
    getStoredTokens(db);
    secrets._setSafeStorageForTests({ ...fakeKeychain, decryptString: () => { throw new Error('other user'); } });
    assert.equal(getStoredTokens(db), null);
    secrets._setSafeStorageForTests(null);
    assert.equal(getStoredTokens(db), null, 'no keychain at all: also signed out, never a crash');
  } finally { secrets._setSafeStorageForTests(null); cleanup(); }
});
