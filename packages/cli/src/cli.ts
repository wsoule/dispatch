#!/usr/bin/env node
import { makeProgram } from './program.js';
import { CliError } from './context.js';

const program = makeProgram({ cwd: process.cwd(), log: line => console.log(line) });

try {
  await program.parseAsync(process.argv.slice(2), { from: 'user' });
} catch (err) {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
    process.exitCode = err.exitCode;
  } else if ((err as { code?: string }).code?.startsWith('commander.')) {
    // commander already printed help/version; exitOverride throws instead of exiting
    process.exitCode = (err as { exitCode?: number }).exitCode ?? 1;
  } else {
    throw err;
  }
}
