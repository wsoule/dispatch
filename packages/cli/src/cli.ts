#!/usr/bin/env node
import { exemptLoopbackFromProxy } from '@dispatch-foo/core';

import { makeProgram } from './program.js';
import { reportCliError } from './reportError.js';

// Every call to dispatchd carries a bearer token to http://127.0.0.1, and a
// proxy in the shell's environment (HTTP_PROXY, ALL_PROXY) would otherwise
// receive it: before any fetch, the loopback addresses join NO_PROXY. This
// covers `dispatch mcp` too, which runs the MCP server in this process.
exemptLoopbackFromProxy();

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
