import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../../src/index.js';
import { startServer } from '../../../src/index.js';
import { runGitSync, StallingExecutor } from '../../orchestrator/helpers.js';
import { useTestAuth } from '../../testAuth.js';

const dirs: string[] = [];
const handles: ServerHandle[] = [];
const originalHome = process.env.DISPATCH_HOME;

afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

describe('run ids on a synced board', () => {
  it('mints 12-hex run ids', async () => {
    process.env.DISPATCH_HOME = temp('dispatch-home-');
    const remote = temp('dispatch-remote-');
    runGitSync(remote, ['init', '-q', '--bare', '-b', 'main']);
    const root = temp('dispatch-root-');
    runGitSync(root, ['init', '-q', '-b', 'main']);
    runGitSync(root, ['config', 'user.email', 'ada@example.com']);
    runGitSync(root, ['config', 'user.name', 'ada']);
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      `sync:\n  enabled: true\n  repo: ${remote}\n  intervalSec: 3600\n`
    );
    runGitSync(root, ['add', '-A']);
    runGitSync(root, ['commit', '-q', '-m', 'init']);
    const executor = new StallingExecutor();
    const handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      storeBackend: 'sqlite',
      writeDaemonFile: false,
      registerExecutors: (o) => o.registerExecutor('claude', executor),
    });
    handles.push(handle);
    useTestAuth(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    const task = (await (
      await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'twelve' }),
      })
    ).json()) as { meta: { id: string } };
    const run = (await (
      await fetch(`${base}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'claude' }),
      })
    ).json()) as { id: string };
    expect(run.id).toMatch(/^r-[0-9a-f]{12}$/);
  });
});
