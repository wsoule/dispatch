import { defineConfig } from '@playwright/test';

import {
  APP_TOKEN,
  DAEMON_PORT,
  HOME,
  REPO,
  ROOT,
  VITE_PORT,
} from './e2e/paths';

// The opt-in WebKit pass (`DISPATCH_E2E_WEBKIT=1`, set by
// .github/workflows/desktop-macos.yml). Tauri renders with WKWebView on macOS,
// so this runs the suite in Playwright's WebKit instead of Chromium. Unset,
// which is every local run and every Linux shell, the config is the Chromium
// suite it always was.
const WEBKIT_PASS = process.env.DISPATCH_E2E_WEBKIT === '1';

// Where an HTML report goes, relative to this file, when the caller asks for
// one (the macOS workflow uploads it). Unset keeps Playwright's default
// console reporter and writes no report.
const REPORT_DIR = process.env.DISPATCH_E2E_REPORT_DIR;

// The screenshot spec compares against Chromium baselines; the webkit specs
// only save shots for eye review and run in the WebKit pass alone. Both match
// the file name after its folder's separator, so `webkit-views.spec.ts` is
// not taken for `views.spec.ts`.
const SCREENSHOT_SPEC = /[\\/]views\.spec\.ts$/;
const WEBKIT_SPECS = /[\\/]webkit[^\\/]*\.spec\.ts$/;

// The two theme projects of one pass. In the WebKit pass they keep the names
// `dark` and `light` on purpose: the theme-independent flows skip every
// project but `dark` (`test.skip(testInfo.project.name !== 'dark', ...)`), so
// a project named `webkit` would skip all of them. The WebKit pass drops the
// screenshot spec, whose baselines are Chromium's, and nothing in it compares
// pixels. Exported for playwright.config.test.ts.
export function e2eProjects(webkitPass: boolean) {
  return (['dark', 'light'] as const).map((theme) =>
    webkitPass
      ? {
          name: theme,
          testIgnore: SCREENSHOT_SPEC,
          use: { browserName: 'webkit' as const, colorScheme: theme },
        }
      : { name: theme, testIgnore: WEBKIT_SPECS, use: { colorScheme: theme } }
  );
}

export default defineConfig({
  testDir: './e2e',
  // The specs that only read share one live daemon and its fixture, which
  // views.spec.ts screenshots; every spec that writes (dispatches a run,
  // answers or reads a message, saves an edit or a doc) copies the fixture
  // and boots a daemon of its own (e2e/isolatedDaemon.ts), so the shared one
  // stays as it was. One worker keeps the files from interleaving.
  workers: 1,
  // Resolves the daemon's per-run auth token (see that file's own comment for
  // why this can't just be baked into `use.baseURL` below) and fails the run
  // loudly if it never shows up, instead of letting every test silently
  // screenshot an unauthenticated, empty app.
  globalSetup: './e2e/global-setup.ts',
  // An absolute budget, not a ratio: 1% of a 1036x1161 shot is ~12k pixels, which
  // is a whole toolbar row's worth of controls moving without the gate noticing.
  expect: { toHaveScreenshot: { maxDiffPixels: 200 } },
  use: {
    baseURL: `http://localhost:${VITE_PORT}/?root=${ROOT}&port=${DAEMON_PORT}`,
    viewport: { width: 1036, height: 1161 },
  },
  // Both themes get baselines: the spec's headline decision is full light/dark
  // parity, and dark-only shots hid a `failed` mark that was invisible on white.
  projects: e2eProjects(WEBKIT_PASS),
  // Each pass keeps its own results folder: Playwright empties outputDir when
  // a run starts, and the macOS workflow runs the WebKit pass after the
  // Chromium one and uploads both.
  outputDir: WEBKIT_PASS ? 'test-results/webkit' : 'test-results',
  ...(REPORT_DIR === undefined || REPORT_DIR === ''
    ? {}
    : {
        reporter: [
          ['list'],
          ['html', { open: 'never', outputFolder: REPORT_DIR }],
        ],
      }),
  webServer: [
    {
      // DISPATCH_ENABLE_FAKES registers the scripted 'fake' executor, planner,
      // and overseer backend alongside the real ones (see bin.ts) — overseer.spec.ts
      // drives the chat's confirm/deny flow through them, with no live LLM.
      // Nothing uses a fake unless a request names it, so the screenshot specs
      // see the same daemon they always did.
      command: `DISPATCH_HOME=${HOME} DISPATCH_ENABLE_FAKES=1 DISPATCH_APP_TOKEN=${APP_TOKEN} bun ${REPO}/packages/server/src/bin.ts --root ${ROOT} --port ${DAEMON_PORT}`,
      port: DAEMON_PORT,
      reuseExistingServer: true,
    },
    {
      command: `bun run dev --port ${VITE_PORT}`,
      port: VITE_PORT,
      reuseExistingServer: true,
    },
  ],
});
