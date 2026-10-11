// Must be required FIRST by every test file: redirects `require('better-sqlite3')`
// to the node:sqlite shim and points the sync engine at a fake cloud URL.
const Module = require('module');
process.env.BENCHLINE_API_URL = 'http://cloud.test/api';

const realLoad = Module._load;
Module._load = function patched(request, ...rest) {
  if (request === 'better-sqlite3') return require('./better-sqlite3-shim');
  return realLoad.call(this, request, ...rest);
};

// No real sockets in tests: sync.js treats a failing WebSocket constructor as "retry later".
globalThis.WebSocket = class NoSocketInTests {
  constructor() { throw new Error('WebSocket disabled in tests'); }
};
