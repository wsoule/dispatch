import type { Command } from 'commander';
import { readFileSync } from 'node:fs';

import type { PlanProposal, PlanRecord } from '../apiClient.js';
import { createApiClient } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { formatEpicProgress, formatProposal } from '../orchestrateFormat.js';
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
  client: ReturnType<typeof createApiClient>,
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

        const printProgress = async () => {
          const progress = await client.getEpicProgress(epicId);
          ctx.log(
            opts.json === true
              ? JSON.stringify(progress, null, 2)
              : formatEpicProgress(progress)
          );
          return progress;
        };

        const initial = await printProgress();
        if (opts.watch !== true || !initial.active) return;

        // `task.changed`/`run.changed` can both fire for the same
        // underlying action (a review merge touches both a task file and
        // the run registry) — `settled` collapses however many of those
        // land into exactly one final printProgress()/exit, rather than
        // printing the same "now inactive" snapshot once per event.
        let settled = false;
        await new Promise<void>((resolve) => {
          const dispose = connectEvents(baseUrl, (event) => {
            if (
              settled ||
              (event.type !== 'task.changed' && event.type !== 'run.changed')
            ) {
              return;
            }
            void printProgress().then((progress) => {
              if (!progress.active && !settled) {
                settled = true;
                dispose();
                resolve();
              }
            });
          });
        });
      }
    );
}
