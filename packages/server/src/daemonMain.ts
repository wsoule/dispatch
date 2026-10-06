import {
  DISPATCH_DIR,
  initProjectStores,
  registerMergeDriverGitConfig,
  registerTeamMergeDriverGitConfig,
  writeGitAttributes,
} from '@dispatch-foo/core';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseListenerFlags } from './a2a/settings.js';
import { FakeAiTaskFilter } from './aiTaskFilter.js';
import { mintDaemonTokens } from './api.js';
import { RootServedError } from './daemonfile.js';
import { makeFakeGhRunner } from './fakeGh.js';
import {
  registerCodexIfInstalled,
  resolveStoreBackend,
  startServer,
} from './index.js';
import { ClaudeExecutor } from './orchestrator/executors/claude.js';
import type { FakeExecutorScript } from './orchestrator/executors/fake.js';
import { FakeExecutor } from './orchestrator/executors/fake.js';
import { FakeRememberExecutor } from './orchestrator/executors/fakeRemember.js';
import { ClaudeOverseer } from './orchestrator/overseers/claude.js';
import type {
  FakeOverseerScript,
  FakeOverseerTurn,
} from './orchestrator/overseers/fake.js';
import { FakeOverseer } from './orchestrator/overseers/fake.js';
import type { PlanProposal } from './orchestrator/planner.js';
import { ClaudePlanner } from './orchestrator/planners/claude.js';
import { FakePlanner } from './orchestrator/planners/fake.js';

// ---------------------------------------------------------------------------
// Phase 7 fakes hook (DISPATCH_ENABLE_FAKES / DISPATCH_FAKE_APPROVAL)
//
// Production dispatchd (every real `dispatch serve`/`dispatch ui` and the
// desktop app's release-build sidecar) registers the real ClaudeExecutor,
// CodexExecutor when the codex CLI is installed, ClaudePlanner, and
// ClaudeOverseer — see index.ts's own defaults. Setting `DISPATCH_ENABLE_FAKES=1` in this process's environment
// additionally registers a FakeExecutor, FakePlanner, and FakeOverseer, all
// under the name 'fake' (plus a 'fake-ask' executor that waits for a message,
// and a 'fake-remember' one that proposes a team memory),
// alongside the real ones — never replacing 'claude'.
// This exists purely so the CLI's headless integration tests (and any other e2e script)
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
// The scripted lifecycle of `count` fake sub-agents. Spawns come first in a
// burst, then each sub-agent's tool calls, progress and finish are interleaved
// in rounds, so at any instant several are running at once — the shape a
// fan-out actually has, and the one the UI has to stay legible under.
function fakeSubagentSteps(
  count: number
): NonNullable<FakeExecutorScript['steps']> {
  const labels = [
    'Map the server routes',
    'Read the desktop tests',
    'Check the release workflow',
    'Audit the CLI commands',
    'Trace the approval flow',
    'Survey the git helpers',
  ];
  const now = () => new Date().toISOString();
  const steps: NonNullable<FakeExecutorScript['steps']> = [];
  const ids = Array.from({ length: count }, (_, i) => `fake-agent-${i + 1}`);
  steps.push({
    entry: {
      ts: now(),
      kind: 'assistant',
      text: `Fanning out into ${count} sub-agents to cover the codebase in parallel.`,
    },
  });
  ids.forEach((id, i) => {
    const label = `${labels[i % labels.length]}${i >= labels.length ? ` (${Math.floor(i / labels.length) + 1})` : ''}`;
    steps.push({
      entry: {
        ts: now(),
        kind: 'agent',
        toolUseId: id,
        toolName: 'Agent',
        toolInput: {
          description: label,
          subagent_type: i % 3 === 0 ? 'Explore' : 'general-purpose',
          prompt: `${label}. Report file paths and line numbers.`,
        },
        agent: {
          id,
          phase: 'started',
          status: 'running',
          label,
          type: i % 3 === 0 ? 'Explore' : 'general-purpose',
        },
      },
      delayMs: 60,
    });
  });
  ids.forEach((id, i) => {
    steps.push({
      entry: {
        ts: now(),
        kind: 'tool',
        toolName: 'Grep',
        toolInput: { pattern: 'TODO', path: 'packages' },
        status: 'running',
        parentToolUseId: id,
      },
      delayMs: 40,
    });
    steps.push({
      entry: {
        ts: now(),
        kind: 'tool',
        toolName: 'Read',
        toolInput: { file_path: `packages/file-${i + 1}.ts` },
        status: 'running',
        parentToolUseId: id,
      },
      delayMs: 40,
    });
    steps.push({
      entry: {
        ts: now(),
        kind: 'agent',
        toolUseId: id,
        agent: {
          id,
          phase: 'progress',
          status: 'running',
          toolUses: 2,
          tokens: 1200 + i * 300,
          durationMs: 1500 + i * 200,
          lastTool: 'Read',
          summary: 'Reading the matches',
        },
      },
      delayMs: 40,
    });
  });
  ids.forEach((id, i) => {
    const failed = (i + 1) % 4 === 0;
    steps.push({
      entry: {
        ts: now(),
        kind: 'agent',
        toolUseId: id,
        agent: {
          id,
          phase: 'finished',
          status: failed ? 'failed' : 'done',
          toolUses: 2,
          tokens: 2400 + i * 300,
          durationMs: 3200 + i * 200,
          summary: failed
            ? 'Hit the tool budget before finishing'
            : `Found ${3 + i} places worth a look`,
        },
      },
      delayMs: 120,
    });
  });
  return steps;
}

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
  // DISPATCH_FAKE_SUBAGENTS=<n> fans the fake run out into n sub-agents the
  // way a real agent's `Agent` tool calls would: each spawns, makes a couple
  // of tool calls attributed to it, reports progress, and finishes (every
  // fourth one failing) with short pauses between, so the desktop's fan-out
  // tree, rail counts and All agents rows have live sub-agents to show.
  const subagentCount = Number(process.env.DISPATCH_FAKE_SUBAGENTS);
  if (Number.isFinite(subagentCount) && subagentCount > 0) {
    steps.push(...fakeSubagentSteps(subagentCount));
  }
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

