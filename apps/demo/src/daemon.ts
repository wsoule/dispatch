#!/usr/bin/env bun
// startServer comes from @dispatch/server's own './embed' subpath (see
// packages/server/src/embed.ts) — a narrow re-export kept separate from a
// root export so @dispatch/cli/@dispatch/mcp still cannot resolve this
// Bun-only package at all.
import { startServer } from '@dispatch/server/embed';
// FakeExecutor/FakePlanner come from @dispatch/server's own './testing'
// subpath (see packages/server/src/testing.ts) — the export surface Task 5
// settled on for consumers outside that package.
import { FakeExecutor, FakePlanner } from '@dispatch/server/testing';
import { resolve } from 'node:path';

import {
  buildStorefrontRunScript,
  STOREFRONT_PLAN_PROPOSAL,
} from './script.js';

// Minimal flag parsing, mirroring packages/server/src/bin.ts — no commander
// dependency here since this bin isn't a user-facing CLI surface.
function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 || index === args.length - 1
    ? undefined
    : args[index + 1];
}

const args = process.argv.slice(2);
const rootDir = resolve(readFlag(args, '--root') ?? process.cwd());
const portArg = readFlag(args, '--port');
const port = portArg !== undefined ? Number(portArg) : 0;

if (portArg !== undefined && Number.isNaN(port)) {
  console.error(`invalid --port: ${portArg}`);
  process.exit(1);
}

// Every seam this daemon touches (daemonfile, credentials, project registry,
// worktree homes) resolves relative to DISPATCH_HOME instead of the real
// homedir — required so one visitor's session never touches another's, or
// the operator's own ~/.dispatch.
if (
  process.env.DISPATCH_HOME === undefined ||
  process.env.DISPATCH_HOME === ''
) {
  console.error('demo daemon requires DISPATCH_HOME (per-session isolation)');
  process.exit(1);
}

const handle = await startServer({
  rootDir,
  port,
  webDistDir: null, // the manager serves the UI; this daemon is API-only
  // Fakes are registered under 'claude' — api.ts falls back to 'claude' when
  // a dispatch request omits `executor`, and the real ClaudeExecutor is
  // deliberately never registered here: an anonymous web visitor must never
  // spawn a real agent.
  registerExecutors: (orchestrator) => {
    orchestrator.registerExecutor(
      'claude',
      new FakeExecutor(buildStorefrontRunScript())
    );
  },
  registerPlanners: (planManager) => {
    planManager.registerPlanner(
      'claude',
      new FakePlanner({ ok: true, proposal: STOREFRONT_PLAN_PROPOSAL })
    );
  },
  boardSyncPeriodicMs: 15_000, // teammate pushes should surface fast in a demo
});

console.log(`dispatchd listening on http://127.0.0.1:${handle.port}`);
console.log(`DISPATCH_APP_TOKEN=${handle.tokens.appToken}`);
// Unlike bin.ts, this also prints the agent token: the manager (same
// container, same trust domain) injects it into the served UI, exactly as
// dispatchd's own static serving would for a locally-run daemon.
console.log(`DISPATCH_AGENT_TOKEN=${handle.tokens.agentToken}`);

async function shutdown() {
  await handle.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
