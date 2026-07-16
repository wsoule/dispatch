import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore, DISPATCH_DIR } from '@dispatch/core';
import type { CliContext } from './context.js';
import { registerTaskCommands } from './commands/task.js';

export function makeProgram(ctx: CliContext): Command {
  const program = new Command('dispatch')
    .description('Git-native task tracking and agent orchestration')
    .exitOverride();

  program
    .command('init')
    .description('Scaffold .dispatch/ in the current directory')
    .action(() => {
      if (existsSync(join(ctx.cwd, DISPATCH_DIR, 'tasks'))) {
        ctx.log('already initialized (.dispatch exists)');
        return;
      }
      TaskStore.init(ctx.cwd);
      ctx.log(`Initialized ${DISPATCH_DIR}/ — create your first task with: dispatch task create "<title>"`);
    });

  registerTaskCommands(program, ctx);

  return program;
}
