import { defineConfig } from '@playwright/test';

import { DAEMON_PORT, HOME, REPO, ROOT, VITE_PORT } from './e2e/paths';

export default defineConfig({
  testDir: './e2e',
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
      command: `DISPATCH_HOME=${HOME} bun ${REPO}/packages/server/src/bin.ts --root ${ROOT} --port ${DAEMON_PORT}`,
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
