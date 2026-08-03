import {
  DISPATCH_DIR,
  TaskStore,
  upsertRegisteredProject,
} from '@dispatch/core';
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
import { registerOrchestrateCommands } from './commands/orchestrate.js';
import { registerPlanCommands } from './commands/plan.js';
import { registerScopeCommands } from './commands/scope.js';
import { registerTaskCommands } from './commands/task.js';
import type { CliContext } from './context.js';
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
  const alreadyInitialized = existsSync(join(ctx.cwd, DISPATCH_DIR, 'tasks'));
  if (!alreadyInitialized) TaskStore.init(ctx.cwd);
  writeGitAttributes(ctx.cwd);
  registerMergeDriverGitConfig(ctx.cwd);
  registerTeamMergeDriverGitConfig(ctx.cwd);
  return !alreadyInitialized;
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
    .action((opts: { mcp: boolean }) => {
      if (initIfMissing(ctx)) {
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

  return program;
}
