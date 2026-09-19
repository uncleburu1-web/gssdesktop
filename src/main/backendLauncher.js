const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * For local/single-machine testing: automatically starts the Django
 * backend as a background process so there's nothing to manually run in
 * a separate terminal.
 *
 * IMPORTANT — this is a development/testing convenience, NOT a substitute
 * for deploying a real cloud backend. It only activates when
 * BENCHLINE_API_URL is left unset or pointed at localhost — if it's set
 * to a real deployed URL (e.g. your Render/Railway instance), nothing
 * here runs, and the desktop just talks to that instead. Bundling this
 * with a *real* cloud backend running elsewhere is exactly the
 * architecture: this local instance is only ever a convenience for the
 * one machine it runs on. A local-only backend can never be what the
 * Android CEO app talks to from somewhere else — see the top-level
 * conversation for why.
 */
function shouldSpawnLocalBackend() {
  const configuredUrl = process.env.BENCHLINE_API_URL;
  return !configuredUrl || configuredUrl.includes('localhost') || configuredUrl.includes('127.0.0.1');
}

function findBackendDir() {
  // Expects the Django project to sit alongside this desktop app, i.e.
  // benchline/backend next to benchline/desktop, matching this repo's
  // layout. A packaged installer would need to bundle this directory (or
  // a PyInstaller-built standalone executable) under resources/ instead —
  // building that .exe has to happen on an actual Windows machine, same
  // constraint as everything else native in this project.
  const candidate = path.join(__dirname, '..', '..', '..', 'backend');
  return fs.existsSync(path.join(candidate, 'manage.py')) ? candidate : null;
}

let backendProcess = null;

function startLocalBackend({ onReady, onFail } = {}) {
  if (!shouldSpawnLocalBackend()) {
    onReady?.(); // a real remote URL is already configured — nothing to spawn or wait for
    return null;
  }

  const backendDir = findBackendDir();
  if (!backendDir) {
    const err = new Error('No backend/ folder found next to the desktop app — skipping local auto-start.');
    console.warn('[backend-launcher]', err.message);
    onFail?.(err);
    return null;
  }

  const venvPython = process.platform === 'win32'
    ? path.join(backendDir, 'venv', 'Scripts', 'python.exe')
    : path.join(backendDir, 'venv', 'bin', 'python');
  const pythonBin = fs.existsSync(venvPython) ? venvPython : 'python';

  backendProcess = spawn(
    pythonBin,
    ['manage.py', 'runserver', '127.0.0.1:8000', '--noreload'],
    { cwd: backendDir, env: { ...process.env, USE_SQLITE: process.env.USE_SQLITE || 'True' } }
  );

  backendProcess.stdout.on('data', (d) => console.log('[django]', d.toString().trim()));
  backendProcess.stderr.on('data', (d) => console.log('[django:err]', d.toString().trim()));
  backendProcess.on('error', (err) => onFail?.(err));

  waitForServer('http://127.0.0.1:8000/api/health/', 15000)
    .then(() => onReady?.())
    .catch((err) => onFail?.(err));

  return backendProcess;
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Local backend did not become ready within 15s.');
}

function stopLocalBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

module.exports = { startLocalBackend, stopLocalBackend, shouldSpawnLocalBackend };
