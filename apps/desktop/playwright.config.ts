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
  // Screenshots differ subtly across machines; keep CI honest but not flaky.
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  use: {
    baseURL: `http://localhost:${VITE_PORT}/?root=${ROOT}&port=${DAEMON_PORT}`,
    colorScheme: 'dark',
    viewport: { width: 1036, height: 1161 },
  },
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
