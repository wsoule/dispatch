import {
  DISPATCH_DIR,
  ensureProjectGitignore,
  initProjectStores,
  loadConfig,
  readProjectBackend,
  TaskStore,
  upsertRegisteredProject,
  writeProjectBackend,
} from '@dispatch/core';
import { cartoInit, discoverCarto } from '@dispatch/core/carto';
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  ensureDaemon,
  openDesktopOrBrowser,
  registerDaemonCommands,
} from './commands/daemon.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerMergeTaskCommand } from './commands/mergeTask.js';
import { registerMergeTeamCommand } from './commands/mergeTeam.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerOrchestrateCommands } from './commands/orchestrate.js';
import { registerPlanCommands } from './commands/plan.js';
import { registerScopeCommands } from './commands/scope.js';
import { registerTaskCommands } from './commands/task.js';
import { type CliContext, CliError } from './context.js';
import { registerMcpServer } from './mcpConfig.js';
import {
  registerMergeDriverGitConfig,
  registerTeamMergeDriverGitConfig,
  writeGitAttributes,
} from './mergeDriver.js';

// Scaffolds `.dispatch/` for `ctx.cwd` if it isn't there yet, and (re-)
// registers the merge drivers unconditionally. Shared by `dispatch init`
// (explicit, always reports what happened) and the bare default action
// (implicit) so the check-then-scaffold logic lives in exactly one place.
// Driver registration runs on every call, not just a fresh scaffold — a
// project initialized before the drivers existed, or whose local git config
// lost them (e.g. a fresh clone), only ever gets repaired if something
// unconditional touches it, and the bare `dispatch` command is by far the
// most common path back into an existing project. Returns whether it
// actually scaffolded — callers use that to decide what to log and whether
// to also register the MCP server.
function initIfMissing(ctx: CliContext): boolean {
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
  // that runs on an EXISTING project writes them. That is the case that
  // matters most here — a long-lived project is exactly the one that will
  // later run `dispatch migrate` and start producing a dispatch.db to commit.
  ensureProjectGitignore(ctx.cwd, backend);
  writeGitAttributes(ctx.cwd);
  registerMergeDriverGitConfig(ctx.cwd);
  registerTeamMergeDriverGitConfig(ctx.cwd);
  return !alreadyInitialized;
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
  if (existsSync(join(ctx.cwd, DISPATCH_DIR, 'tasks'))) {
    throw new CliError(
      `${ctx.cwd} already has a markdown task board. Those files are its tasks, so this will not initialize a second, empty one beside them. Move them into the database instead: dispatch migrate`
    );
  }
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
      } else if (initIfMissing(ctx)) {
        ctx.log(
          `Initialized ${DISPATCH_DIR}/ — create your first task with: dispatch task create "<title>"`
        );
      } else {
        ctx.log('already initialized (.dispatch exists)');
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
    if (initIfMissing(ctx)) {
      registerMcpServer(ctx.cwd);
      ctx.log(`Initialized ${DISPATCH_DIR}/`);
    }
    upsertRegisteredProject(ctx.cwd);
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
      await runStdioServer(ctx.cwd);
    });

  registerTaskCommands(program, ctx);
  registerDoctorCommand(program, ctx);
  registerDaemonCommands(program, ctx);
  registerOrchestrateCommands(program, ctx);
  registerPlanCommands(program, ctx);
  registerMergeTaskCommand(program, ctx);
  registerMergeTeamCommand(program, ctx);
  registerScopeCommands(program, ctx);
  registerMigrateCommand(program, ctx);

  return program;
}
