import { resolve } from 'node:path';

// Shared by playwright.config.ts and global-setup.ts so the harness's
// storefront fixture root/home and ports stay a single source of truth.
export const REPO = resolve(import.meta.dirname, '../../..');
export const ROOT = resolve(REPO, '.agents/ignore/storefront');
export const HOME = resolve(REPO, '.agents/ignore/storefront-home');
export const DAEMON_PORT = 57999;
export const VITE_PORT = 5199;
// The decide-tier token the harness presets on its daemon (see
// playwright.config.ts) and hands to the app as `?appToken=`, since a browser
// cannot read the daemon's stdout line. A constant on purpose: the config and
// every test worker are separate processes that must agree on it, and the
// daemon it guards only exists on a fixed localhost port for the run.
export const APP_TOKEN = 'e2e-app-token-storefront-harness';

/**
 * Git config for every daemon the suite starts: the fixture repo's own
 * identity (packages/demo/src/repo.ts), passed as GIT_CONFIG_* environment
 * entries (git 2.31+), which outrank the machine's global config. Setup's git
 * step reads `git config --get user.name` and `user.email` from the machine,
 * so without this a runner with no identity (a GitHub macOS runner) draws
 * Setup's "Git needs your name and email" banner across the top of every
 * screenshot and a developer's Mac does not, and the -darwin baselines would
 * pass on one and fail on the other.
 */
export const DAEMON_GIT_ENV = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'user.name',
  GIT_CONFIG_VALUE_0: 'Dispatch Demo',
  GIT_CONFIG_KEY_1: 'user.email',
  GIT_CONFIG_VALUE_1: 'demo@example.com',
} as const;

/**
 * The browser storage every e2e page starts with: Setup marked done for the
 * Vite origin. The app shows its first-launch Setup screen instead of the
 * shell whenever the daemon's setup report is not all ok, which is what a
 * machine without an agent CLI on PATH reports (a GitHub macOS runner, unlike
 * a developer's Mac), so without this the whole suite tests the Setup screen.
 * The suite tests the app behind Setup, not this machine's toolchain. The
 * key is lib/setupState.ts's, spelled out so a rename fails the suite here.
 * playwright.config.ts sets it for the test's own context; a spec that opens
 * a second context passes it to browser.newContext itself.
 */
export const SETUP_DONE = {
  cookies: [],
  origins: [
    {
      origin: `http://localhost:${VITE_PORT}`,
      localStorage: [{ name: 'dispatch:setup-complete', value: 'true' }],
    },
  ],
};
