import type { Command } from 'commander';
import { readFileSync } from 'node:fs';

import type {
  ApiClient,
  EpicProgress,
  PlanProposal,
  PlanRecord,
} from '../apiClient.js';
import { createApiClient } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { formatEpicProgress, formatProposal } from '../orchestrateFormat.js';
import { singleFlight } from '../singleFlight.js';
import type { ConnectEventsOptions } from '../watch.js';
import { connectEvents } from '../watch.js';
import { ensureDaemon } from './daemon.js';
import { requireStore } from './task.js';

async function baseUrlFor(ctx: CliContext): Promise<string> {
  requireStore(ctx);
  const { port } = await ensureDaemon(ctx);
  return `http://127.0.0.1:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `GET /api/plan/:id` until the planner leaves 'running' (ready or
// failed), for callers that didn't ask to watch this over WS. The plan spec
// allows either WS or poll for this — polling keeps `dispatch plan` simple
// and avoids opening a socket for what's usually a few-second wait.
async function pollUntilSettled(
  client: ApiClient,
  planId: string,
  timeoutMs = 60_000
): Promise<PlanRecord> {
  const deadline = Date.now() + timeoutMs;
  do {
    const record = await client.getPlan(planId);
    if (record.state !== 'running') return record;
    await sleep(200);
  } while (Date.now() < deadline);
  throw new CliError(`plan ${planId} did not settle within ${timeoutMs}ms`);
}

// Watches an epic dispatch session over WS and resolves once a fetched
// progress snapshot reports `active: false` (the session ended — see
// EpicEngine.completeEpic). Mirrors commands/orchestrate.ts's
// createRunWatcher in every structural way that matters:
//
// - M4: `fetchProgress` is wrapped in `singleFlight` so however many
//   `task.changed`/`run.changed` events land close together (a review
//   merge touches both) collapse into exactly one HTTP call in flight at a
//   time, never a race between overlapping ones — and its rejection is
//   always routed through `fail()`, never left as a bare fire-and-forget
//   `.catch`-less promise that could crash the process with an unhandled
//   rejection if the daemon died mid-fetch.
// - I2(a): refetches on every successful (re)connect (`onOpen`), not only
//   on a WS event — the only way to recover a completion that happened
//   during a disconnected gap.
// - I2(b)/C1: `onGiveUp` rejects `waitForExit()` with a CliError instead of
//   reconnecting forever; every caller MUST wrap this in try/finally and
//   call `dispose()` unconditionally, exactly like createRunWatcher.
//
// `connectOptions` is exposed only for tests (packages/cli/test/
// epic-watcher.test.ts); production callers never pass it.
export function createEpicWatcher(
  baseUrl: string,
  fetchProgress: () => Promise<EpicProgress>,
  onProgress: (progress: EpicProgress) => void,
  connectOptions: Pick<
    ConnectEventsOptions,
    'createSocket' | 'reconnectDelayMs' | 'maxConsecutiveFailures'
  > = {}
): { waitForExit: () => Promise<void>; dispose: () => void } {
  let settled = false;
  let resolveExit!: () => void;
  let rejectExit!: (err: Error) => void;
  const exitPromise = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  // See createRunWatcher's identical guard: makes the rejection never
  // "unhandled" regardless of whether/when the caller awaits waitForExit().
  exitPromise.catch(() => {});

  function fail(err: Error): void {
    if (settled) return;
    settled = true;
    rejectExit(err);
  }

  const refetch = singleFlight(async () => {
    const progress = await fetchProgress();
    if (settled) return;
    onProgress(progress);
    if (!progress.active) {
      settled = true;
      resolveExit();
    }
  });

  function triggerRefetch(): void {
    void refetch().catch((err: unknown) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });
  }

  const dispose = connectEvents(
    baseUrl,
    (event) => {
      if (settled) return;
      if (event.type === 'task.changed' || event.type === 'run.changed') {
        triggerRefetch();
      }
    },
    {
      ...connectOptions,
      onOpen: triggerRefetch,
      onGiveUp: () => fail(new CliError('lost connection to dispatchd')),
    }
  );

  return {
    waitForExit: () => exitPromise,
    dispose,
  };
}

export function registerPlanCommands(program: Command, ctx: CliContext): void {
  const plan = program
    .command('plan')
    .description('Turn a prompt into a proposed epic + tasks');
  plan.addHelpText(
    'after',
    '\nStart a plan with:\n  dispatch plan <prompt...> [--planner claude|fake] [--json] [--yes]'
  );

  plan
    .command('submit <prompt...>', { isDefault: true, hidden: true })
    .option('--planner <name>', 'claude|fake', 'claude')
    .option('--json', 'print the plan record (and confirm result) as JSON')
    .option('--yes', 'confirm the proposal immediately once it is ready')
    .action(
      async (
        promptParts: string[],
        opts: { planner: string; json?: boolean; yes?: boolean }
      ) => {
        const baseUrl = await baseUrlFor(ctx);
        const client = createApiClient(baseUrl);
        const prompt = promptParts.join(' ');

        const started = await client.startPlan(prompt, opts.planner);
        const record = await pollUntilSettled(client, started.planId);

        if (record.state === 'failed') {
          throw new CliError(`plan failed: ${record.error ?? 'unknown error'}`);
        }
        const proposal = record.proposal;
        if (proposal === undefined) {
          throw new CliError(`plan ${record.id} has no proposal`);
        }

        if (opts.yes === true) {
          const result = await client.confirmPlan(record.id, proposal);
          ctx.log(
            opts.json === true
              ? JSON.stringify({ plan: record, confirm: result }, null, 2)
              : [
                  formatProposal(proposal),
                  '',
                  result.epicId !== undefined
                    ? `confirmed: epic ${result.epicId}, ${result.taskIds.length} task(s)`
                    : `confirmed: ${result.taskIds.length} task(s)`,
                ].join('\n')
          );
          return;
        }

        ctx.log(
          opts.json === true
            ? JSON.stringify(record, null, 2)
            : [
                formatProposal(proposal),
                '',
                `dispatch plan confirm ${record.id}`,
              ].join('\n')
        );
      }
    );

  plan
    .command('confirm <planId>')
    .option(
      '--file <path>',
      'confirm an edited proposal read from this JSON file instead of the one the planner produced'
    )
    .action(async (planId: string, opts: { file?: string }) => {
      const baseUrl = await baseUrlFor(ctx);
      const client = createApiClient(baseUrl);

      let proposal: PlanProposal;
      if (opts.file !== undefined) {
        proposal = JSON.parse(readFileSync(opts.file, 'utf8')) as PlanProposal;
      } else {
        const record = await client.getPlan(planId);
        if (record.proposal === undefined) {
          throw new CliError(
            `plan ${planId} has no proposal to confirm (state: ${record.state})`
          );
        }
        proposal = record.proposal;
      }

      const result = await client.confirmPlan(planId, proposal);
      ctx.log(
        result.epicId !== undefined
          ? `confirmed: epic ${result.epicId}, ${result.taskIds.length} task(s)`
          : `confirmed: ${result.taskIds.length} task(s)`
      );
    });

  const epic = program
    .command('epic')
    .description("Dispatch and monitor an epic's children");

  epic
    .command('start <epicId>')
    .option('--concurrency <n>', 'max concurrent child runs')
    .option('--executor <name>', 'claude|fake', 'claude')
    .option('--json')
    .action(
      async (
        epicId: string,
        opts: { concurrency?: string; executor: string; json?: boolean }
      ) => {
        const baseUrl = await baseUrlFor(ctx);
        const client = createApiClient(baseUrl);
        const session = await client.startEpic(epicId, {
          concurrency:
            opts.concurrency !== undefined
              ? Number(opts.concurrency)
              : undefined,
          executor: opts.executor,
        });
        ctx.log(
          opts.json === true
            ? JSON.stringify(session, null, 2)
            : `epic ${session.epicId} dispatch started (concurrency ${session.concurrency})`
        );
      }
    );

  epic
    .command('stop <epicId>')
    .option('--json')
    .action(async (epicId: string, opts: { json?: boolean }) => {
      const baseUrl = await baseUrlFor(ctx);
      const client = createApiClient(baseUrl);
      const session = await client.stopEpic(epicId);
      ctx.log(
        opts.json === true
          ? JSON.stringify(session, null, 2)
          : `epic ${session.epicId} dispatch stopped`
      );
    });

  epic
    .command('status <epicId>')
    .option('--json')
    .option('--watch', 'stream run/task events until the dispatch session ends')
    .action(
      async (epicId: string, opts: { json?: boolean; watch?: boolean }) => {
        const baseUrl = await baseUrlFor(ctx);
        const client = createApiClient(baseUrl);

        const renderProgress = (progress: EpicProgress): void => {
          ctx.log(
            opts.json === true
              ? JSON.stringify(progress, null, 2)
              : formatEpicProgress(progress)
          );
        };

        const initial = await client.getEpicProgress(epicId);
        renderProgress(initial);
        if (opts.watch !== true || !initial.active) return;

        // C1: try/finally so a lost-connection rejection (or any other
        // failure) still disposes the watcher's WS connection/reconnect
        // timer — undisposed, either would keep this process alive
        // forever instead of letting the thrown error propagate normally.
        const watcher = createEpicWatcher(
          baseUrl,
          () => client.getEpicProgress(epicId),
          renderProgress
        );
        try {
          await watcher.waitForExit();
        } finally {
          watcher.dispose();
        }
      }
    );
}
