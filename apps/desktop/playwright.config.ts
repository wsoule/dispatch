import { defineConfig } from '@playwright/test';

import {
  APP_TOKEN,
  DAEMON_PORT,
  HOME,
  REPO,
  ROOT,
  VITE_PORT,
} from './e2e/paths';

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
  projects: [
    { name: 'dark', use: { colorScheme: 'dark' } },
    { name: 'light', use: { colorScheme: 'light' } },
  ],
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
