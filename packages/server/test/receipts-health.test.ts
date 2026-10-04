import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';

// A receipt export that fails is a health problem, not only a log line.

let handle: ServerHandle | undefined;
const dirs: string[] = [];
const originalHome = process.env.DISPATCH_HOME;

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('lists a failed receipt export among the health problems', async () => {
  process.env.DISPATCH_HOME = temp('dispatch-home-');
  const root = temp('dispatch-receipts-project-');
  runGitSync(root, ['init', '-q', '-b', 'main']);
  // Someone else's directory: the exporter refuses it, so every pass fails.
  const foreign = temp('dispatch-receipts-foreign-');
  writeFileSync(join(foreign, 'notes.md'), 'mine\n');
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    `receipts:\n  enabled: true\n  dir: ${foreign}\n`
  );
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    storeBackend: 'sqlite',
    receiptsDebounceMs: 20,
  });
  let problems: string[] = [];
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
    problems = ((await res.json()) as { problems: string[] }).problems;
    if (problems.some((p) => p.includes('receipt'))) break;
    await Bun.sleep(50);
  }
  expect(problems).toContainEqual(
    expect.stringContaining('receipt log export failed')
  );
});
