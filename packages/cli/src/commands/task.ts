import {
  ActorContext,
  ASSIGNEES,
  canonicalStatus,
  KINDS,
  loadConfig,
  PRIORITIES,
  readProjectBackend,
  readyTasks,
  serializeTaskFile,
  TaskStore,
} from '@dispatch/core';
import type {
  CreateInput,
  GitReader,
  ListFilter,
  Priority,
  TaskDoc,
  TaskKind,
  UpdatePatch,
} from '@dispatch/core';
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { TaskApiClient } from '../apiClient.js';
import { createTaskApiClient } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { formatTable } from '../output.js';
import { findRunningDaemon } from './daemon.js';

// The status alias layer, tolerant of an omitted flag.
function canonicalStatusOpt(value: string | undefined): string | undefined {
  return value === undefined ? undefined : canonicalStatus(value);
}

// ActorContext's GitReader seam, Node-based — mirrors server/src/index.ts's
// `makeGitReader` (which uses Bun.spawnSync instead, since the daemon is
// Bun-only) so the CLI resolves the exact same identity a daemon in the same
// repo would.
function makeGitReader(cwd: string): GitReader {
  return (args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
}

// The CLI is always run directly by a human at a terminal — resolved fresh
// per command, same as the daemon resolves it fresh per boot.
function resolveActor(ctx: CliContext): ActorContext {
  return ActorContext.resolve(ctx.cwd, makeGitReader(ctx.cwd));
}

const NOT_INITIALIZED = 'not initialized — run: dispatch init';

const DAEMON_REQUIRED =
  "dispatchd is not running — this project keeps its tasks in the daemon's " +
  'database, which only dispatchd may open. Start it with: dispatch serve';

export function requireStore(ctx: CliContext): TaskStore {
  const store = new TaskStore(ctx.cwd);
  if (!store.isInitialized()) throw new CliError(NOT_INITIALIZED);
  return store;
}

/**
 * The "is there a project here at all?" gate, for commands that only need to
 * know a project exists before they talk to the daemon about runs or plans.
 *
 * Unlike `requireStore` this accepts either backend: a database-backed
 * project has no `.dispatch/tasks` directory, and gating on one would refuse
 * every orchestrate/plan/scope command in exactly the projects this epic is
 * moving towards.
 */
export function requireInitialized(ctx: CliContext): void {
  if (new TaskStore(ctx.cwd).isInitialized()) return;
  if (databaseBacked(ctx.cwd)) return;
  throw new CliError(NOT_INITIALIZED);
}

/**
 * Whether this project's tasks live in a database only dispatchd may open.
 *
 * Read from the choice the project recorded for itself, NOT from whether a
 * `dispatch.db` file happens to exist: a stray or half-created database would
 * otherwise lock the CLI out of a project whose tasks are really still in
 * markdown, with no way to say otherwise. Existence is not ownership.
 *
 * The marker is written when a project moves to the database — by the daemon
 * at boot, or by `dispatch migrate`. `@dispatch/core`'s storage.ts owns the
 * format; a mangled marker reads there as null, which degrades this project to
 * its pre-marker behaviour rather than failing every task command.
 */
export function databaseBacked(rootDir: string): boolean {
  return readProjectBackend(rootDir) === 'sqlite';
}

/**
 * The PROJECT root, which inside an agent's run worktree is not the cwd.
 *
 * A dispatched run executes in `~/.dispatch/worktrees/<hash>/<runId>`, a
 * checkout with its own `.dispatch/` copy and no daemon of its own. Resolving
 * a task command against that raw cwd finds no daemon file and — once the
 * project is database-backed — no marker either, so `dispatch task list` from
 * inside a run either reports an uninitialized project or throws
 * DAEMON_REQUIRED while the real daemon is running perfectly well a few
 * directories away.
 *
 * The executor already publishes the mapping as DISPATCH_PROJECT_ROOT whenever
 * the worktree differs from the project. The MCP tools have consumed it since
 * they were written (see projectRoot() in packages/mcp/src/tools.ts); the CLI
 * simply never did, which is why the same task command works through MCP and
 * fails through the terminal in the same worktree.
 */
export function projectRoot(cwd: string): string {
  const override = process.env.DISPATCH_PROJECT_ROOT;
  return override !== undefined && override !== '' ? override : cwd;
}

/**
 * Where a `dispatch task` command reads and writes.
 *
 * dispatchd is a project's single writer: while it runs, it holds the store
 * and the CLI asks it over HTTP rather than opening a second handle. With no
 * daemon running the CLI reads the markdown directly — the same thing it has
 * always done, and still safe, because file-backed tasks have no exclusive
 * writer to conflict with. A database-backed project has no such fallback,
 * so the command says so instead of guessing.
 *
 * Discovery is `findRunningDaemon`, never `ensureDaemon`: `dispatch task
 * list` is a read, and a read should not leave a background daemon running
 * behind it. Commands that genuinely need orchestration (`dispatch run`,
 * `dispatch plan`) still auto-start one.
 */
type TaskRoute =
  | { via: 'daemon'; api: TaskApiClient }
  | { via: 'local'; store: TaskStore };

async function resolveTaskRoute(ctx: CliContext): Promise<TaskRoute> {
  // A daemon file written before two-tier auth carries no agent token, and
  // `findRunningDaemon` throws rather than returning one. For a task command
  // that is not fatal — it just means there is no daemon we can present a
  // credential to, so fall through to the same handling as no daemon at all.
  // Commands that genuinely require dispatchd (scope decide, orchestrate)
  // keep the explicit error, which is the right answer for them.
  // projectRoot(), not the raw cwd — see its doc comment: inside a run's
  // worktree the daemon, the marker and the real board all live at the
  // project root, and resolving against the worktree finds none of them.
  const root = projectRoot(ctx.cwd);
  const daemon = await findRunningDaemon(root).catch(() => null);
  if (daemon !== null) {
    return {
      via: 'daemon',
      api: createTaskApiClient(
        `http://127.0.0.1:${daemon.port}`,
        daemon.agentToken
      ),
    };
  }
  if (databaseBacked(root)) throw new CliError(DAEMON_REQUIRED);
  return { via: 'local', store: requireStore(ctx) };
}

function validate<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliError(
      `invalid ${label}: ${value} (expected ${allowed.join('|')})`
    );
  }
  return value as T;
}

