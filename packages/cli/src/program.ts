import {
  DISPATCH_DIR,
  loadConfig,
  TaskStore,
  upsertRegisteredProject,
} from '@dispatch/core';
import { cartoInit, discoverCarto } from '@dispatch/core/carto';
import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ensureDaemon,
  openDesktopOrBrowser,
  registerDaemonCommands,
} from './commands/daemon.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerOrchestrateCommands } from './commands/orchestrate.js';
import { registerPlanCommands } from './commands/plan.js';
import { registerTaskCommands } from './commands/task.js';
import type { CliContext } from './context.js';
import { registerMcpServer } from './mcpConfig.js';

// Appends a `.carto/` ignore entry to .gitignore (creating it if needed);
// no-op if a `.carto` line is already there. carto's index is per-machine.
function ensureCartoIgnored(rootDir: string): void {
  const path = join(rootDir, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (/^\.carto\/?\s*$/m.test(existing)) return;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${existing}${prefix}.carto/\n`);
}

// Scaffolds `.dispatch/` for `ctx.cwd` if it isn't there yet. Shared by
// `dispatch init` (explicit, always reports what happened) and the bare
// default action (implicit, only ever runs this on a project's very first
// `dispatch` invocation) so the check-then-scaffold logic lives in exactly
// one place. Returns whether it actually ran the scaffold — callers use that
// to decide what to log and whether to also register the MCP server.
function initIfMissing(ctx: CliContext): boolean {
  if (existsSync(join(ctx.cwd, DISPATCH_DIR, 'tasks'))) return false;
  TaskStore.init(ctx.cwd);
  ensureCartoIgnored(ctx.cwd);
  return true;
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

  return program;
}
