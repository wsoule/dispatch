import type { Command } from 'commander';

import type { ApiClient, Message, RunMeta, ServerEvent } from '../apiClient.js';
import { createApiClient, DaemonUnreachableError } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import {
  exitCodeForRunState,
  formatApprovalRequest,
  formatDiffFiles,
  formatEntry,
  formatRunsTable,
  type ToolApproval,
  toolApprovalOf,
} from '../orchestrateFormat.js';
import { singleFlight } from '../singleFlight.js';
import type { ConnectEventsOptions } from '../watch.js';
import { connectEvents } from '../watch.js';
import { attachToRunningDaemon, resolveAppToken } from './appToken.js';
import { ensureDaemon } from './daemon.js';
import { requireInitialized } from './task.js';

// Every orchestrate command needs a live daemon before it can do anything —
// `ensureDaemon` auto-starts one if none is running (see its own doc
// comment), matching the architecture note that every command needing
// dispatchd does this transparently rather than making the user run
// `dispatch ui`/`dispatch serve` first.
async function daemonFor(
  ctx: CliContext
): Promise<{ baseUrl: string; token: string; client: ApiClient }> {
  requireInitialized(ctx);
  const { port, agentToken } = await ensureDaemon(ctx);
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    token: agentToken,
    client: createApiClient(baseUrl, agentToken),
  };
}

const REVIEW_ACTIONS = ['merge', 'discard', 'pr'] as const;
type ReviewAction = (typeof REVIEW_ACTIONS)[number];

function validateReviewAction(value: string): ReviewAction {
  if (!(REVIEW_ACTIONS as readonly string[]).includes(value)) {
    throw new CliError(
      `invalid action: ${value} (expected ${REVIEW_ACTIONS.join('|')})`
    );
  }
  return value as ReviewAction;
}

