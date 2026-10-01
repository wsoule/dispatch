import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { REPO } from './paths';

/** A scripted A2A peer on loopback (packages/server/test/fixtures/a2aFixturePeer.ts). */
export interface FixturePeerProcess {
  /** Its origin; the card is at `${url}/.well-known/agent-card.json`. */
  url: string;
  cardUrl: string;
  /** The bearer it accepts. */
  token: string;
  /** The asks it has received, newest last. */
  opened: () => Promise<{ body: string }[]>;
  /** Answers the latest ask with `body`. */
  answer: (body: string) => Promise<void>;
  cardFetches: () => Promise<number>;
  stop: () => Promise<void>;
}

const BOOT_TIMEOUT_MS = 15_000;

// Runs the peer under Bun, since FixturePeer serves with Bun.serve, and reads
// the one line it prints once it listens.
export async function startFixturePeer(): Promise<FixturePeerProcess> {
  const child = spawn(
    'bun',
    [join(REPO, 'packages/server/test/fixtures/a2aFixturePeer.ts')],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const ready = await new Promise<{ url: string; control: string }>(
    (resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`the A2A fixture peer never started:\n${output}`)),
        BOOT_TIMEOUT_MS
      );
      let line = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        line += chunk.toString();
        const cut = line.indexOf('\n');
        if (cut === -1) return;
        clearTimeout(timer);
        resolve(
          JSON.parse(line.slice(0, cut)) as { url: string; control: string }
        );
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the A2A fixture peer exited (${code}):\n${output}`));
      });
    }
  );
  const control = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${ready.control}${path}`, init);
    if (!res.ok) throw new Error(`fixture peer ${path}: ${res.status}`);
    return res;
  };
  return {
    url: ready.url,
    cardUrl: `${ready.url}/.well-known/agent-card.json`,
    token: 'peer-token',
    opened: async () =>
      (
        (await (await control('/opened')).json()) as {
          opened: { body: string }[];
        }
      ).opened,
    answer: async (body) => {
      await control('/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
    },
    cardFetches: async () =>
      ((await (await control('/stats')).json()) as { cardFetches: number })
        .cardFetches,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    },
  };
}
