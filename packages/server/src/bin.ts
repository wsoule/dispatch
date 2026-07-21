#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { startServer } from './index.js';
import { ClaudeExecutor } from './orchestrator/executors/claude.js';
import type { FakeExecutorScript } from './orchestrator/executors/fake.js';
import { FakeExecutor } from './orchestrator/executors/fake.js';
import type { PlanProposal } from './orchestrator/planner.js';
import { ClaudePlanner } from './orchestrator/planners/claude.js';
import { FakePlanner } from './orchestrator/planners/fake.js';
import type { CommandRunner } from './orchestrator/pr.js';

// ---------------------------------------------------------------------------
// Phase 7 fakes hook (DISPATCH_ENABLE_FAKES / DISPATCH_FAKE_APPROVAL)
//
// Production dispatchd (every real `dispatch serve`/`dispatch ui` and the
// desktop app's release-build sidecar) registers ONLY the real ClaudeExecutor
// (as 'claude') and ClaudePlanner (as 'claude') — see index.ts's own
// defaults. Setting `DISPATCH_ENABLE_FAKES=1` in this process's environment
// additionally registers a FakeExecutor and FakePlanner, both under the name
// 'fake', alongside the real ones — never replacing 'claude'. This exists
// purely so the CLI's headless integration tests (and any other e2e script)
// can drive a REAL spawned daemon through a full run/plan lifecycle without
// spending real Claude budget: `dispatch run <id> --executor fake` and
// `dispatch plan <prompt> --planner fake` only work against a daemon booted
// this way. The desktop app's own hidden "dispatch with the fake executor"
// dev toggle (apps/desktop/src/lib/devTools.ts) relies on the same env var —
// its Rust sidecar sets it for debug builds only (see sidecar.rs's
// BunSpawner), so a packaged release build never carries it.
//
// `DISPATCH_FAKE_APPROVAL=1` (only meaningful alongside DISPATCH_ENABLE_FAKES)
// adds an approval-gate step to the default fake script below, so an e2e run
// can also exercise the CLI's approve/deny round-trip, not just a plain
// finish.
// ---------------------------------------------------------------------------

// The one default script every DISPATCH_ENABLE_FAKES daemon's 'fake' executor
// plays back: a markdown assistant plan, two tool entries (an Edit and a Bash,
// so the desktop Session tab has rich tool cards — and a diff — to render), a
// final assistant note, one real file write + commit (so `dispatch diff`/
// `dispatch review merge` have real git content to act on), and — gated on
// DISPATCH_FAKE_APPROVAL=1 — a trailing approval request (so the CLI's
// approve/deny path has something to exercise). Kept as one fixed script rather
// than something configurable per invocation: this is a test/e2e hook, not a
// general scripting facility.
function buildDefaultFakeScript(): FakeExecutorScript {
  const steps: NonNullable<FakeExecutorScript['steps']> = [
    {
      // Markdown so the Session tab's renderer has real structure to show —
      // headings, a list, inline code, and a fenced code block.
      entry: {
        ts: new Date().toISOString(),
        kind: 'assistant',
        text: [
          '## Plan',
          '',
          "I'll make a small, safe change:",
          '',
          '1. Add a `FAKE_OUTPUT.txt` marker file',
          '2. Verify it exists',
          '3. Commit',
          '',
          'The marker looks like:',
          '',
          '```txt',
          'fake executor output — safe to discard',
          '```',
        ].join('\n'),
      },
    },
    {
      // A tool entry so the Session tab renders a rich Edit card (a diff)
      // rather than a JSON blob.
      entry: {
        ts: new Date().toISOString(),
        kind: 'tool',
        toolName: 'Edit',
        toolInput: {
          file_path: 'FAKE_OUTPUT.txt',
          old_string: '',
          new_string: 'fake executor output — safe to discard',
        },
        status: 'running',
      },
    },
    {
      entry: {
        ts: new Date().toISOString(),
        kind: 'tool',
        toolName: 'Bash',
        toolInput: {
          command: 'cat FAKE_OUTPUT.txt',
          description: 'Verify the marker file',
        },
        status: 'running',
      },
    },
    {
      entry: {
        ts: new Date().toISOString(),
        kind: 'assistant',
        text: 'Writing a change and committing it.',
      },
      write: (cwd) => {
        writeFileSync(
          `${cwd}/FAKE_OUTPUT.txt`,
          'fake executor output — safe to discard\n'
        );
      },
      commitMessage: 'fake executor: sample change',
    },
  ];
  if (process.env.DISPATCH_FAKE_APPROVAL === '1') {
    steps.push({
      approval: {
        requestId: 'fake-approval-1',
        toolName: 'run_shell',
        input: { command: 'echo hello from the fake executor' },
      },
    });
  }
  // DISPATCH_FAKE_LINGER_MS=<n> holds the fake run in the `running` state for n
  // ms before it finishes — so a live run stays open long enough to exercise
  // mid-run messaging (user→agent, agent→agent) and the live Session tab.
  const lingerMs = Number(process.env.DISPATCH_FAKE_LINGER_MS);
  if (Number.isFinite(lingerMs) && lingerMs > 0) {
    steps.push({ delayMs: lingerMs });
  }
  return {
    steps,
    finish: { state: 'finished', costUsd: 0.01, turns: steps.length },
  };
}

