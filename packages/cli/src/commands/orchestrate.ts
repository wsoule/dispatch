import type { Command } from 'commander';

import type { ApiClient, ServerEvent } from '../apiClient.js';
import { createApiClient } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import {
  exitCodeForRunState,
  formatApprovalRequest,
  formatDiffFiles,
  formatEntry,
  formatRunsTable,
} from '../orchestrateFormat.js';
import { connectEvents } from '../watch.js';
import { ensureDaemon } from './daemon.js';
import { requireStore } from './task.js';

// Every orchestrate command needs a live daemon before it can do anything —
// `ensureDaemon` auto-starts one if none is running (see its own doc
// comment), matching the architecture note that every command needing
// dispatchd does this transparently rather than making the user run
// `dispatch ui`/`dispatch serve` first.
async function baseUrlFor(ctx: CliContext): Promise<string> {
  requireStore(ctx);
  const { port } = await ensureDaemon(ctx);
  return `http://127.0.0.1:${port}`;
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

// Streams a single run's `run.log`/`approval.requested` events live and
// resolves once it reaches a terminal state, with the matching exit code
// (see exitCodeForRunState). `setRunId` is separate from construction
// because the two call sites need it at different points: `run watch
// <runId>` already knows the id when it starts listening, but `run
// <taskId> --watch` opens the WS connection *before* calling createRun (so
// no early log entries are missed) and only learns the run's id once that
// call returns — every event that arrives before `setRunId` is buffered and
// replayed the moment it's called, so nothing in that window is dropped.
function createRunWatcher(
  ctx: CliContext,
  client: ApiClient,
  baseUrl: string,
  opts: { verbose?: boolean }
): {
  setRunId: (id: string) => void;
  waitForExit: () => Promise<number>;
  dispose: () => void;
} {
  let runId: string | undefined;
  let settled = false;
  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const pending: ServerEvent[] = [];

  function finish(code: number): void {
    if (settled) return;
    settled = true;
    resolveExit(code);
  }

  function handle(event: ServerEvent): void {
    if (runId === undefined) {
      pending.push(event);
      return;
    }
    if (event.type === 'run.log' && event.runId === runId) {
      const line = formatEntry(event.entry, opts);
      if (line !== null) ctx.log(line);
    } else if (event.type === 'approval.requested' && event.runId === runId) {
      ctx.log(
        formatApprovalRequest(event.runId, event.requestId, event.toolName)
      );
    } else if (event.type === 'run.changed') {
      // No payload on `run.changed` says WHICH run changed — cheapest
      // correct response is to refetch this one and check whether it just
      // became terminal, exactly the "go refetch" contract every consumer
      // of this event already follows.
      void client
        .getRun(runId)
        .then((detail) => {
          const code = exitCodeForRunState(detail.meta.state);
          if (code !== null) finish(code);
        })
        .catch(() => {});
    }
  }

  const dispose = connectEvents(baseUrl, handle);

  return {
    setRunId(id: string) {
      runId = id;
      const buffered = pending.splice(0, pending.length);
      for (const event of buffered) handle(event);
      // Safety net: the run may already have reached a terminal state
      // before this watcher even finished connecting (a very fast
      // FakeExecutor script, or `run watch` attaching to something that
      // just finished) — check once explicitly rather than relying solely
      // on a future `run.changed` broadcast that may never arrive.
      void client
        .getRun(id)
        .then((detail) => {
          const code = exitCodeForRunState(detail.meta.state);
          if (code !== null) finish(code);
        })
        .catch(() => {});
    },
    waitForExit: () => exitPromise,
    dispose,
  };
}

export function registerOrchestrateCommands(
  program: Command,
  ctx: CliContext
): void {
  const run = program
    .command('run')
    .description('Dispatch a new run, or inspect an existing one');
  run.addHelpText(
    'after',
    '\nDispatch a new run with:\n  dispatch run <task-id> [--executor claude|fake] [--watch] [--json]'
  );

  run
    .command('dispatch <taskId>', { isDefault: true, hidden: true })
    .option('--executor <name>', 'claude|fake', 'claude')
    .option('--watch', 'stream the run live until it reaches a terminal state')
    .option('--verbose', 'also render thinking entries while watching')
    .option('--json', 'print the dispatched run as JSON')
    .action(
      async (
        taskId: string,
        opts: {
          executor: string;
          watch?: boolean;
          verbose?: boolean;
          json?: boolean;
        }
      ) => {
        const baseUrl = await baseUrlFor(ctx);
        const client = createApiClient(baseUrl);

        if (opts.watch !== true) {
          const meta = await client.createRun(taskId, opts.executor);
          ctx.log(
            opts.json === true
              ? JSON.stringify(meta, null, 2)
              : `dispatched ${meta.id} (${meta.executor}) for ${taskId}`
          );
          return;
        }

        // Connect BEFORE dispatching so no early log entry can be missed —
        // see createRunWatcher's doc comment for how the id-not-yet-known
        // window is handled.
        const watcher = createRunWatcher(ctx, client, baseUrl, {
          verbose: opts.verbose,
        });
        const meta = await client.createRun(taskId, opts.executor);
        ctx.log(`dispatched ${meta.id} (${meta.executor}) for ${taskId}`);
        watcher.setRunId(meta.id);
        const code = await watcher.waitForExit();
        watcher.dispose();
        process.exitCode = code;
      }
    );

  run
    .command('show <runId>')
    .option('--json')
    .action(async (runId: string, opts: { json?: boolean }) => {
      const baseUrl = await baseUrlFor(ctx);
      const client = createApiClient(baseUrl);
      const detail = await client.getRun(runId);
      if (opts.json === true) {
        ctx.log(JSON.stringify(detail, null, 2));
        return;
      }
      const meta = detail.meta;
      ctx.log(
        `${meta.id}  task=${meta.taskId}  state=${meta.state}  executor=${meta.executor}  branch=${meta.branch}`
      );
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
      const baseUrl = await baseUrlFor(ctx);
      const client = createApiClient(baseUrl);
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
      const watcher = createRunWatcher(ctx, client, baseUrl, opts);
      watcher.setRunId(runId);
      const code = await watcher.waitForExit();
      watcher.dispose();
      process.exitCode = code;
    });

  program
    .command('runs')
    .description('List orchestrator runs')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const baseUrl = await baseUrlFor(ctx);
      const client = createApiClient(baseUrl);
      const runs = await client.listRuns();
      ctx.log(
        opts.json === true
          ? JSON.stringify(runs, null, 2)
          : formatRunsTable(runs)
      );
    });

  program
    .command('approve <runId> <requestId>')
    .description('Approve or deny a run awaiting an approval decision')
    .option('--deny', 'deny the request instead of approving it')
    .action(
      async (runId: string, requestId: string, opts: { deny?: boolean }) => {
        const baseUrl = await baseUrlFor(ctx);
        const client = createApiClient(baseUrl);
        const allow = opts.deny !== true;
        await client.approveRun(runId, requestId, allow);
        ctx.log(`${runId} ${allow ? 'approved' : 'denied'} (${requestId})`);
      }
    );

  program
    .command('message <runId> <text...>')
    .description(
      'Send a message to a live run, or request changes on a finished one'
    )
    .option(
      '--resume',
      'request changes on a finished run (resumes its session)'
    )
    .action(
      async (runId: string, text: string[], opts: { resume?: boolean }) => {
        const baseUrl = await baseUrlFor(ctx);
        const client = createApiClient(baseUrl);
        const meta = await client.sendRunMessage(runId, text.join(' '), {
          resume: opts.resume,
        });
        ctx.log(
          opts.resume === true
            ? `requested changes on ${runId} — new run ${meta.id}`
            : `sent message to ${runId}`
        );
      }
    );

  program
    .command('cancel <runId>')
    .description('Cancel a live run')
    .action(async (runId: string) => {
      const baseUrl = await baseUrlFor(ctx);
      const client = createApiClient(baseUrl);
      await client.cancelRun(runId);
      ctx.log(`${runId} cancelled`);
    });

  program
    .command('diff <runId>')
    .description("Show a run's unified diff (pipe-friendly)")
    .option('--files', 'list changed files with status instead of the patch')
    .action(async (runId: string, opts: { files?: boolean }) => {
      const baseUrl = await baseUrlFor(ctx);
      const client = createApiClient(baseUrl);
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
      const baseUrl = await baseUrlFor(ctx);
      const client = createApiClient(baseUrl);
      const meta = await client.reviewRun(runId, validated);
      ctx.log(
        `${runId} reviewed: ${validated}` +
          (meta.prUrl !== undefined ? ` (${meta.prUrl})` : '')
      );
    });
}
