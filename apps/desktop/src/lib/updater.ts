import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

import { isTauri } from './tauri';

// Checks GitHub's `latest.json` (see tauri.conf.json's `plugins.updater`) for a
// newer signed release. Returns the pending `Update` when one is available, or
// `null` when the app is current, running outside the Tauri webview (the
// plain-browser dev harness has no updater plugin), or the check failed for any
// reason — a failed update check must never surface as an error the user has to
// deal with, so callers can treat `null` uniformly as "nothing to offer."
export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauri()) return null;
  try {
    // `check()` resolves to `null` when the running version already satisfies
    // the manifest, or an `Update` handle when a newer one is published.
    return await check();
  } catch (err) {
    console.error('updater: check failed', err);
    return null;
  }
}

// Downloads and installs the pending update, then relaunches into it. This is
// the standard tauri-plugin-updater flow: `downloadAndInstall()` stages the new
// version (on macOS it swaps the `.app` in place from the signed `.app.tar.gz`),
// and `relaunch()` (from tauri-plugin-process) restarts the app so the user
// lands on the new build. Throws on failure so the banner can re-enable its
// button and report it rather than leaving the user staring at a dead spinner.
export async function installUpdateAndRelaunch(update: Update): Promise<void> {
  await update.downloadAndInstall();
  await relaunch();
}
