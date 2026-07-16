import type { Command } from 'commander';
import { TaskStore, PRIORITIES, STATUSES } from '@dispatch/core';
import type { Priority, TaskDoc, TaskKind, TaskStatus } from '@dispatch/core';
import { CliError, type CliContext } from '../context.js';
import { formatTable } from '../output.js';

export function requireStore(ctx: CliContext): TaskStore {
  const store = new TaskStore(ctx.cwd);
  if (!store.isInitialized()) throw new CliError('not initialized — run: dispatch init');
  return store;
}

function validate<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliError(`invalid ${label}: ${value} (expected ${allowed.join('|')})`);
  }
  return value as T;
}

export function taskRow(t: TaskDoc): string[] {
  return [t.meta.id, t.meta.status, t.meta.priority, t.meta.kind, t.meta.title];
}

export const TABLE_HEADER = ['ID', 'STATUS', 'PRI', 'KIND', 'TITLE'];

export function registerTaskCommands(program: Command, ctx: CliContext): void {
  const task = program.command('task').description('Manage tasks and epics');

  task
    .command('create')
    .argument('<title>')
    .option('--kind <kind>', 'task|epic', 'task')
    .option('--description <text>')
    .option('--parent <id>')
    .option('--priority <priority>', 'urgent|high|medium|low|none', 'none')
    .option('--status <status>')
    .option('--label <label...>')
    .option('--blocked-by <id...>')
    .option('--json', 'print the created task as JSON')
    .action((title: string, opts: Record<string, string | string[] | boolean | undefined>) => {
      const store = requireStore(ctx);
      const doc = store.create({
        title,
        kind: validate(opts.kind as string, ['task', 'epic'] as const, 'kind') as TaskKind,
        status: validate(opts.status as string | undefined, STATUSES, 'status') as TaskStatus | undefined,
        description: opts.description as string | undefined,
        parent: (opts.parent as string | undefined) ?? null,
        priority: validate(opts.priority as string, PRIORITIES, 'priority') as Priority,
        labels: (opts.label as string[] | undefined) ?? [],
        blockedBy: (opts.blockedBy as string[] | undefined) ?? [],
      });
      ctx.log(opts.json ? JSON.stringify(doc, null, 2) : `created ${doc.meta.id}  ${doc.meta.title}`);
    });

  task
    .command('list')
    .option('--status <status>')
    .option('--kind <kind>')
    .option('--parent <id>')
    .option('--json')
    .action((opts: Record<string, string | boolean | undefined>) => {
      const store = requireStore(ctx);
      const docs = store.list({
        status: validate(opts.status as string | undefined, STATUSES, 'status') as TaskStatus | undefined,
        kind: validate(opts.kind as string | undefined, ['task', 'epic'] as const, 'kind') as TaskKind | undefined,
        parent: opts.parent as string | undefined,
      });
      if (opts.json) {
        ctx.log(JSON.stringify(docs, null, 2));
        return;
      }
      ctx.log(formatTable([TABLE_HEADER, ...docs.map(taskRow)]));
    });
}
