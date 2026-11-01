import type { Command } from 'commander';
import { readFileSync } from 'node:fs';

import type {
  ApiClient,
  MilestoneProgress,
  MilestoneSession,
  PlanProposal,
  PlanRecord,
} from '../apiClient.js';
import { createApiClient, DaemonUnreachableError } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import {
  formatMilestoneProgress,
  formatPlanNeedsReply,
  formatProposal,
} from '../orchestrateFormat.js';
import { singleFlight } from '../singleFlight.js';
import type { ConnectEventsOptions } from '../watch.js';
import { connectEvents } from '../watch.js';
import { ensureDaemon } from './daemon.js';
import { requireInitialized } from './task.js';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `GET /api/plan/:id` until the planner leaves 'running'. Polling keeps
// `dispatch plan` simple rather than opening a socket for a few-second wait.
export async function pollUntilSettled(
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
  // The planner keeps running server-side after this invocation gives up, so
  // point at the command that can still check on it later.
  throw new CliError(
    `plan ${planId} has not settled after ${timeoutMs}ms — check it later with: dispatch plan show ${planId}`
  );
}

// Watches a milestone dispatch session over WS and resolves once a progress snapshot reports
// `active: false`. Callers MUST wrap it in try/finally and always call `dispose()`.
export function createMilestoneWatcher(
  baseUrl: string,
  fetchProgress: () => Promise<MilestoneProgress>,
  onProgress: (progress: MilestoneProgress) => void,
  connectOptions: Pick<
    ConnectEventsOptions,
    'createSocket' | 'reconnectDelayMs' | 'maxConsecutiveFailures' | 'token'
  > = {}
): { waitForExit: () => Promise<void>; dispose: () => void } {
  let settled = false;
  let resolveExit!: () => void;
  let rejectExit!: (err: Error) => void;
  const exitPromise = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  // Keeps the rejection from ever being "unhandled" regardless of when the
  // caller awaits waitForExit().
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

  // Same rule as the run watcher: a refetch that failed because the daemon
  // went away defers to the socket layer's own give-up (which reports "lost
  // connection to dispatchd"), rather than racing it with a second message
  // for the same condition. Anything else genuinely stops the watch.
  function triggerRefetch(): void {
    void refetch().catch((err: unknown) => {
      if (err instanceof TypeError || err instanceof DaemonUnreachableError) {
        return;
      }
      fail(err instanceof Error ? err : new Error(String(err)));
    });
  }

  const dispose = connectEvents(
    baseUrl,
    (event) => {
      if (settled) return;
      if (
        event.type === 'task.changed' ||
        event.type === 'run.changed' ||
        event.type === 'milestone.changed' ||
        event.type === 'milestone.paused'
      ) {
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

// The raw `--concurrency` / `--max-spend` / `--max-runs` strings `milestone start`
// and `milestone resume` share; commander hands every option through as a string.
interface SessionCeilingOptions {
  concurrency?: string;
  maxSpend?: string;
  maxRuns?: string;
}

// One numeric option, or a CliError naming it. The server ranges the value
// (400 on out of range); this only rejects what `Number` cannot read.
function numberOption(
  flag: string,
  raw: string | undefined
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CliError(`invalid ${flag}: ${raw} (expected a number)`);
  }
  return value;
}

function parseSessionCeilings(opts: SessionCeilingOptions): {
  concurrency?: number;
  maxSpendUsd?: number;
  maxRuns?: number;
} {
  return {
    concurrency: numberOption('--concurrency', opts.concurrency),
    maxSpendUsd: numberOption('--max-spend', opts.maxSpend),
    maxRuns: numberOption('--max-runs', opts.maxRuns),
  };
}

// `concurrency 4, ceiling $60.00, max 20 runs` — the ceilings only when the
// session has them, so a plain start reads as it always did.
function describeSession(session: MilestoneSession): string {
  const parts = [`concurrency ${String(session.concurrency)}`];
  if (session.maxSpendUsd !== null) {
    parts.push(`ceiling $${session.maxSpendUsd.toFixed(2)}`);
  }
  if (session.maxRuns !== null) {
    parts.push(`max ${String(session.maxRuns)} runs`);
  }
  return parts.join(', ');
}

export function registerPlanCommands(program: Command, ctx: CliContext): void {
  const plan = program
    .command('plan')
    .description('Turn a prompt into a proposed milestone + tasks');
  plan.addHelpText(
    'after',
    '\nStart a plan with:\n  dispatch plan <prompt...> [--planner claude|codex|fake] [--json] [--yes]' +
      '\nAnswer the planner with:\n  dispatch plan reply <planId> <message...>'
  );

  plan
    .command('submit <prompt...>', { isDefault: true, hidden: true })
    .option(
      '--planner <name>',
      'claude|codex|fake (default: the project default agent)'
    )
    .option('--json', 'print the plan record (and confirm result) as JSON')
    .option('--yes', 'confirm the proposal immediately once it is ready')
    .option(
      '--timeout <seconds>',
      'how long to poll for the plan to settle before giving up',
      '60'
    )
    .action(
      async (
        promptParts: string[],
        opts: {
          planner?: string;
          json?: boolean;
          yes?: boolean;
          timeout: string;
        }
      ) => {
        const { client } = await daemonFor(ctx);
        const prompt = promptParts.join(' ');
        const timeoutSeconds = Number(opts.timeout);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
          throw new CliError(
            `invalid --timeout: ${opts.timeout} (expected a positive number of seconds)`
          );
        }

        const started = await client.startPlan(prompt, opts.planner);
        const record = await pollUntilSettled(
          client,
          started.planId,
          timeoutSeconds * 1000
        );

        if (record.state === 'failed') {
          throw new CliError(`plan failed: ${record.error ?? 'unknown error'}`);
        }
        const proposal = record.proposal;
        // A first turn can settle 'ready' with clarifying questions and no
        // proposal — show them and the reply command instead of a bare error.
        if (proposal === undefined) {
          ctx.log(
            opts.json === true
              ? JSON.stringify(record, null, 2)
              : formatPlanNeedsReply(record)
          );
          if (opts.yes === true) {
            throw new CliError(
              `plan ${record.id} is waiting on your answer — nothing was confirmed`
            );
          }
          return;
        }

        if (opts.yes === true) {
          const result = await client.confirmPlan(record.id, proposal);
          ctx.log(
            opts.json === true
              ? JSON.stringify({ plan: record, confirm: result }, null, 2)
              : [
                  formatProposal(proposal),
                  '',
                  result.milestoneId !== undefined
                    ? `confirmed: milestone ${result.milestoneId}, ${result.taskIds.length} task(s)`
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
      const { client } = await daemonFor(ctx);

      let proposal: PlanProposal;
      if (opts.file !== undefined) {
        proposal = JSON.parse(readFileSync(opts.file, 'utf8')) as PlanProposal;
      } else {
        const record = await client.getPlan(planId);
        if (record.proposal === undefined) {
          throw new CliError(
            record.questions.length > 0
              ? `plan ${planId} is waiting on ${record.questions.length} question(s) — see them with: dispatch plan show ${planId}`
              : `plan ${planId} has no proposal to confirm (state: ${record.state})`
          );
        }
        proposal = record.proposal;
      }

      const result = await client.confirmPlan(planId, proposal);
      ctx.log(
        result.milestoneId !== undefined
          ? `confirmed: milestone ${result.milestoneId}, ${result.taskIds.length} task(s)`
          : `confirmed: ${result.taskIds.length} task(s)`
      );
    });

  // The follow-up `dispatch plan` points at when a plan hasn't settled within
  // `--timeout`, and for checking back on one later.
  plan
    .command('show <planId>')
    .option('--json')
    .action(async (planId: string, opts: { json?: boolean }) => {
      const { client } = await daemonFor(ctx);
      const record = await client.getPlan(planId);

      if (opts.json === true) {
        ctx.log(JSON.stringify(record, null, 2));
        return;
      }
      if (record.proposal === undefined) {
        ctx.log(
          `plan ${record.id}: ${record.state}` +
            (record.error !== undefined ? ` — ${record.error}` : '')
        );
        if (record.state === 'ready') ctx.log(formatPlanNeedsReply(record));
        return;
      }
      ctx.log(formatProposal(record.proposal));
    });

  // Answers a planner's clarifying questions (or refines a proposal) without
  // leaving the CLI — one more turn on the same plan conversation.
  plan
    .command('reply <planId> <message...>')
    .option('--json')
    .option(
      '--timeout <seconds>',
      'how long to poll for the turn to settle before giving up',
      '60'
    )
    .action(
      async (
        planId: string,
        messageParts: string[],
        opts: { json?: boolean; timeout: string }
      ) => {
        const { client } = await daemonFor(ctx);
        const timeoutSeconds = Number(opts.timeout);
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
          throw new CliError(
            `invalid --timeout: ${opts.timeout} (expected a positive number of seconds)`
          );
        }

        await client.sendPlanMessage(planId, messageParts.join(' '));
        const record = await pollUntilSettled(
          client,
          planId,
          timeoutSeconds * 1000
        );
        if (record.state === 'failed') {
          throw new CliError(`plan failed: ${record.error ?? 'unknown error'}`);
        }
        if (opts.json === true) {
          ctx.log(JSON.stringify(record, null, 2));
          return;
        }
        ctx.log(
          record.proposal === undefined
            ? formatPlanNeedsReply(record)
            : [
                formatProposal(record.proposal),
                '',
                `dispatch plan confirm ${record.id}`,
              ].join('\n')
        );
      }
    );

  const milestone = program
    .command('milestone')
    .description("Dispatch and monitor a milestone's children");

  milestone
    .command('start <milestoneId>')
    .option('--concurrency <n>', 'max concurrent child runs')
    .option('--max-spend <usd>', 'pause once the session has spent this much')
    .option(
      '--max-runs <n>',
      'pause once the session has started this many runs'
    )
    .option(
      '--executor <name>',
      "an executor the daemon registered; defaults to the project's"
    )
    .option('--json')
    .action(
      async (
        milestoneId: string,
        opts: SessionCeilingOptions & { executor?: string; json?: boolean }
      ) => {
        const { client } = await daemonFor(ctx);
        const session = await client.startMilestone(milestoneId, {
          ...parseSessionCeilings(opts),
          executor: opts.executor,
        });
        ctx.log(
          opts.json === true
            ? JSON.stringify(session, null, 2)
            : `milestone ${session.milestoneId} dispatch started (${describeSession(session)})`
        );
      }
    );

  milestone
    .command('pause <milestoneId>')
    .description('hold new dispatches; live runs finish on their own')
    .option('--json')
    .action(async (milestoneId: string, opts: { json?: boolean }) => {
      const { client } = await daemonFor(ctx);
      const session = await client.pauseMilestone(milestoneId);
      ctx.log(
        opts.json === true
          ? JSON.stringify(session, null, 2)
          : `milestone ${session.milestoneId} dispatch paused`
      );
    });

  milestone
    .command('resume <milestoneId>')
    .description('lift a pause, optionally with new ceilings')
    .option('--concurrency <n>', 'max concurrent child runs')
    .option('--max-spend <usd>', 'pause once the session has spent this much')
    .option(
      '--max-runs <n>',
      'pause once the session has started this many runs'
    )
    .option('--json')
    .action(
      async (
        milestoneId: string,
        opts: SessionCeilingOptions & { json?: boolean }
      ) => {
        const { client } = await daemonFor(ctx);
        const session = await client.resumeMilestone(
          milestoneId,
          parseSessionCeilings(opts)
        );
        ctx.log(
          opts.json === true
            ? JSON.stringify(session, null, 2)
            : `milestone ${session.milestoneId} dispatch resumed (${describeSession(session)})`
        );
      }
    );

  milestone
    .command('stop <milestoneId>')
    .option('--json')
    .action(async (milestoneId: string, opts: { json?: boolean }) => {
      const { client } = await daemonFor(ctx);
      const session = await client.stopMilestone(milestoneId);
      ctx.log(
        opts.json === true
          ? JSON.stringify(session, null, 2)
          : `milestone ${session.milestoneId} dispatch stopped`
      );
    });

  milestone
    .command('status <milestoneId>')
    .option('--json')
    .option('--watch', 'stream run/task events until the dispatch session ends')
    .action(
      async (
        milestoneId: string,
        opts: { json?: boolean; watch?: boolean }
      ) => {
        const { baseUrl, token, client } = await daemonFor(ctx);

        const renderProgress = (progress: MilestoneProgress): void => {
          ctx.log(
            opts.json === true
              ? JSON.stringify(progress, null, 2)
              : formatMilestoneProgress(progress)
          );
        };

        const initial = await client.getMilestoneProgress(milestoneId);
        renderProgress(initial);
        if (opts.watch !== true || !initial.active) return;

        // try/finally so a lost-connection rejection still disposes the WS
        // connection and reconnect timer, which would otherwise hang the process.
        const watcher = createMilestoneWatcher(
          baseUrl,
          () => client.getMilestoneProgress(milestoneId),
          renderProgress,
          { token }
        );
        try {
          await watcher.waitForExit();
        } finally {
          watcher.dispose();
        }
      }
    );
}