// The one default proposal every DISPATCH_ENABLE_FAKES daemon's 'fake'
// planner returns, regardless of the prompt it's given — an epic with two
// tasks, the second blocked on the first, so `dispatch plan --planner fake`
// has a real dependency arrow to render and `dispatch epic start` afterward
// has more than one child to dispatch.
const DEFAULT_FAKE_PROPOSAL: PlanProposal = {
  epic: {
    title: 'Fake planned epic',
    description: 'Produced by FakePlanner for DISPATCH_ENABLE_FAKES e2e runs.',
  },
  tasks: [
    {
      title: 'Fake task one',
      description: 'First scripted task from the fake planner.',
      acceptanceCriteria: ['Task one is done'],
      blockedByIndices: [],
      priority: 'medium',
    },
    {
      title: 'Fake task two',
      description: 'Second scripted task, depends on the first.',
      acceptanceCriteria: ['Task two is done'],
      blockedByIndices: [0],
      priority: 'medium',
    },
  ],
};

// An in-memory stand-in for the `gh`/`git` CLI, gated on DISPATCH_FAKE_GH so
// the PR review surface is fully demoable/testable without a real remote. It
// keeps per-PR state (created PRs, their reviews and comments) so that posting
// a review or comment through the app actually shows up on the next status
// read — the whole open -> review -> see-your-review loop works against it.
function makeFakeGhRunner(): CommandRunner {
  interface FakePr {
    number: number;
    url: string;
    title: string;
    state: string;
    reviews: Array<Record<string, unknown>>;
    comments: Array<Record<string, unknown>>;
    lineComments: Array<Record<string, unknown>>;
  }
  const prs = new Map<string, FakePr>();
  let counter = 41;
  const ok = (stdout = '') => Promise.resolve({ ok: true, stdout, stderr: '' });
  const flagValue = (cmd: string[], name: string): string | undefined => {
    const i = cmd.indexOf(name);
    return i >= 0 && i < cmd.length - 1 ? cmd[i + 1] : undefined;
  };

  return (_cwd, cmd) => {
    const [bin, sub, action] = cmd;
    const now = new Date().toISOString();

    if (bin === 'gh' && sub === '--version')
      return ok('gh version 2.0.0 (fake)');
    if (bin === 'git' && sub === 'remote') {
      return ok('https://github.com/dispatch-demo/repo.git');
    }
    if (bin === 'git' && sub === 'push') return ok();

    if (bin === 'gh' && sub === 'pr' && action === 'create') {
      counter += 1;
      const url = `https://github.com/dispatch-demo/repo/pull/${counter}`;
      prs.set(url, {
        number: counter,
        url,
        title: flagValue(cmd, '--title') ?? 'Pull request',
        state: 'OPEN',
        reviews: [],
        comments: [
          {
            author: { login: 'teammate' },
            body: 'Thanks for opening this — taking a look now.',
            createdAt: now,
          },
        ],
        lineComments: [
          {
            user: { login: 'teammate' },
            body: 'Nit: could this marker string be a named constant?',
            created_at: now,
            path: 'FAKE_OUTPUT.txt',
            line: 1,
          },
        ],
      });
      return ok(url);
    }

    if (bin === 'gh' && sub === 'pr' && action === 'view') {
      const url = cmd[3];
      const pr = prs.get(url);
      if (flagValue(cmd, '--json') === 'state') {
        return ok(JSON.stringify({ state: pr?.state ?? 'OPEN' }));
      }
      const approved = pr?.reviews.some((r) => r.state === 'APPROVED') ?? false;
      const changes =
        pr?.reviews.some((r) => r.state === 'CHANGES_REQUESTED') ?? false;
      return ok(
        JSON.stringify({
          number: pr?.number ?? 0,
          url,
          title: pr?.title ?? 'Pull request',
          state: pr?.state ?? 'OPEN',
          isDraft: false,
          reviewDecision: approved
            ? 'APPROVED'
            : changes
              ? 'CHANGES_REQUESTED'
              : 'REVIEW_REQUIRED',
          mergeable: 'MERGEABLE',
          statusCheckRollup: [
            { conclusion: 'SUCCESS' },
            { conclusion: 'SUCCESS' },
            { status: 'IN_PROGRESS' },
          ],
          additions: 12,
          deletions: 3,
          changedFiles: 2,
          reviews: pr?.reviews ?? [],
          comments: pr?.comments ?? [],
        })
      );
    }

    if (bin === 'gh' && sub === 'api') {
      const match = /pulls\/(\d+)\/comments/.exec(cmd[2] ?? '');
      const pr = [...prs.values()].find((p) => String(p.number) === match?.[1]);
      return ok(JSON.stringify(pr?.lineComments ?? []));
    }

    if (bin === 'gh' && sub === 'pr' && action === 'review') {
      const pr = prs.get(cmd[3]);
      const state = cmd.includes('--approve')
        ? 'APPROVED'
        : cmd.includes('--request-changes')
          ? 'CHANGES_REQUESTED'
          : 'COMMENTED';
      pr?.reviews.push({
        author: { login: 'you' },
        body: flagValue(cmd, '--body') ?? '',
        state,
        submittedAt: now,
      });
      return ok();
    }

    if (bin === 'gh' && sub === 'pr' && action === 'comment') {
      const pr = prs.get(cmd[3]);
      pr?.comments.push({
        author: { login: 'you' },
        body: flagValue(cmd, '--body') ?? '',
        createdAt: now,
      });
      return ok();
    }

    return ok();
  };
}

