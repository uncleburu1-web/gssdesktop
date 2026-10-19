/**
 * Sign-in tokens at rest. Encrypted with the operating system's keychain (Electron safeStorage:
 * DPAPI on Windows, Keychain on macOS, libsecret on Linux) so a copied till database file does
 * not carry a usable session with it.
 *
 *   sealed value: 'enc:v1:<base64>'     legacy / no keychain: the plain JSON, exactly as before
 *
 * Reading never fails a sign-in-free operation: a value that can no longer be decrypted (the
 * database was moved to another Windows account or PC) reads as "not signed in", and the cashier
 * simply signs in again. Selling offline never depends on these tokens.
 */
const PREFIX = 'enc:v1:';

let safeStorage = null;
try {
  // Only inside Electron's main process; plain Node (tests, tools) has no keychain and keeps plaintext.
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.safeStorage) safeStorage = electron.safeStorage;
} catch { /* not running under Electron */ }

function available() {
  try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}

function seal(text) {
  if (!available()) return text;
  return PREFIX + safeStorage.encryptString(text).toString('base64');
}

/** The plain text, or null when it is sealed and cannot be opened here. */
function unseal(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  if (!available()) return null;
  try { return safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64')); } catch { return null; }
}

const isSealed = (value) => typeof value === 'string' && value.startsWith(PREFIX);

/** Tests only: stand in for the OS keychain. */
function _setSafeStorageForTests(fake) { safeStorage = fake; }

module.exports = { seal, unseal, isSealed, available, _setSafeStorageForTests };
