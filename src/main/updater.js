const { autoUpdater } = require('electron-updater');
const { dialog, app } = require('electron');

/**
 * Checks the gssdesktop GitHub repo (see package.json's "build.publish")
 * for a newer signed installer than the one currently running — once on
 * launch, then every few hours, since a shop till is usually left open
 * all day and a launch-only check could miss a same-day release.
 *
 * Never downloads or installs without asking first: this mirrors the
 * confirm-before-installing pattern the website's download buttons use
 * (Settings.jsx), just as a native dialog instead of a browser confirm().
 */
function startUpdateChecks(getMainWindow) {
  // Only packaged (installed) builds have a real update feed to check —
  // `npx electron .` in dev has no latest.yml and would just log a
  // confusing "update not available" error on every launch.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info) => {
    const win = getMainWindow();
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update available',
      message: `A new version of GSS POS is available (${info.version}). Download it now?`,
      detail: 'You can keep using the till while it downloads in the background.',
      buttons: ['Download', 'Not now'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.downloadUpdate().catch(() => {});
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const win = getMainWindow();
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready to install',
      message: `GSS POS ${info.version} has downloaded. Restart now to install it?`,
      detail: 'Nothing is lost — any sale in progress is saved locally before it restarts.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    // Almost always just "offline right now" — a shop till loses internet
    // regularly and that should never surface as an alarming error dialog.
    console.warn('[updater] check failed (likely offline):', err.message);
  });

  const check = () => autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[updater] checkForUpdates failed:', err.message);
  });

  check();
  setInterval(check, 4 * 60 * 60 * 1000); // every 4 hours
}

module.exports = { startUpdateChecks };