// Minimal flag parsing (no commander dependency here — `@dispatch/cli` is the
// one place that owns the user-facing CLI surface; this bin is just what
// `dispatch serve` spawns).
function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return undefined;
  return args[index + 1];
}

const args = process.argv.slice(2);
const rootDir = resolve(readFlag(args, '--root') ?? process.cwd());
const portArg = readFlag(args, '--port');
const port = portArg !== undefined ? Number(portArg) : 0;

if (portArg !== undefined && Number.isNaN(port)) {
  console.error(`invalid --port: ${portArg}`);
  process.exit(1);
}

const enableFakes = process.env.DISPATCH_ENABLE_FAKES === '1';

const handle = await startServer({
  rootDir,
  port,
  // `undefined` here defers to index.ts's own production default (register
  // only the real 'claude' backend) — see this file's module doc comment for
  // when/why these are populated instead.
  registerExecutors: enableFakes
    ? (orchestrator) => {
        orchestrator.registerExecutor('claude', new ClaudeExecutor());
        orchestrator.registerExecutor(
          'fake',
          new FakeExecutor(buildDefaultFakeScript())
        );
      }
    : undefined,
  registerPlanners: enableFakes
    ? (planManager) => {
        planManager.registerPlanner('claude', new ClaudePlanner(rootDir));
        planManager.registerPlanner(
          'fake',
          new FakePlanner({ ok: true, proposal: DEFAULT_FAKE_PROPOSAL })
        );
      }
    : undefined,
  // DISPATCH_FAKE_GH=1 swaps PrManager's gh/git seam for an in-memory fake, so
  // the whole PR review surface (open PR -> status/checks/conversation ->
  // approve/comment) can be exercised end-to-end without a real GitHub remote
  // or a logged-in gh. Kept separate from DISPATCH_ENABLE_FAKES so enabling the
  // fake executor doesn't silently also fake out gh for a CLI e2e run.
  prCommandRunner:
    process.env.DISPATCH_FAKE_GH === '1' ? makeFakeGhRunner() : undefined,
});
console.log(`dispatchd listening on http://127.0.0.1:${handle.port}`);
if (enableFakes) {
  console.log(
    'dispatchd: DISPATCH_ENABLE_FAKES=1 — fake executor/planner registered (test/e2e only)'
  );
}

// Keep the daemon file accurate and the port free on Ctrl+C / kill. Signal
// listeners must be synchronous void functions, so the async work happens in
// a fire-and-forget helper rather than being returned from the listener
// itself.
async function shutdown() {
  await handle.stop();
  process.exit(0);
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
