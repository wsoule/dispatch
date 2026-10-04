import { afterEach, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { initGitRepo } from './orchestrator/helpers.js';

// A preset DISPATCH_APP_TOKEN must not reach a git hook the daemon's own git
// runs (an agent could plant one): Bun gives a spawn with no `env` the
// process's startup environment, so this runs a real daemon process.

const BIN = resolve(import.meta.dirname, '../src/bin.ts');
const TOKEN = 'preset-decide-tier-token';
let child: Bun.Subprocess<'ignore', 'pipe', 'inherit'> | undefined;
const dirs: string[] = [];

afterEach(async () => {
  child?.kill('SIGKILL');
  await child?.exited;
  child = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('a daemon started with a preset app token runs git hooks without it', async () => {
  const root = realpathSync(initGitRepo('token-hooks-'));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'token-hooks-home-')));
  const record = join(home, 'hook-token-lengths');
  dirs.push(root, home);
  for (const hook of [
    'post-commit',
    'reference-transaction',
    'post-checkout',
  ]) {
    const path = join(root, '.git', 'hooks', hook);
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(
      path,
      `#!/bin/sh\necho "${hook} \${#DISPATCH_APP_TOKEN}" >> '${record}'\ncat >/dev/null 2>&1 || true\n`
    );
    chmodSync(path, 0o755);
  }
  child = Bun.spawn(['bun', BIN, '--root', root, '--port', '0'], {
    env: {
      ...process.env,
      DISPATCH_HOME: home,
      DISPATCH_APP_TOKEN: TOKEN,
      DISPATCH_ENABLE_FAKES: '1',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = child.stdout.getReader();
  let out = '';
  let port: number | null = null;
  const deadline = Date.now() + 30_000;
  while (port === null && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    if (m !== null) port = Number(m[1]);
  }
  reader.releaseLock();
  if (port === null) throw new Error(`daemon never listened:\n${out}`);
  const api = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<Record<string, unknown>>);
  const task = (await api('/api/tasks', { title: 'Hooked' })) as {
    meta: { id: string };
  };
  const run = (await api(`/api/tasks/${task.meta.id}/runs`, {
    executor: 'fake',
  })) as { id: string };
  for (let i = 0; i < 200; i++) {
    const meta = (
      (await (
        await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).json()) as { meta: { state: string } }
    ).meta;
    if (meta.state !== 'running' && meta.state !== 'starting') break;
    await Bun.sleep(100);
  }
  expect(existsSync(record)).toBe(true);
  const lines = readFileSync(record, 'utf8').trim().split('\n');
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((l) => !l.endsWith(' 0'))).toEqual([]);
}, 60_000);
