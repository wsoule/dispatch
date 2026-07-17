#!/usr/bin/env node
import { TaskParseError, ConfigError } from '@dispatch/core';
import { makeProgram } from './program.js';
import { CliError } from './context.js';

const program = makeProgram({ cwd: process.cwd(), log: line => console.log(line) });

try {
  await program.parseAsync(process.argv.slice(2), { from: 'user' });
} catch (err) {
  if (typeof err !== 'object' || err === null) {
    // Not an Error-shaped throw (string, number, ...) — nothing sensible to render.
    throw err;
  } else if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
    process.exitCode = err.exitCode;
  } else if (err instanceof TaskParseError) {
    console.error(`error: ${err.message} — run 'dispatch doctor'`);
    process.exitCode = 1;
  } else if (err instanceof ConfigError) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  } else if ((err as { code?: string }).code?.startsWith('commander.')) {
    // commander already printed help/version; exitOverride throws instead of exiting
    process.exitCode = (err as { exitCode?: number }).exitCode ?? 1;
  } else {
    throw err;
  }
}
