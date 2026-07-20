import { DISPATCH_DIR, TaskStore } from '@dispatch/core';
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { registerDaemonCommands } from './commands/daemon.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerTaskCommands, requireStore } from './commands/task.js';
import type { CliContext } from './context.js';
import { registerMcpServer } from './mcpConfig.js';

export function makeProgram(ctx: CliContext): Command {
  const program = new Command('dispatch')
    .description('Git-native task tracking and agent orchestration')
    .exitOverride();

  program
    .command('init')
    .description('Scaffold .dispatch/ in the current directory')
    .option('--no-mcp', 'skip registering the dispatch MCP server in .mcp.json')
    .action((opts: { mcp: boolean }) => {
      if (existsSync(join(ctx.cwd, DISPATCH_DIR, 'tasks'))) {
        ctx.log('already initialized (.dispatch exists)');
      } else {
        TaskStore.init(ctx.cwd);
        ctx.log(
          `Initialized ${DISPATCH_DIR}/ — create your first task with: dispatch task create "<title>"`
        );
      }
      if (opts.mcp !== false) {
        registerMcpServer(ctx.cwd);
        ctx.log('Registered the dispatch MCP server in .mcp.json');
      }
    });

  program
    .command('mcp')
    .description('Run the dispatch MCP server over stdio')
    .action(async () => {
      requireStore(ctx);
      // Dynamic import keeps `@modelcontextprotocol/sdk` and its transitive
      // deps out of the CLI's startup path — every other command pays
      // nothing for this one existing.
      const { runStdioServer } = await import('@dispatch/mcp');
      await runStdioServer(ctx.cwd);
    });

  registerTaskCommands(program, ctx);
  registerDoctorCommand(program, ctx);
  registerDaemonCommands(program, ctx);

  return program;
}
