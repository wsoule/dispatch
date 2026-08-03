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
import {
  formatEpicProgress,
  formatPlanNeedsReply,
  formatProposal,
} from '../orchestrateFormat.js';
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

// Watches an epic dispatch session over WS and resolves once a progress snapshot reports
// `active: false`. Callers MUST wrap it in try/finally and always call `dispose()`.
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
    '\nStart a plan with:\n  dispatch plan <prompt...> [--planner claude|fake] [--json] [--yes]' +
      '\nAnswer the planner with:\n  dispatch plan reply <planId> <message...>'
  );

  plan
    .command('submit <prompt...>', { isDefault: true, hidden: true })
    .option('--planner <name>', 'claude|fake', 'claude')
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
          planner: string;
          json?: boolean;
          yes?: boolean;
          timeout: string;
        }
      ) => {
        const baseUrl = await baseUrlFor(ctx);
        const client = createApiClient(baseUrl);
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
            record.questions.length > 0
              ? `plan ${planId} is waiting on ${record.questions.length} question(s) — see them with: dispatch plan show ${planId}`
              : `plan ${planId} has no proposal to confirm (state: ${record.state})`
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

  // The follow-up `dispatch plan` points at when a plan hasn't settled within
  // `--timeout`, and for checking back on one later.
  plan
    .command('show <planId>')
    .option('--json')
    .action(async (planId: string, opts: { json?: boolean }) => {
      const baseUrl = await baseUrlFor(ctx);
      const client = createApiClient(baseUrl);
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
        const baseUrl = await baseUrlFor(ctx);
        const client = createApiClient(baseUrl);
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

        // try/finally so a lost-connection rejection still disposes the WS
        // connection and reconnect timer, which would otherwise hang the process.
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
