#!/usr/bin/env node
import { makeProgram } from './program.js';
import { reportCliError } from './reportError.js';

const program = makeProgram({
  cwd: process.cwd(),
  log: (line) => console.log(line),
});

try {
  await program.parseAsync(process.argv.slice(2), { from: 'user' });
} catch (err) {
  // One line per failure; DEBUG=1 adds the stack.
  process.exitCode = reportCliError(
    err,
    (line) => console.error(line),
    (process.env.DEBUG ?? '') !== ''
  );
}