function taskRow(t: TaskDoc): string[] {
  return [t.meta.id, t.meta.status, t.meta.priority, t.meta.kind, t.meta.title];
}

const TABLE_HEADER = ['ID', 'STATUS', 'PRI', 'KIND', 'TITLE'];

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
    .action(
      async (
        title: string,
        opts: Record<string, string | string[] | boolean | undefined>
      ) => {
        if (title.trim() === '') throw new CliError('title must not be empty');
        const route = await resolveTaskRoute(ctx);
        const config = loadConfig(ctx.cwd);
        const input: CreateInput = {
          title,
          kind: validate(opts.kind as string, KINDS, 'kind') as TaskKind,
          status: validate(
            canonicalStatusOpt(opts.status as string | undefined),
            config.statuses,
            'status'
          ),
          description: opts.description as string | undefined,
          parent: (opts.parent as string | undefined) ?? null,
          priority: validate(
            opts.priority as string,
            PRIORITIES,
            'priority'
          ) as Priority,
          labels: (opts.label as string[] | undefined) ?? [],
          blockedBy: (opts.blockedBy as string[] | undefined) ?? [],
        };
        const doc =
          route.via === 'daemon'
            ? await route.api.createTask(input)
            : route.store.create(input);
        ctx.log(
          opts.json === true
            ? JSON.stringify(doc, null, 2)
            : `created ${doc.meta.id}  ${doc.meta.title}`
        );
      }
    );

  task
    .command('list')
    .option('--status <status>')
    .option('--kind <kind>')
    .option('--parent <id>')
    .option('--json')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      const route = await resolveTaskRoute(ctx);
      const config = loadConfig(ctx.cwd);
      const query: ListFilter = {
        status: validate(
          canonicalStatusOpt(opts.status as string | undefined),
          config.statuses,
          'status'
        ),
        kind: validate(opts.kind as string | undefined, KINDS, 'kind'),
        parent: opts.parent as string | undefined,
      };
      const docs =
        route.via === 'daemon'
          ? await route.api.listTasks(query)
          : route.store.list(query);
      if (opts.json === true) {
        ctx.log(JSON.stringify(docs, null, 2));
        return;
      }
      ctx.log(formatTable([TABLE_HEADER, ...docs.map(taskRow)]));
    });

  task
    .command('show')
    .argument('<id>')
    .option('--json')
    .action(async (id: string, opts: { json?: boolean }) => {
      const route = await resolveTaskRoute(ctx);
      if (route.via === 'local') {
        const doc = route.store.get(id);
        if (doc === null) throw new CliError(`task not found: ${id}`);
        ctx.log(
          opts.json === true
            ? JSON.stringify(doc, null, 2)
            : // Still the file's own bytes on this path, exactly as before —
              // a hand-edited task file shows as the user actually wrote it.
              readFileSync(route.store.taskFilePath(id)!, 'utf8')
        );
        return;
      }
      // The daemon's 404 already reads `task not found: <id>`, and `request`
      // turns that into a CliError carrying its wording.
      const doc = await route.api.getTask(id);
      ctx.log(
        opts.json === true
          ? JSON.stringify(doc, null, 2)
          : // Rendered from the doc: a database-backed project has no file to
            // cat, and serializing is what produced a task file's contents in
            // the first place, so the two forms agree.
            serializeTaskFile(doc)
      );
    });

  task
    .command('status')
    .argument('<id>')
    .argument('<status>')
    .action(async (id: string, status: string) => {
      const route = await resolveTaskRoute(ctx);
      const config = loadConfig(ctx.cwd);
      const valid = validate(
        canonicalStatus(status),
        config.statuses,
        'status'
      )!;
      const patch: UpdatePatch = {
        status: valid,
        appendActivity: `${new Date().toISOString()} status → ${valid}`,
      };
      if (route.via === 'daemon') {
        // No `activityActor` on this path on purpose: PATCH /api/tasks/:id
        // credits the Activity line to the daemon's own resolved human and
        // ignores whatever the client sent, so that a client cannot forge
        // attribution. Sending one would be discarded anyway.
        await route.api.updateTask(id, patch);
      } else {
        if (route.store.get(id) === null) {
          throw new CliError(`task not found: ${id}`);
        }
        route.store.update(id, {
          ...patch,
          activityActor: resolveActor(ctx).humanRef,
        });
      }
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
    .action(
      async (
        id: string,
        opts: Record<string, string | string[] | undefined>
      ) => {
        const route = await resolveTaskRoute(ctx);
        let doc: TaskDoc | null;
        if (route.via === 'daemon') {
          doc = await route.api.getTask(id);
        } else {
          doc = route.store.get(id);
          if (doc === null) throw new CliError(`task not found: ${id}`);
        }
        // --add-label/--add-blocked-by are additive, so they are resolved
        // against the doc just fetched. Read-modify-write against a live
        // daemon can lose a concurrent edit to the same list; that race
        // predates this change (it was read-modify-write against the file
        // before) and is left as-is rather than widened into an API change.
        const patch: UpdatePatch = {
          title: opts.title as string | undefined,
          priority: validate(
            opts.priority as string | undefined,
            PRIORITIES,
            'priority'
          ),
          assignee: validate(
            opts.assignee as string | undefined,
            ASSIGNEES,
            'assignee'
          ),
          parent: (opts.parent as string | undefined) ?? doc.meta.parent,
          labels:
            opts.addLabel !== undefined
              ? [...doc.meta.labels, ...(opts.addLabel as string[])]
              : undefined,
          blockedBy:
            opts.addBlockedBy !== undefined
              ? [...doc.meta.blockedBy, ...(opts.addBlockedBy as string[])]
              : undefined,
        };
        if (route.via === 'daemon') await route.api.updateTask(id, patch);
        else route.store.update(id, patch);
        ctx.log(`updated ${id}`);
      }
    );

  task
    .command('next')
    .description('Tasks ready to start: todo with all blockers done')
    .option('--json')
    .action(async (opts: { json?: boolean }) => {
      const route = await resolveTaskRoute(ctx);
      const ready =
        route.via === 'daemon'
          ? await route.api.readyTasks()
          : // The FULL set, archived included: readyTasks excludes archived
            // tasks from its own results, but needs them present to resolve
            // blockers. Filtering them out here made archiving an unfinished
            // blocker spring everything it was blocking.
            readyTasks(route.store.list());
      if (opts.json === true) {
        ctx.log(JSON.stringify(ready, null, 2));
        return;
      }
      ctx.log(formatTable([TABLE_HEADER, ...ready.map(taskRow)]));
    });
}
