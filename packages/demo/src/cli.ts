#!/usr/bin/env bun
import { runPreflight } from './preflight.js';
import { resetDemo } from './reset.js';
import { addTask, claim, conflict } from './teammate.js';

function usage(): void {
  console.error(
    [
      'usage: demo <command>',
      '',
      '  reset [--no-push]                  rebuild the demo repo, board, and runs from scratch',
      '                                     (--no-push: build offline, cloning the teammate from the local repo)',
      '  preflight                          check the demo will actually work',
      '  teammate claim <taskId>            claim a task as the teammate',
      '  teammate add-task                  file a new task as the teammate',
      '  teammate conflict <taskId>         move a task to in-progress as the teammate',
    ].join('\n')
  );
}

function teammateCommand(
  sub: string | undefined,
  arg: string | undefined
): void {
  switch (sub) {
    case 'claim':
      if (arg === undefined) {
        usage();
        process.exitCode = 1;
        return;
      }
      claim(arg);
      return;
    case 'add-task':
      addTask();
      return;
    case 'conflict':
      if (arg === undefined) {
        usage();
        process.exitCode = 1;
        return;
      }
      conflict(arg);
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

function main(): void {
  const [, , cmd, sub, arg] = process.argv;
  switch (cmd) {
    case 'reset':
      if (sub !== undefined && sub !== '--no-push') {
        usage();
        process.exitCode = 1;
        return;
      }
      resetDemo({ push: sub !== '--no-push' });
      return;
    case 'preflight':
      runPreflight();
      return;
    case 'teammate':
      teammateCommand(sub, arg);
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
