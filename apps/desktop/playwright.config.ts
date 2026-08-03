import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// The storefront mock and its DISPATCH_HOME live in .agents/ignore so the suite
// never touches real task state. The daemon port is pinned (bin.ts defaults to
// 0, i.e. random) so the app URL below can be a constant.
const REPO = resolve(import.meta.dirname, '../..');
const ROOT = resolve(REPO, '.agents/ignore/storefront');
const HOME = resolve(REPO, '.agents/ignore/storefront-home');
const DAEMON_PORT = 57999;
const VITE_PORT = 5199;

export default defineConfig({
  testDir: './e2e',
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
