import type { Command } from 'commander';
import { TaskStore, PRIORITIES, KINDS, ASSIGNEES, readyTasks, loadConfig } from '@dispatch/core';
import type { Priority, TaskDoc, TaskKind } from '@dispatch/core';
import { CliError, type CliContext } from '../context.js';
import { formatTable } from '../output.js';
import { readFileSync } from 'node:fs';

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
      if (!title.trim()) throw new CliError('title must not be empty');
      const store = requireStore(ctx);
      const config = loadConfig(ctx.cwd);
      const doc = store.create({
        title,
        kind: validate(opts.kind as string, KINDS, 'kind') as TaskKind,
        status: validate(opts.status as string | undefined, config.statuses, 'status'),
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
      const config = loadConfig(ctx.cwd);
      const docs = store.list({
        status: validate(opts.status as string | undefined, config.statuses, 'status'),
        kind: validate(opts.kind as string | undefined, KINDS, 'kind') as TaskKind | undefined,
        parent: opts.parent as string | undefined,
      });
      if (opts.json) {
        ctx.log(JSON.stringify(docs, null, 2));
        return;
      }
      ctx.log(formatTable([TABLE_HEADER, ...docs.map(taskRow)]));
    });

  task
    .command('show')
    .argument('<id>')
    .option('--json')
    .action((id: string, opts: { json?: boolean }) => {
      const store = requireStore(ctx);
      const doc = store.get(id);
      if (!doc) throw new CliError(`task not found: ${id}`);
      if (opts.json) {
        ctx.log(JSON.stringify(doc, null, 2));
        return;
      }
      ctx.log(readFileSync(store.taskFilePath(id)!, 'utf8'));
    });

  task
    .command('status')
    .argument('<id>')
    .argument('<status>')
    .action((id: string, status: string) => {
      const store = requireStore(ctx);
      const config = loadConfig(ctx.cwd);
      const valid = validate(status, config.statuses, 'status')!;
      if (!store.get(id)) throw new CliError(`task not found: ${id}`);
      store.update(id, {
        status: valid,
        appendActivity: `${new Date().toISOString()} status → ${valid}`,
      });
      ctx.log(`${id} → ${valid}`);
    });

  task
    .command('edit')
    .argument('<id>')
    .option('--title <title>')
    .option('--priority <priority>')
    .option('--assignee <assignee>', 'agent|human|none')
    .option('--parent <id>')
    .option('--add-label <label...>')
    .option('--add-blocked-by <id...>')
    .action((id: string, opts: Record<string, string | string[] | undefined>) => {
      const store = requireStore(ctx);
      const doc = store.get(id);
      if (!doc) throw new CliError(`task not found: ${id}`);
      store.update(id, {
        title: opts.title as string | undefined,
        priority: validate(opts.priority as string | undefined, PRIORITIES, 'priority') as Priority | undefined,
        assignee: validate(opts.assignee as string | undefined, ASSIGNEES, 'assignee'),
        parent: (opts.parent as string | undefined) ?? doc.meta.parent,
        labels: opts.addLabel ? [...doc.meta.labels, ...(opts.addLabel as string[])] : undefined,
        blockedBy: opts.addBlockedBy ? [...doc.meta.blockedBy, ...(opts.addBlockedBy as string[])] : undefined,
      });
      ctx.log(`updated ${id}`);
    });

  task
    .command('next')
    .description('Tasks ready to start: todo with all blockers done')
    .option('--json')
    .action((opts: { json?: boolean }) => {
      const store = requireStore(ctx);
      const ready = readyTasks(store.list());
      if (opts.json) {
        ctx.log(JSON.stringify(ready, null, 2));
        return;
      }
      ctx.log(formatTable([TABLE_HEADER, ...ready.map(taskRow)]));
    });
}
