import { TaskParseError } from '@dispatch/core';

import { CliError } from './context.js';

// Prints a failed command as one `error:` line (the stack follows only when
// `debug` is set) and answers the exit code. Commander has printed its own.
export function reportCliError(
  err: unknown,
  write: (line: string) => void,
  debug: boolean
): number {
  if (typeof err !== 'object' || err === null) {
    write(`error: ${String(err)}`);
    return 1;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('commander.')) {
    return (err as { exitCode?: number }).exitCode ?? 1;
  }
  const message = err instanceof Error ? err.message : String(err);
  const first = message.split('\n')[0];
  if (err instanceof TaskParseError) {
    write(`error: ${first} — run 'dispatch doctor'`);
    return 1;
  }
  write(`error: ${first}`);
  if (debug && err instanceof Error && err.stack !== undefined)
    write(err.stack);
  return err instanceof CliError ? err.exitCode : 1;
}
