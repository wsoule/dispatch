import {
  DISPATCH_DIR,
  ensureProjectGitignore,
  initProjectStores,
  loadConfig,
  readProjectBackend,
  TaskStore,
  upsertRegisteredProject,
  writeProjectBackend,
} from '@dispatch-foo/core';
import { cartoInit, discoverCarto } from '@dispatch-foo/core/carto';
import { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { registerA2ACommands } from './commands/a2a.js';
import { registerApprovalsCommands } from './commands/approvals.js';
import { registerBoardSyncCommands } from './commands/boardSync.js';
import { registerBrowserCommands } from './commands/browser.js';
import {
  ensureDaemon,
  openDesktopOrBrowser,
  registerDaemonCommands,
} from './commands/daemon.js';
import { registerDocsCommands } from './commands/docs.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerFanoutCommand } from './commands/fanout.js';
import { registerLicenseCommands } from './commands/license.js';
import { registerMemoryCommands } from './commands/memory.js';
import { registerMergeTaskCommand } from './commands/mergeTask.js';
import { registerMergeTeamCommand } from './commands/mergeTeam.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerOrchestrateCommands } from './commands/orchestrate.js';
import { registerPlanCommands } from './commands/plan.js';
import { registerReceiptsCommands } from './commands/receipts.js';
import { registerRemoteCommands } from './commands/remote.js';
import { registerScopeCommands } from './commands/scope.js';
import { registerShareCommands } from './commands/share.js';
import { registerTaskCommands } from './commands/task.js';
import { registerTeamCommands } from './commands/team.js';
import { registerWorktreeCommands } from './commands/worktree.js';
import { type CliContext, CliError } from './context.js';
import { registerMcpServer } from './mcpConfig.js';
import {
  registerMergeDriverGitConfig,
  registerTeamMergeDriverGitConfig,
  writeGitAttributes,
} from './mergeDriver.js';
import { projectRoot } from './projectRoot.js';

// The `.dispatch/` entries init reports on. Init only ever adds to these: an
// existing file is never rewritten or removed, only topped up (.gitignore).
const INIT_ENTRIES = ['config.yml', 'team.yml', '.gitignore', 'tasks'];

type DispatchSnapshot = Map<string, string | null>;

// Each entry's content (a directory reads as ''), or null when absent.
function snapshotDispatchDir(rootDir: string): DispatchSnapshot {
  const dir = join(rootDir, DISPATCH_DIR);
  return new Map(
    INIT_ENTRIES.map((name) => {
      const path = join(dir, name);
      if (!existsSync(path)) return [name, null];
      return [
        name,
        statSync(path).isDirectory() ? '' : readFileSync(path, 'utf8'),
      ];
    })
  );
}

interface InitReport {
  /** Whether this call created the markdown board. */
  scaffolded: boolean;
  /** Whether `.dispatch/` held none of the reported entries beforehand. */
  fresh: boolean;
  /** Whether init created or changed anything at all. */
  changed: boolean;
  /** One line naming what was kept, created and topped up, for `fresh: false`. */
  summary: string;
}

// Compares two snapshots so init can say exactly what it touched.
function describeInit(
  before: DispatchSnapshot,
  after: DispatchSnapshot
): Omit<InitReport, 'scaffolded'> {
  const kept: string[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  for (const [name, prior] of before) {
    const now = after.get(name) ?? null;
    const label = name === 'tasks' ? 'tasks/' : name;
    if (prior === null) {
      if (now !== null) created.push(label);
    } else if (prior === now) kept.push(label);
    else updated.push(label);
  }
  const parts = [
    kept.length > 0 ? `kept ${kept.join(', ')}` : null,
    created.length > 0 ? `created ${created.join(', ')}` : null,
    updated.length > 0
      ? `added missing ignore rules to ${updated.join(', ')}`
      : null,
  ].filter((part) => part !== null);
  return {
    fresh: kept.length + updated.length === 0,
    changed: created.length + updated.length > 0,
    summary: `${DISPATCH_DIR}/: ${parts.join('; ')}`,
  };
}

// Refuses before writing anything when the existing config.yml cannot be
// read: init never rewrites it, so the user has to fix it.
function assertConfigReadable(rootDir: string): void {
  if (!existsSync(join(rootDir, DISPATCH_DIR, 'config.yml'))) return;
  try {
    loadConfig(rootDir);
  } catch (err) {
    throw new CliError(
      `${DISPATCH_DIR}/config.yml exists but cannot be read (${(err as Error).message}). init never rewrites it — fix it, then run init again.`
    );
  }
}

// Scaffolds `.dispatch/` for `ctx.cwd` where it is missing pieces, and (re-)
// registers the merge drivers unconditionally. Shared by `dispatch init` and
// the bare default action. Never overwrites or removes an existing file: a
// teammate's clone arrives with a committed config.yml and team.yml, and
// those are the team's, not init's. Driver registration runs on every call
// because a fresh clone's local git config never has them.
function initIfMissing(ctx: CliContext): InitReport {
  assertConfigReadable(ctx.cwd);
  const before = snapshotDispatchDir(ctx.cwd);
  const backend = readProjectBackend(ctx.cwd) ?? 'files';
  // A database-backed project counts as initialized even though it has no
  // `.dispatch/tasks`, because it is not supposed to have one. Testing only
  // for the directory put an empty markdown board back beside the database on
  // every `dispatch init` and every bare `dispatch` — silently undoing a
  // `dispatch migrate --retire`, and then telling the user to "create your
  // first task" against a board nothing reads.
  const alreadyInitialized =
    backend === 'sqlite' || existsSync(join(ctx.cwd, DISPATCH_DIR, 'tasks'));
  if (!alreadyInitialized) TaskStore.init(ctx.cwd);
  // Unconditional, for the same reason the merge drivers below are: a project
  // initialized before these rules existed only ever gets them if something
  // that runs on an EXISTING project writes them. Additive only.
  ensureProjectGitignore(ctx.cwd, backend);
  writeGitAttributes(ctx.cwd);
  registerMergeDriverGitConfig(ctx.cwd);
  registerTeamMergeDriverGitConfig(ctx.cwd);
  return {
    scaffolded: !alreadyInitialized,
    ...describeInit(before, snapshotDispatchDir(ctx.cwd)),
  };
}

/**
 * `dispatch init --db`: a project whose tasks live in the daemon's database
 * from the very first one, so its `.dispatch/` never holds anything but the
 * config a human would want to commit.
 *
 * Refuses over an existing markdown board rather than initializing beside one.
 * Creating a database next to `.dispatch/tasks` produces a project with two
 * boards and a marker naming the empty one, which is exactly the state the
 * one-time import exists to resolve — so it points at that instead.
 *
 * The daemon caveat is printed, not hidden. On this backend `dispatch task`
 * commands go through dispatchd (see resolveTaskRoute in commands/task.ts) and
 * a read deliberately does not auto-start one, so `dispatch task create`
 * straight after this would fail with nothing explaining why.
 */
function initDatabaseBacked(ctx: CliContext): void {
  if (readProjectBackend(ctx.cwd) === 'sqlite') {
    ctx.log('already initialized (this project is database-backed)');
    return;
  }
  assertConfigReadable(ctx.cwd);
  if (existsSync(join(ctx.cwd, DISPATCH_DIR, 'tasks'))) {
    throw new CliError(
      `${ctx.cwd} already has a markdown task board. Those files are its tasks, so this will not initialize a second, empty one beside them. Move them into the database instead: dispatch migrate`
    );
  }
  const before = snapshotDispatchDir(ctx.cwd);
  initProjectStores({ rootDir: ctx.cwd, backend: 'sqlite' }).close();
  if (readProjectBackend(ctx.cwd) !== 'sqlite') {
    writeProjectBackend(ctx.cwd, 'sqlite');
  }
  writeGitAttributes(ctx.cwd);
  registerMergeDriverGitConfig(ctx.cwd);
  registerTeamMergeDriverGitConfig(ctx.cwd);
  ctx.log(
    `Initialized ${DISPATCH_DIR}/ with a daemon-owned database. Your repo holds the config; the tasks live in dispatch.db and reach git as receipts.`
  );
  const report = describeInit(before, snapshotDispatchDir(ctx.cwd));
  if (!report.fresh) ctx.log(report.summary);
  ctx.log(
    'dispatchd is the only process that may open it, so start it before creating tasks: dispatch serve'
  );
}

export function makeProgram(ctx: CliContext): Command {
  const program = new Command('dispatch')
    .description(
      'Git-native task tracking and agent orchestration\n\n' +
        'With no subcommand: initializes .dispatch/ if needed, registers this ' +
        'project, and opens the dispatch UI (the desktop app if installed, ' +
        'otherwise a browser tab).'
    )
    .exitOverride();

  program
    .command('init')
    .description('Scaffold .dispatch/ in the current directory')
    .option('--no-mcp', 'skip registering the dispatch MCP server in .mcp.json')
    .option(
      '--db',
      "keep this project's tasks in the daemon's database instead of markdown files",
      false
    )
    .action((opts: { mcp: boolean; db: boolean }) => {
      if (opts.db) {
        initDatabaseBacked(ctx);
      } else {
        const report = initIfMissing(ctx);
        if (report.fresh) {
          ctx.log(
            `Initialized ${DISPATCH_DIR}/ — create your first task with: dispatch task create "<title>"`
          );
        } else if (report.changed) {
          ctx.log(`Found an existing ${report.summary}`);
        } else {
          ctx.log(`already initialized — ${report.summary}`);
        }
      }
      if (opts.mcp !== false) {
        registerMcpServer(ctx.cwd);
        ctx.log('Registered the dispatch MCP server in .mcp.json');
      }
      // Idempotent — safe to call again even when initIfMissing already ran
      // it above, and this is what re-registers the drivers for a project
      // whose local git config lost them (e.g. a fresh clone).
      writeGitAttributes(ctx.cwd);
      const taskDriverOk = registerMergeDriverGitConfig(ctx.cwd);
      const teamDriverOk = registerTeamMergeDriverGitConfig(ctx.cwd);
      if (taskDriverOk && teamDriverOk) {
        ctx.log(
          'Registered the task-file and team-roster merge drivers (.gitattributes + git config)'
        );
      } else {
        ctx.log(
          'Could not register the merge driver git config — ' +
            'is this a git repository, and is git on PATH?'
        );
      }

      // 'on' means Dispatch may build the container itself; an absent or
      // unusable binary just degrades later lookups, so this never blocks init.
      if (loadConfig(ctx.cwd).carto.enabled === 'on') {
        const discovery = discoverCarto();
        if (discovery.ok) {
          const result = cartoInit(ctx.cwd, discovery.binary);
          ctx.log(
            result.ok
              ? `Indexed the repo with carto ${discovery.binary.version}`
              : `carto index skipped: ${result.detail}`
          );
        }
      }
    });

  // Bare `dispatch` in a repo: initialize if needed, register the project,
  // ensure the daemon, and open the app (desktop if installed, else the
  // browser UI). Known v1 limitation: launch args don't reach an
  // already-running desktop instance — but the registry entry makes the
  // project appear in its switcher immediately.
  program.action(async () => {
    const report = initIfMissing(ctx);
    if (report.scaffolded) registerMcpServer(ctx.cwd);
    if (report.fresh) ctx.log(`Initialized ${DISPATCH_DIR}/`);
    else if (report.changed) ctx.log(`Found an existing ${report.summary}`);
    // The registry names projects, and a worktree or subdirectory is not
    // one — same root ensureDaemon keys its daemon on.
    upsertRegisteredProject(projectRoot(ctx.cwd));
    const { port } = await ensureDaemon(ctx);
    openDesktopOrBrowser(ctx, port);
  });

  program
    .command('mcp')
    .description('Run the dispatch MCP server over stdio')
    .action(async () => {
      // Deliberately no requireStore() gate here: the server's own tools
      // re-resolve the TaskStore on every call and return a clean MCP tool
      // error (isError: true, "not initialized — run: dispatch init") when
      // `.dispatch` doesn't exist yet — see packages/mcp/src/tools.ts. That
      // means `dispatch mcp` can start before `dispatch init` runs, and an
      // init that happens later is picked up without restarting the server.
      // Dynamic import keeps `@modelcontextprotocol/sdk` and its transitive
      // deps out of the CLI's startup path — every other command pays
      // nothing for this one existing.
      const { runStdioServer } = await import('@dispatch/mcp');
      // A background daemon exits after it sits unused, so a quiet agent
      // session can outlive it; this lets the task tools start a fresh one
      // the same way every other command does. `ensureDaemon` keys on the
      // project root itself, so the root the tool passes is used as its cwd.
      await runStdioServer(ctx.cwd, {
        startDaemon: async (rootDir) => {
          await ensureDaemon({ ...ctx, cwd: rootDir });
        },
      });
    });

  registerTaskCommands(program, ctx);
  registerDoctorCommand(program, ctx);
  registerDaemonCommands(program, ctx);
  registerOrchestrateCommands(program, ctx);
  registerPlanCommands(program, ctx);
  registerMergeTaskCommand(program, ctx);
  registerMergeTeamCommand(program, ctx);
  registerScopeCommands(program, ctx);
  registerApprovalsCommands(program, ctx);
  registerMemoryCommands(program, ctx);
  registerBrowserCommands(program, ctx);
  registerFanoutCommand(program, ctx);
  registerRemoteCommands(program, ctx);
  registerWorktreeCommands(program, ctx);
  registerShareCommands(program, ctx);
  registerTeamCommands(program, ctx);
  registerBoardSyncCommands(program, ctx);
  registerReceiptsCommands(program, ctx);
  registerDocsCommands(program, ctx);
  registerLicenseCommands(program, ctx);
  registerMigrateCommand(program, ctx);
  registerA2ACommands(program, ctx);

  return program;
}
