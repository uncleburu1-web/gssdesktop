# Till release checklist

Every push to `main` builds an installer and creates a GitHub Release as a **draft**. Tills only
see *published* releases, so the draft is the release gate: nothing reaches a shop until someone
runs this list and publishes. (Decision of 21 Oct 2026, see `gss/PROJECT_TRACKER.md`.)

Do not publish a build that contains unfinished restaurant work; restaurant work lives on its own
branches until it is released on purpose.

## Before publishing

| # | Check | How | Pass when |
| --- | --- | --- | --- |
| 1 | It builds | GitHub Actions "Build Windows Installer" for the commit | Green, and the draft has `GSS-Setup.exe`, its `.blockmap` and `latest.yml` |
| 2 | Unit tests | `npm test` | All pass |
| 3 | Database upgrade on the shop's real data | `node tools/check-upgrade-on-copy.js <copy of a real till .db>` (copy taken while the app is closed) | `RESULT: SAFE` |
| 4 | Selling, stock, payments, returns, promotions against a real server | `node e2e/till-e2e.cjs` on a **freshly seeded** database; `node e2e/till-e2e2.cjs` after the web E2E (`gssfrontend/e2e/stages-7-10.e2e.cjs`); `node e2e/till-weight.cjs` | All pass |
| 5 | Internet outage, offline sign-in, restart, recovery, no duplicates | `E2E_SERVER_CMD=<start/stop script> node e2e/till-outage.cjs` | All pass |
| 6 | Installer keeps the existing data | `appId` (`com.gss.pos`), package `name` (`desktop`) and the database file name in `src/main/main.js` are unchanged since the last published release (they decide where the data lives) | Unchanged, or a migration of the data folder is part of the release |
| 7 | Upgrade on a real Windows PC | Install the currently published version on a spare PC, sign in, make a sale, then install the new `GSS-Setup.exe` over it | The sale and sign-in survive; the app opens on the new version |
| 8 | Known bugs | Tracker in `gss/PROJECT_TRACKER.md` | No open bug marked release-blocking |

## Publishing

1. Edit the draft release on GitHub, add short notes, untick "draft", publish.
2. Within a day, check that the shop's till reports the new version: `app_version` on its row in
   `GET /api/devices/` or Django admin → Devices. (The web app does not display the version yet.)
3. Record the version, date and the evidence above in `gss/PROJECT_TRACKER.md`.

## If something goes wrong

Publish the previous installer again as a newer version number (electron-updater only moves
forward), or ask the shop to reinstall the previous `GSS-Setup.exe` by hand. The till database is
never touched by uninstalling.