// Streams a single run's `run.log` events and tool-approval gates live and
// resolves once it reaches a terminal state, with the matching exit code
// (see exitCodeForRunState). `setRunId` is separate from construction
// because the two call sites need it at different points: `run watch
// <runId>` already knows the id when it starts listening, but `run
// <taskId> --watch` opens the WS connection *before* calling createRun (so
// no early log entries are missed) and only learns the run's id once that
// call returns — every event that arrives before `setRunId` is buffered and
// replayed the moment it's called, so nothing in that window is dropped.
//
// I2: `waitForExit()` can also REJECT, with a CliError('lost connection to
// dispatchd'), once the underlying connectEvents gives up reconnecting (see
// watch.ts's `onGiveUp`) — every caller MUST wrap its use of this watcher in
// try/finally and call `dispose()` unconditionally (C1: a run that never
// gets watched to a terminal state — a 4xx dispatch failure, a lost
// connection — must not leave an open WS socket/reconnect timer keeping the
// process alive forever).
//
// `connectOptions` is exposed only for tests (packages/cli/test/
// run-watcher.test.ts) to inject a fake socket and fast timings; production
// callers never pass it.
export function createRunWatcher(
  ctx: CliContext,
  client: ApiClient,
  baseUrl: string,
  opts: { verbose?: boolean },
  connectOptions: Pick<
    ConnectEventsOptions,
    'createSocket' | 'reconnectDelayMs' | 'maxConsecutiveFailures' | 'token'
  > = {}
): {
  setRunId: (id: string) => void;
  waitForExit: () => Promise<number>;
  dispose: () => void;
} {
  let runId: string | undefined;
  let settled = false;
  let resolveExit!: (code: number) => void;
  let rejectExit!: (err: Error) => void;
  const exitPromise = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  // A rejection can happen (onGiveUp) before the caller has gotten around
  // to `await`ing `waitForExit()` — every call site does so promptly, but
  // this side-channel `.catch` guarantees the rejection is never reported
  // as "unhandled" regardless of timing; it doesn't consume the rejection
  // for `waitForExit()`'s own caller, who still observes it normally.
  exitPromise.catch(() => {});
  const pending: ServerEvent[] = [];

  function finish(code: number): void {
    if (settled) return;
    settled = true;
    resolveExit(code);
  }

  function fail(err: Error): void {
    if (settled) return;
    settled = true;
    rejectExit(err);
  }

  // I2(a): the id-known refetch-and-check is exactly what runs on every
  // reconnect (see `onOpen` below) AND on `run.changed`, both of which can
  // fire close together — singleFlight collapses that into one HTTP call
  // in flight at a time instead of racing several.
  const refetchAndCheck = singleFlight(async () => {
    if (runId === undefined) return;
    const detail = await client.getRun(runId);
    const code = exitCodeForRunState(detail.meta.state);
    if (code !== null) finish(code);
  });

  // A refetch that failed because the CONNECTION died is not fatal — it is the
  // condition the socket layer's reconnect/give-up loop already exists to
  // handle, and it will surface as `onGiveUp`'s actionable CliError if the
  // daemon really is gone. Treating it as fatal made it win the race against
  // that: a daemon SIGKILLed while a refetch was in flight rejected
  // `waitForExit` with undici's raw `TypeError: fetch failed`, `settled` flipped
  // true, the later `onGiveUp` became a no-op, and the CLI died with an uncaught
  // exception instead of printing "lost connection to dispatchd".
  //
  // The two signals are precise rather than message matches: per the fetch spec
  // a network failure rejects with TypeError, and createApiClient wraps exactly
  // that case in DaemonUnreachableError. An HTTP error response does not reject
  // at all — those become a CliError carrying the server's message. So anything
  // else here means
  // the run is genuinely unreadable (it was deleted, the id is wrong) and must
  // still fail the watch rather than retry forever.
  function isConnectionError(err: unknown): boolean {
    return err instanceof TypeError || err instanceof DaemonUnreachableError;
  }

  function triggerRefetch(): void {
    void refetchAndCheck().catch((err: unknown) => {
      if (isConnectionError(err)) return;
      fail(err instanceof Error ? err : new Error(String(err)));
    });
  }

  function handle(event: ServerEvent): void {
    if (runId === undefined) {
      pending.push(event);
      return;
    }
    if (settled) return;
    if (event.type === 'run.log' && event.runId === runId) {
      const line = formatEntry(event.entry, opts);
      if (line !== null) ctx.log(line);
    } else if (event.type === 'message.new') {
      const approval = toolApprovalOf(event.message);
      if (approval?.runId === runId) ctx.log(formatApprovalRequest(approval));
    } else if (event.type === 'run.changed') {
      // No payload on `run.changed` says WHICH run changed — cheapest
      // correct response is to refetch this one and check whether it just
      // became terminal, exactly the "go refetch" contract every consumer
      // of this event already follows.
      triggerRefetch();
    }
  }

  const dispose = connectEvents(baseUrl, handle, {
    ...connectOptions,
    // I2(a): refetch on every successful (re)connect, not just on
    // run.changed — this is what recovers a run that finished/failed
    // during a disconnected gap, when no event for it was ever delivered.
    onOpen: triggerRefetch,
    // I2(b)/C1: give up reconnecting forever — surfaced as a rejection so
    // every caller's try/finally still runs (see this function's doc
    // comment) instead of hanging on an open socket nobody will ever hear
    // from again.
    onGiveUp: () => fail(new CliError('lost connection to dispatchd')),
  });

  return {
    setRunId(id: string) {
      runId = id;
      const buffered = pending.splice(0, pending.length);
      for (const event of buffered) handle(event);
      // Safety net: the run may already have reached a terminal state
      // before this watcher even finished connecting (a very fast
      // FakeExecutor script, or `run watch` attaching to something that
      // just finished) — check once explicitly rather than relying solely
      // on a future event or reconnect.
      triggerRefetch();
    },
    waitForExit: () => exitPromise,
    dispose,
  };
}

// What `dispatch run <taskId>` prints for the run it got back. The daemon, not
// the caller, decides whether a re-dispatch starts over or picks the task's
// failed run back up, so the line has to be read off the result: `resumedFrom`
// is the only thing that says which of the two just happened.
function describeDispatch(meta: RunMeta, taskId: string): string {
  return meta.resumedFrom !== undefined
    ? `resumed ${meta.resumedFrom} as ${meta.id} (${meta.executor}) for ${taskId}`
    : `dispatched ${meta.id} (${meta.executor}) for ${taskId}`;
}

interface RunGate {
  gate: Message;
  approval: ToolApproval;
}

// The open gates of every tool call a run is parked on, in the listing's
// oldest-first order: one gate per call.
function findRunGates(items: Message[], runId: string): RunGate[] {
  const found: RunGate[] = [];
  for (const gate of items) {
    const approval = toolApprovalOf(gate);
    if (approval?.runId === runId) found.push({ gate, approval });
  }
  return found;
}