// The 'fake-ask' executor parks after one note until a message is pushed into
// the run, so an e2e can ask a question as the run and watch the answer resume it.
function buildAskFakeScript(): FakeExecutorScript {
  const ts = new Date().toISOString();
  return {
    steps: [
      {
        entry: {
          ts,
          kind: 'assistant',
          text: 'I need a decision from you before I go on.',
        },
      },
      { awaitMessage: true },
      {
        entry: { ts, kind: 'assistant', text: 'Got the answer. Carrying on.' },
      },
    ],
    finish: { state: 'finished', costUsd: 0.01, turns: 2 },
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

// One mutating turn of the default fake overseer script: read the ready list,
// then queue a dispatch of the FIRST ready task on the fake executor — derived
// from the live board rather than a hard-coded id, so the script works against
// any fixture. Queue, not run: the dispatch happens only if a human approves
// the pending action in the chat UI, which is exactly the confirm/deny seam
// the desktop e2e suite exercises.
const FAKE_OVERSEER_MUTATING_TURN: FakeOverseerTurn = {
  calls: [
    { tool: 'list_ready_tasks' },
    {
      tool: 'dispatch_task',
      input: (prior) => {
        const ready = prior[0]?.content as
          | { tasks?: { id: string }[] }
          | undefined;
        const first = ready?.tasks?.[0];
        return first === undefined
          ? { taskId: '(no ready task)' }
          : { taskId: first.id, executor: 'fake' };
      },
    },
  ],
  // Wording deliberately avoids echoing the queued summary or the confirm
  // card's "Needs your approval" header: the e2e spec locates the card by
  // those strings, and a reply repeating them would make the locators
  // ambiguous.
  reply: (results) => {
    const queued = results[1]?.content as { summary?: string } | undefined;
    return queued?.summary === undefined
      ? 'I could not queue a dispatch — no task is ready right now.'
      : 'I queued that — nothing happens until you decide in the card above.';
  },
};

// The one default script every DISPATCH_ENABLE_FAKES daemon's 'fake' overseer
// backend plays: a status turn that answers from a real list_runs read, then
// two identical mutating turns (queue-deny-requeue-approve is the flow the
// desktop e2e drives, so the second ask must queue again). Fixed like the
// executor/planner defaults above — a test/e2e hook, not a scripting facility.
function buildDefaultFakeOverseerScript(): FakeOverseerScript {
  return {
    ok: true,
    turns: [
      {
        calls: [{ tool: 'list_runs', input: { includeTerminal: true } }],
        reply: (results) => {
          const listed = results[0]?.content as
            | { runs?: { live: boolean }[]; total?: number }
            | undefined;
          const total = listed?.total ?? 0;
          const live = listed?.runs?.filter((run) => run.live).length ?? 0;
          return `Status check: this project has ${total} runs on record, ${live} of them live.`;
        },
      },
      FAKE_OVERSEER_MUTATING_TURN,
      FAKE_OVERSEER_MUTATING_TURN,
    ],
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

// `--idle-timeout <seconds>`: exit once nothing has used this daemon for that
// long (see IdleShutdown). The CLI passes it when it spawns a daemon in the
// background; without it the daemon runs until it is stopped, as before.
const idleTimeoutArg = readFlag(args, '--idle-timeout');
const idleTimeoutSeconds =
  idleTimeoutArg !== undefined ? Number(idleTimeoutArg) : undefined;
if (
  idleTimeoutSeconds !== undefined &&
  !(Number.isFinite(idleTimeoutSeconds) && idleTimeoutSeconds > 0)
) {
  console.error(`invalid --idle-timeout: ${idleTimeoutArg}`);
  process.exit(1);
}

// The desktop app's add-project flow can spawn a daemon for a folder that
// hasn't run `dispatch init` yet — init lives here (rather than requiring the
// caller to shell out to the CLI first) so that logic stays in TS and this
// one bin covers both "start a daemon" and "start a daemon, initializing the
// project first" in a single spawn.
if (args.includes('--init')) {
  // Creates whichever backend this daemon is about to open, rather than
  // always scaffolding `.dispatch/tasks`: on `sqlite` that means applying the
  // schema to a fresh database, and scaffolding an unused tasks directory
  // beside it would leave a database-backed project looking half-migrated.
  // Both branches are idempotent, so the pre-check is only about not
  // re-announcing work; `initProjectStores` itself is safe to call twice.
  const backend = resolveStoreBackend(rootDir);
  if (
    backend === 'sqlite' ||
    !existsSync(join(rootDir, DISPATCH_DIR, 'tasks'))
  ) {
    initProjectStores({ rootDir, backend }).close();
  }
  // The CLI's `dispatch init` registers the merge drivers; this is the
  // desktop app's equivalent init path (GetStartedView's add-project flow),
  // so it must register the same drivers or they ship dark for every
  // desktop-first project. Runs unconditionally, not only on a fresh scaffold
  // above — a project added before the drivers existed, or whose local git
  // config lost them, only ever gets repaired through this same flag.
  writeGitAttributes(rootDir);
  registerMergeDriverGitConfig(rootDir);
  registerTeamMergeDriverGitConfig(rootDir);
}

const enableFakes = process.env.DISPATCH_ENABLE_FAKES === '1';

// A test harness that cannot read this process's stdout (Playwright's
// webServer, the browser-dev URL) may preset the decide-tier token instead;
// whoever launches the daemon with it is as trusted as whoever reads the
// stdout line below. The agent token is always minted fresh.
const presetAppToken = process.env.DISPATCH_APP_TOKEN?.trim();
// Read once and gone: no child this daemon starts may inherit it.
delete process.env.DISPATCH_APP_TOKEN;
const tokens =
  presetAppToken !== undefined && presetAppToken !== ''
    ? { ...mintDaemonTokens(), appToken: presetAppToken }
    : undefined;

// Team-local mode (see shared.ts): `--host 0.0.0.0` makes the daemon
// reachable by teammates, `--public-origin` names extra origins they load it
// from (comma-separated), `--web-dist` points at a built desktop bundle.
const host = readFlag(args, '--host');
const publicOrigins = readFlag(args, '--public-origin')
  ?.split(',')
  .map((o) => o.trim())
  .filter((o) => o !== '');
const webDistArg = readFlag(args, '--web-dist');
// HTTPS for teammates: both files or neither, and a port for the listener.
const tlsCert = readFlag(args, '--tls-cert');
const tlsKey = readFlag(args, '--tls-key');
const tlsPortArg = readFlag(args, '--tls-port');
if ((tlsCert === undefined) !== (tlsKey === undefined)) {
  console.error('dispatchd: --tls-cert and --tls-key go together');
  process.exit(2);
}
const tlsPort = tlsPortArg === undefined ? undefined : Number(tlsPortArg);
if (
  tlsPort !== undefined &&
  (!Number.isInteger(tlsPort) || tlsPort < 0 || tlsPort > 65535)
) {
  console.error(
    `dispatchd: --tls-port must be a port number, not "${tlsPortArg}"`
  );
  process.exit(2);
}
// One-boot overrides of <runsDir>/a2a-listener.json for headless servers; any
// of them turns the A2A listener on for this boot.
const a2aFlags = parseListenerFlags({
  host: readFlag(args, '--a2a-host'),
  port: readFlag(args, '--a2a-port'),
  publicUrl: readFlag(args, '--a2a-public-url'),
  tlsCert: readFlag(args, '--a2a-tls-cert'),
  tlsKey: readFlag(args, '--a2a-tls-key'),
});
if (!a2aFlags.ok) {
  console.error(`dispatchd: ${a2aFlags.error}`);
  process.exit(2);
}
const a2aOverrides = a2aFlags.overrides;

// `--started-by <label>`: who spawned this background daemon, for the daemon
// file (the CLI's ensureDaemon passes it alongside --idle-timeout).
const startedBy = readFlag(args, '--started-by');

const serverOpts: Parameters<typeof startServer>[0] = {
  rootDir,
  port,
  tokens,
  ...(host === undefined ? {} : { host }),
  ...(publicOrigins === undefined ? {} : { publicOrigins }),
  ...(webDistArg === undefined ? {} : { webDistDir: resolve(webDistArg) }),
  ...(tlsCert === undefined || tlsKey === undefined
    ? {}
    : {
        tls: {
          certPath: resolve(tlsCert),
          keyPath: resolve(tlsKey),
          ...(tlsPort === undefined ? {} : { port: tlsPort }),
        },
      }),
  ...(Object.keys(a2aOverrides).length === 0 ? {} : { a2a: a2aOverrides }),
  // `--init` is the desktop's add-project spawn, which stops whatever daemon
  // predates the project's tracker; `--replace` is the explicit override.
  // Either way this boot waits for the old pid to exit, never runs beside it.
  replaceRunningDaemon: args.includes('--init') || args.includes('--replace'),
  // `undefined` here defers to index.ts's own production defaults (the real
  // 'claude' backend, plus 'codex' when installed) — see the module comment
  // for when/why these are populated instead.
  registerExecutors: enableFakes
    ? (orchestrator) => {
        orchestrator.registerExecutor('claude', new ClaudeExecutor());
        registerCodexIfInstalled(orchestrator);
        orchestrator.registerExecutor(
          'fake',
          new FakeExecutor(buildDefaultFakeScript())
        );
        orchestrator.registerExecutor(
          'fake-ask',
          new FakeExecutor(buildAskFakeScript())
        );
        orchestrator.registerExecutor(
          'fake-remember',
          new FakeRememberExecutor()
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
  // The keyword-table filter, so an e2e or dev daemon's AI filter never
  // reaches a model.
  aiTaskFilter: enableFakes ? new FakeAiTaskFilter() : undefined,
  registerOverseers: enableFakes
    ? (overseerManager) => {
        overseerManager.registerBackend('claude', new ClaudeOverseer(rootDir));
        overseerManager.registerBackend(
          'fake',
          new FakeOverseer(buildDefaultFakeOverseerScript())
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
  idleTimeoutMs:
    idleTimeoutSeconds !== undefined ? idleTimeoutSeconds * 1000 : undefined,
  ...(startedBy === undefined ? {} : { startedBy }),
  onShutdownRequest: () => {
    console.log(
      'dispatchd: another dispatchd is taking over this project, exiting'
    );
    void shutdown();
  },
  onIdle: () => {
    console.log(
      `dispatchd: unused for ${idleTimeoutSeconds}s with no live work, exiting`
    );
    void shutdown();
  },
};

// `team start` and `team join` turn board sync on by restarting in this
// process: the same port and tokens, so every client stays signed in, and
// only once no live work would be cut short (team/federation/sharing.ts). A
// boot that fails rolls the config back and boots as before; if even that
// fails, the process exits so whatever supervises it starts it again.
let restarting: Promise<void> | null = null;
function restartForSharing(rollback: () => void): Promise<void> {
  restarting ??= (async () => {
    console.log('dispatchd: restarting to turn on board sync');
    const { port: same, tokens: kept } = handle;
    const next = {
      ...serverOpts,
      port: same,
      tokens: kept,
      replaceRunningDaemon: false,
      onSharingRestart: restartForSharing,
    };
    await handle.stop();
    try {
      handle = await startServer(next);
    } catch (err) {
      console.error(
        `dispatchd: COULD NOT BOOT WITH BOARD SYNC ON: ${(err as Error).message}. Rolling the config back and booting as before.`
      );
      rollback();
      try {
        handle = await startServer(next);
      } catch (again) {
        console.error(
          `dispatchd: COULD NOT BOOT AGAIN: ${(again as Error).message}. Exiting so it can be started again.`
        );
        process.exit(1);
      }
      throw err;
    } finally {
      restarting = null;
    }
    console.log(`dispatchd listening on http://127.0.0.1:${handle.port}`);
  })();
  return restarting;
}

// A root another daemon serves is a refusal to print, not a crash to trace.
let handle = await startServer({
  ...serverOpts,
  onSharingRestart: restartForSharing,
}).catch((err: unknown) => {
  if (!(err instanceof RootServedError)) throw err;
  console.error(`dispatchd: ${err.message}`);
  process.exit(1);
});
console.log(`dispatchd listening on http://127.0.0.1:${handle.port}`);

// The only place the app token leaves this process — it is never written to
// disk, so anything capturing this stdout must not persist the line either.
//
// Unless it came in through DISPATCH_APP_TOKEN: then whoever launched the
// daemon already holds it, and printing it only hands a copy to wherever
// stdout goes. Under a service manager that is a journal kept on disk, which
// is the one place the token is meant never to be. The notice deliberately
// does not start with `DISPATCH_APP_TOKEN=`, the prefix the desktop sidecar
// parses — that spawner never presets one, and Playwright's never reads it.
if (presetAppToken !== undefined && presetAppToken !== '') {
  console.log(
    'dispatchd: using the app token from DISPATCH_APP_TOKEN; not printing it'
  );
} else {
  console.log(`DISPATCH_APP_TOKEN=${handle.tokens.appToken}`);
  console.log(
    'dispatchd: that token authorizes approval decisions; it is not stored anywhere, so keep it if you need it'
  );
}

if (enableFakes) {
  console.log(
    'dispatchd: DISPATCH_ENABLE_FAKES=1 — fake executor/planner/overseer/AI filter registered (test/e2e only)'
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
