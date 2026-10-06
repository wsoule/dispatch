import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import type { CliContext } from '../context.js';
import { CliError } from '../context.js';

/** A secret code, read so it never sits in argv or shell history (M2): piped
 *  stdin when there is one, else a prompt on stderr that does not echo. */
export async function readSecret(
  ctx: CliContext,
  prompt: string
): Promise<string> {
  const raw = await (ctx.readSecret ?? defaultReadSecret)(prompt);
  const code = raw.trim();
  if (code === '') throw new CliError('no code was given');
  return code;
}

async function defaultReadSecret(prompt: string): Promise<string> {
  if (process.stdin.isTTY !== true)
    return await new Response(Bun.stdin.stream()).text();
  process.stderr.write(prompt);
  // Typed characters are swallowed; only the prompt shows.
  const muted = new Writable({ write: (_chunk, _enc, done) => done() });
  const rl = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
  });
  try {
    return await new Promise<string>((resolve) => rl.question('', resolve));
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}
