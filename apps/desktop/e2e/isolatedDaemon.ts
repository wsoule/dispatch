import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { APP_TOKEN, HOME, REPO, ROOT, VITE_PORT } from './paths';

/** A daemon of the spec's own, on a copy of the storefront fixture. */
export interface IsolatedDaemon {
  root: string;
  home: string;
  port: number;
  /** The daemon's http origin, e.g. `http://localhost:58123`. */
  origin: string;
  /** The shared agentToken its daemon file names. */
  agentToken: string;
  /** The app under test pointed at this daemon, signed in as the owner. */
  appUrl: string;
  stop: () => Promise<void>;
}

const BOOT_TIMEOUT_MS = 20_000;
const POLL_MS = 200;

// Daemon files, run transcripts, actor and project state are all keyed by
// this hash of the project root (packages/server/src/daemonfile.ts).
function rootKey(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

// A port nothing is listening on right now.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('no port for the isolated daemon'));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

// Moves every entry named for the fixture's key (runs/<key>, actor/<key>.json,
// …) to the copy's key, and drops the old daemon file so only the copy's own
// daemon writes one.
function rekeyHome(home: string, from: string, to: string): void {
  const dispatch = join(home, '.dispatch');
  rmSync(join(dispatch, 'daemons'), { recursive: true, force: true });
  for (const area of readdirSync(dispatch)) {
    const dir = join(dispatch, area);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (name === from || name === `${from}.json`) {
        renameSync(join(dir, name), join(dir, name.replace(from, to)));
      }
    }
  }
}

// The fixture's databases are copied while the shared daemon has them open;
// without their shared-memory index SQLite rebuilds it from the WAL on open.
function dropSharedMemoryFiles(dir: string): void {
  for (const entry of readdirSync(dir, { recursive: true })) {
    const path = join(dir, String(entry));
    if (path.endsWith('.db-shm')) rmSync(path, { force: true });
  }
}

// Waits for the daemon's own daemon file, which it writes once it serves.
async function waitForAgentToken(
  child: ChildProcess,
  daemonFile: string,
  logs: () => string
): Promise<string> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`isolated daemon exited early:\n${logs()}`);
    }
    if (existsSync(daemonFile)) {
      const info = JSON.parse(readFileSync(daemonFile, 'utf8')) as {
        agentToken?: string;
      };
      if (info.agentToken) return info.agentToken;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`isolated daemon never wrote ${daemonFile}:\n${logs()}`);
}

/**
 * Copies the storefront fixture (root and home) and boots a daemon on the copy,
 * so a spec that dispatches runs, sends messages or writes docs leaves the
 * shared fixture the screenshot suite pins exactly as it found it. The copy is
 * deleted on `stop`.
 */
export async function startIsolatedDaemon(
  name: string
): Promise<IsolatedDaemon> {
  const scratch = join(REPO, '.agents', 'ignore', 'e2e-isolated');
  mkdirSync(scratch, { recursive: true });
  // Real paths throughout: the MCP server keys its files by realpath(root).
  const base = realpathSync(mkdtempSync(join(scratch, `${name}-`)));
  const root = join(base, 'storefront');
  const home = join(base, 'home');
  cpSync(ROOT, root, { recursive: true });
  cpSync(HOME, home, { recursive: true });
  rekeyHome(home, rootKey(ROOT), rootKey(root));
  dropSharedMemoryFiles(root);
  dropSharedMemoryFiles(home);

  const port = await freePort();
  let output = '';
  const child = spawn(
    'bun',
    [
      join(REPO, 'packages/server/src/bin.ts'),
      '--root',
      root,
      '--port',
      String(port),
    ],
    {
      env: {
        ...process.env,
        DISPATCH_HOME: home,
        DISPATCH_ENABLE_FAKES: '1',
        DISPATCH_APP_TOKEN: APP_TOKEN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(base, { recursive: true, force: true });
  };

  try {
    const agentToken = await waitForAgentToken(
      child,
      join(home, '.dispatch', 'daemons', `${rootKey(root)}.json`),
      () => output
    );
    const query = new URLSearchParams({
      root,
      port: String(port),
      token: agentToken,
      appToken: APP_TOKEN,
    });
    return {
      root,
      home,
      port,
      origin: `http://localhost:${port}`,
      agentToken,
      appUrl: `http://localhost:${VITE_PORT}/?${query.toString()}`,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
