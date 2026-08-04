import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HOME, ROOT } from './paths';

// Mirrors the key scheme in packages/server/src/daemonfile.ts (already
// duplicated by the CLI, MCP, and sidecar.rs — see that file's header
// comment). This is a read-only sixth copy that only ever resolves the
// harness's own daemon file; it does not need the full read/write module.
function daemonFilePath(): string {
  const key = createHash('sha256').update(ROOT).digest('hex').slice(0, 12);
  return join(HOME, '.dispatch', 'daemons', `${key}.json`);
}

const POLL_INTERVAL_MS = 200;
const TIMEOUT_MS = 15_000;

/**
 * Waits for the e2e daemon to write its per-daemon auth token, then hands it
 * to every test worker via `process.env.DISPATCH_E2E_TOKEN`.
 *
 * The webServer's port check only proves the daemon is listening, not that it
 * has finished writing its daemon file — that write can lose the race, so
 * this polls the file itself instead of trusting the port check alone. Since
 * 370167b every data fetch is bearer-token gated, so without a token the app
 * silently renders its empty states and the resulting screenshots would look
 * like passing baselines while capturing nothing real. Throwing here instead
 * fails the whole suite loudly, which is the point.
 */
export default async function globalSetup(): Promise<void> {
  const path = daemonFilePath();
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const info = JSON.parse(readFileSync(path, 'utf8')) as {
        agentToken?: string;
      };
      if (info.agentToken) {
        process.env.DISPATCH_E2E_TOKEN = info.agentToken;
        return;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `e2e daemon never wrote an agentToken to ${path} within ${TIMEOUT_MS}ms. ` +
      'Every view test needs this token to authenticate past the per-daemon ' +
      'auth gate (370167b); without it every screenshot would silently capture ' +
      "the app's empty state instead of real fixture data."
  );
}