// The gate `dispatch approve` answers: the named call, or the run's only one.
// Several parked calls need a request id, since each has its own gate.
function pickRunGate(
  gates: RunGate[],
  runId: string,
  requestId: string | undefined
): RunGate {
  const found =
    requestId === undefined
      ? gates.length === 1
        ? gates[0]
        : undefined
      : gates.find((g) => g.approval.requestId === requestId);
  if (found !== undefined) return found;
  if (requestId === undefined && gates.length > 1) {
    const calls = gates
      .map((g) => `${g.approval.requestId} (${g.approval.tool})`)
      .join(', ');
    throw new CliError(
      `${runId} is parked on ${gates.length} calls: ${calls}; name one: dispatch approve ${runId} <requestId>`
    );
  }
  throw new CliError(`${runId} is not awaiting an approval`);
}

// The `run show` lines for a parked run. An app token names each parked call's
// tool and request id; without one the lines omit them, and a token the daemon
// refuses is named as the reason.
async function describeParkedApproval(
  baseUrl: string,
  runId: string,
  token?: string
): Promise<string[]> {
  const needs = '(needs the app token: --token or DISPATCH_APP_TOKEN)';
  const answer = `answer with: dispatch approve ${runId} [--deny] ${needs}`;
  if (token === undefined) return [`awaiting approval — ${answer}`];
  try {
    const { items } = await createApiClient(baseUrl, token).openDecisions();
    const gates = findRunGates(items, runId);
    if (gates.length === 1) {
      const { tool, requestId } = gates[0].approval;
      return [`awaiting approval: ${tool} (${requestId}) — ${answer}`];
    }
    if (gates.length > 1) {
      return [
        `awaiting approval on ${gates.length} calls — answer each with: dispatch approve ${runId} <requestId> [--deny] ${needs}`,
        ...gates.map((g) => `  ${g.approval.tool} (${g.approval.requestId})`),
      ];
    }
    return [`awaiting approval — ${answer}`];
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    return [
      `awaiting approval — ${answer}`,
      `  could not read its gates with that token: ${err.message}`,
    ];
  }
}

// The daemon's notice saying why a wake-requesting message woke nothing, read
// from the sender's unread mail; null when there is none or it cannot be read.
async function wakeNoticeFor(
  client: ApiClient,
  messageId: string
): Promise<string | null> {
  try {
    const { items } = await client.getMailbox(['held', 'notified', 'pushed']);
    const notice = items.findLast(
      ({ message }) =>
        message.kind === 'notice' &&
        message.refs.some((r) => r.type === 'message' && r.id === messageId)
    );
    return notice?.message.body ?? null;
  } catch (err) {
    if (err instanceof CliError) return null;
    throw err;
  }
}

