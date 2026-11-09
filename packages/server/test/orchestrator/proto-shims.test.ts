import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { defaultCommandRunner } from '../../src/orchestrator/pr.js';
import {
  withProtoPath,
  withProtoShims,
} from '../../src/orchestrator/protoShims.js';

let scratch: string;
let worktree: string;
let protoHome: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dispatch-proto-shims-'));
  worktree = join(scratch, 'worktree');
  protoHome = join(scratch, "proto home's");
  mkdirSync(worktree);
  mkdirSync(join(protoHome, 'shims'), { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('withProtoShims', () => {
  it('leaves the command alone when the worktree has no .prototools', () => {
    const env = { PROTO_HOME: protoHome };
    expect(withProtoShims(worktree, 'pnpm install', env)).toBe('pnpm install');
  });

  it('leaves the command alone when proto is not installed', () => {
    writeFileSync(join(worktree, '.prototools'), 'pnpm = "11.9.0"\n');
    const env = { PROTO_HOME: join(scratch, 'missing') };
    expect(withProtoShims(worktree, 'pnpm install', env)).toBe('pnpm install');
  });

  // The regression itself: under `bash -lc`, macOS path_helper puts
  // /usr/local/bin (Homebrew pnpm 12) back in front of the daemon's PATH, so
  // the shims have to be prepended inside the shell, after the profile ran.
  it('runs the pinned tool from proto shims even under a login shell', async () => {
    writeFileSync(join(worktree, '.prototools'), 'pnpm = "11.9.0"\n');
    const fakePnpm = join(protoHome, 'shims', 'pnpm');
    writeFileSync(fakePnpm, '#!/bin/sh\necho proto-pnpm\n');
    chmodSync(fakePnpm, 0o755);

    const command = withProtoShims(worktree, 'pnpm', {
      PROTO_HOME: protoHome,
    });
    const result = await defaultCommandRunner(worktree, [
      'bash',
      '-lc',
      command,
    ]);

    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe('proto-pnpm');
  });
});

describe('withProtoPath', () => {
  const shims = () => join(protoHome, 'shims');
  const bin = () => join(protoHome, 'bin');

  it('hands the env back unchanged when the worktree has no .prototools', () => {
    const env = { PROTO_HOME: protoHome, PATH: '/usr/bin' };
    expect(withProtoPath(worktree, env)).toBe(env);
  });

  it('hands the env back unchanged when proto is not installed', () => {
    writeFileSync(join(worktree, '.prototools'), 'pnpm = "11.9.0"\n');
    const env = { PROTO_HOME: join(scratch, 'missing'), PATH: '/usr/bin' };
    expect(withProtoPath(worktree, env)).toBe(env);
  });

  it('puts the shims and proto bin first, keeping the rest of PATH', () => {
    writeFileSync(join(worktree, '.prototools'), 'pnpm = "11.9.0"\n');
    const env = { PROTO_HOME: protoHome, PATH: '/usr/bin:/bin', KEEP: '1' };
    const next = withProtoPath(worktree, env);
    expect(next.PATH).toBe(
      [shims(), bin(), '/usr/bin', '/bin'].join(delimiter)
    );
    expect(next.KEEP).toBe('1');
  });

  // A daemon that already had the shims somewhere on PATH still gets them
  // first, and only once.
  it('moves shims already on PATH to the front instead of repeating them', () => {
    writeFileSync(join(worktree, '.prototools'), 'pnpm = "11.9.0"\n');
    const env = {
      PROTO_HOME: protoHome,
      PATH: ['/usr/local/bin', shims(), '/usr/bin'].join(delimiter),
    };
    expect(withProtoPath(worktree, env).PATH).toBe(
      [shims(), bin(), '/usr/local/bin', '/usr/bin'].join(delimiter)
    );
  });

  // The regression itself: an agent's git hook runs `pnpm` from its inherited
  // PATH, which must reach the pinned shim ahead of a Homebrew or nvm pnpm.
  // `command -v` does the lookup an exec would without running the script:
  // macOS scans a freshly written executable on its first run, which can stall
  // a spawn past the test timeout.
  it('makes a spawned agent process resolve the pinned tool', async () => {
    writeFileSync(join(worktree, '.prototools'), 'pnpm = "11.9.0"\n');
    const shadow = join(scratch, 'homebrew');
    mkdirSync(shadow);
    for (const dir of [shims(), shadow]) {
      writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\n');
      chmodSync(join(dir, 'pnpm'), 0o755);
    }

    const env = withProtoPath(worktree, {
      PROTO_HOME: protoHome,
      PATH: `${shadow}${delimiter}${process.env.PATH ?? ''}`,
    });
    const child = Bun.spawn(['sh', '-c', 'command -v pnpm'], {
      cwd: worktree,
      env,
    });
    const out = await new Response(child.stdout).text();

    expect(await child.exited).toBe(0);
    expect(out.trim()).toBe(join(shims(), 'pnpm'));
  });
});