export function registerOrchestrateCommands(
  program: Command,
  ctx: CliContext
): void {
  program
    .command('executors')
    .description('List the executors the daemon can dispatch on')
    .option('--json', 'print the executors as JSON')
    .action(async (opts: { json?: boolean }) => {
      const { client } = await daemonFor(ctx);
      const info = await client.fetchExecutors();
      if (opts.json === true) {
        ctx.log(JSON.stringify(info, null, 2));
        return;
      }
      for (const executor of info.executors) {
        const notes = [
          executor.name === info.default ? 'default' : undefined,
          executor.reportsCost ? undefined : 'no cost reporting',
          executor.enforcesCaps ? undefined : 'caps not enforced',
        ].filter((note) => note !== undefined);
        ctx.log(
          notes.length === 0
            ? executor.name
            : `${executor.name}  (${notes.join(', ')})`
        );
      }
    });

  const run = program
    .command('run')
    .description('Dispatch a new run, or inspect an existing one');
  run.addHelpText(
    'after',
    '\nDispatch a new run with:\n' +
      '  dispatch run <task-id> [--executor <name>] [--fresh] [--watch] [--json]\n' +
      '\nA task whose last run failed with its worktree intact is resumed rather\n' +
      'than started over; --fresh forces a new run. Resume a specific run with:\n' +
      '  dispatch run resume <run-id>'
  );

  run
    .command('dispatch <taskId>', { isDefault: true, hidden: true })
    .option(
      '--executor <name>',
      'an executor the daemon registered (see `dispatch executors`)',
      'claude'
    )
    .option(
      '--fresh',
      "start a new run even when the task's last run could be resumed"
    )
    .option('--watch', 'stream the run live until it reaches a terminal state')
    .option('--verbose', 'also render thinking entries while watching')
    .option('--json', 'print the dispatched run as JSON')
    .action(
      async (
        taskId: string,
        opts: {
          executor: string;
          fresh?: boolean;
          watch?: boolean;
          verbose?: boolean;
          json?: boolean;
        },
        command: Command
      ) => {
        const { baseUrl, token, client } = await daemonFor(ctx);
        const createOpts = { fresh: opts.fresh };
        // Sent only when the user actually typed it. `--executor` carries a
        // commander default, so `opts.executor` is 'claude' either way — and
        // passing that on reads server-side as "the caller named claude",
        // which refuses to resume a run on any other executor. A default is
        // not a request.
        const executor =
          command.getOptionValueSource('executor') === 'default'
            ? undefined
            : opts.executor;

        if (opts.watch !== true) {
          const meta = await client.createRun(taskId, executor, createOpts);
          ctx.log(
            opts.json === true
              ? JSON.stringify(meta, null, 2)
              : describeDispatch(meta, taskId)
          );
          return;
        }

        // Connect BEFORE dispatching so no early log entry can be missed —
        // see createRunWatcher's doc comment for how the id-not-yet-known
        // window is handled.
        const watcher = createRunWatcher(
          ctx,
          client,
          baseUrl,
          { verbose: opts.verbose },
          { token }
        );
        // C1: `dispose()` must run even if `createRun` itself rejects (a
        // 4xx for a bad task id, an already-live-run 409, ...) — the
        // watcher already opened a WS connection above, and an undisposed
        // one keeps a reconnect timer alive forever, which keeps the CLI
        // process itself alive right along with it (verified: a typo'd
        // task id used to hang instead of exiting 1).
        try {
          const meta = await client.createRun(taskId, executor, createOpts);
          ctx.log(describeDispatch(meta, taskId));
          watcher.setRunId(meta.id);
          process.exitCode = await watcher.waitForExit();
        } finally {
          watcher.dispose();
        }
      }
    );

  run
    .command('resume <runId>')
    .description(
      'Pick a terminal run back up in its own worktree, on its own branch'
    )
    .option('--json', 'print the resumed run as JSON')
    .action(async (runId: string, opts: { json?: boolean }) => {
      const { client } = await daemonFor(ctx);
      const meta = await client.resumeRun(runId);
      ctx.log(
        opts.json === true
          ? JSON.stringify(meta, null, 2)
          : `resumed ${runId} as ${meta.id} (${meta.executor}) on ${meta.branch}${
              // Whether the agent still has the conversation, or is starting
              // from the brief — the difference this command's user most
              // needs to hear, and one the run id alone never shows.
              meta.sessionId !== undefined
                ? ', continuing its session'
                : ' as a fresh session'
            }`
      );
    });

  run
    .command('show <runId>')
    .option('--json')
    .option(
      '--token <token>',
      'the daemon app token (or DISPATCH_APP_TOKEN), to name a parked approval'
    )
    .action(async (runId: string, opts: { json?: boolean; token?: string }) => {
      const { baseUrl, client } = await daemonFor(ctx);
      const detail = await client.getRun(runId);
      if (opts.json === true) {
        ctx.log(JSON.stringify(detail, null, 2));
        return;
      }
      const meta = detail.meta;
      ctx.log(
        `${meta.id}  task=${meta.taskId}  state=${meta.state}  executor=${meta.executor}  branch=${meta.branch}`
      );
      if (meta.state === 'awaiting-approval') {
        const appToken = (opts.token ?? process.env.DISPATCH_APP_TOKEN)?.trim();
        const parked = await describeParkedApproval(
          baseUrl,
          meta.id,
          appToken === '' ? undefined : appToken
        );
        for (const line of parked) ctx.log(line);
      }
      const last20 = detail.entries.slice(-20);
      for (const entry of last20) {
        const line = formatEntry(entry);
        if (line !== null) ctx.log(line);
      }
    });

  run
    .command('watch <runId>')
    .option('--verbose')
    .action(async (runId: string, opts: { verbose?: boolean }) => {
      const { baseUrl, token, client } = await daemonFor(ctx);
      const detail = await client.getRun(runId);
      for (const entry of detail.entries) {
        const line = formatEntry(entry, opts);
        if (line !== null) ctx.log(line);
      }
      const immediate = exitCodeForRunState(detail.meta.state);
      if (immediate !== null) {
        process.exitCode = immediate;
        return;
      }
      const watcher = createRunWatcher(ctx, client, baseUrl, opts, { token });
      try {
        watcher.setRunId(runId);
        process.exitCode = await watcher.waitForExit();
      } finally {
        watcher.dispose();
      }
    });

  program
    .command('runs')
    .description('List orchestrator runs')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const { client } = await daemonFor(ctx);
      const runs = await client.listRuns();
      ctx.log(
        opts.json === true
          ? JSON.stringify(runs, null, 2)
          : formatRunsTable(runs)
      );
    });

  program
    .command('approve <runId> [requestId]')
    .description(
      'Approve or deny a tool call a run is parked on; name its requestId when the run parked several (needs the daemon app token)'
    )
    .option('--deny', 'deny the request instead of approving it')
    .option('--session', 'also approve this tool for the rest of the run')
    .option('--reason <text>', 'why the request is denied (with --deny)')
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .action(
      async (
        runId: string,
        requestId: string | undefined,
        opts: {
          deny?: boolean;
          session?: boolean;
          reason?: string;
          token?: string;
        }
      ) => {
        const deny = opts.deny === true;
        if (!deny && opts.reason !== undefined) {
          throw new CliError(
            '--reason goes with --deny: an approval has no reason'
          );
        }
        // Approving answers a gate, which the daemon takes only from a human:
        // a client on the app token, never a daemon this command started.
        const appToken = resolveAppToken(opts.token, 'dispatch approve');
        const { baseUrl } = await attachToRunningDaemon(ctx);
        const client = createApiClient(baseUrl, appToken);
        const { items } = await client.openDecisions();
        const found = pickRunGate(findRunGates(items, runId), runId, requestId);
        await client.replyToMessage(found.gate.id, {
          body: deny ? (opts.reason ?? '') : '',
          choice: deny
            ? 'deny'
            : opts.session === true
              ? 'approve-session'
              : 'approve',
        });
        ctx.log(
          `${runId} ${deny ? 'denied' : 'approved'} (${found.approval.requestId})`
        );
      }
    );

  program
    .command('message <runId> <text...>')
    .description(
      'Send a message to a live run, or request changes on a finished one (needs the daemon app token)'
    )
    .option('--resume', 'request changes on a finished run (continues it)')
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .action(
      async (
        runId: string,
        text: string[],
        opts: { resume?: boolean; token?: string }
      ) => {
        // Messages go out as a human, so they need the app token too.
        const appToken = resolveAppToken(opts.token, 'dispatch message');
        const { baseUrl } = await attachToRunningDaemon(ctx);
        const client = createApiClient(baseUrl, appToken);
        const body = text.join(' ');
        if (opts.resume !== true) {
          await client.sendMessage({
            to: [`run:${runId}`],
            kind: 'message',
            body,
          });
          ctx.log(`sent message to ${runId}`);
          return;
        }
        // A human's wake of an ended run continues exactly that run before the
        // send returns, so its continuation is listed by now.
        const before = new Set((await client.listRuns()).map((r) => r.id));
        const sent = await client.sendMessage({
          to: [`run:${runId}`],
          kind: 'message',
          body,
          wake: 'request',
        });
        const after = await client.listRuns();
        const continued = after.find(
          (r) => r.resumedFrom === runId && !before.has(r.id)
        );
        const named = after.find((r) => r.id === runId);
        if (
          continued === undefined &&
          named !== undefined &&
          exitCodeForRunState(named.state) === null
        ) {
          // A run that is still live simply got the message.
          ctx.log(`sent message to ${runId}`);
          return;
        }
        if (continued === undefined) {
          throw new CliError(
            (await wakeNoticeFor(client, sent.message.id)) ??
              `${runId} did not continue; your message is waiting for it`
          );
        }
        ctx.log(`requested changes on ${runId} — new run ${continued.id}`);
      }
    );

  program
    .command('cancel <runId>')
    .description('Cancel a live run')
    .action(async (runId: string) => {
      const { client } = await daemonFor(ctx);
      await client.cancelRun(runId);
      ctx.log(`${runId} cancelled`);
    });

  program
    .command('diff <runId>')
    .description("Show a run's unified diff (pipe-friendly)")
    .option('--files', 'list changed files with status instead of the patch')
    .action(async (runId: string, opts: { files?: boolean }) => {
      const { client } = await daemonFor(ctx);
      const result = await client.getRunDiff(runId);
      ctx.log(
        opts.files === true ? formatDiffFiles(result.files) : result.patch
      );
    });

  program
    .command('review <runId> <action>')
    .description('Review a finished run: merge, discard, or open a PR')
    .action(async (runId: string, action: string) => {
      const validated = validateReviewAction(action);
      const { client } = await daemonFor(ctx);
      const meta = await client.reviewRun(runId, validated);
      ctx.log(
        `${runId} reviewed: ${validated}` +
          (meta.prUrl !== undefined ? ` (${meta.prUrl})` : '')
      );
    });
}
