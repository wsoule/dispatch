import { afterAll, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { docsReceiptsStep } from '../../src/docs/receipts.js';
import { startServer } from '../../src/index.js';
import { runsDir } from '../../src/orchestrator/paths.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';
import { makeService, OWNER } from './fakeHost.js';

const originalHome = process.env.DISPATCH_HOME;
const home = realpathSync(mkdtempSync(join(tmpdir(), 'docs-restore-home-')));
const log = realpathSync(mkdtempSync(join(tmpdir(), 'docs-restore-log-')));
afterAll(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(log, { recursive: true, force: true });
});

it('v1 exit: a receipt log restores team docs on a clean machine as unreviewed, provisional drafts', async () => {
  // Machine A: the real receipts step writes the log's .dispatch/docs/.
  const { service } = makeService();
  const owner = service.actorFor(OWNER);
  service.create(owner, { title: 'Auth spec', body: '# Auth\nv1\n' });
  service.setStatus(owner, 'auth-spec', 'accepted');
  service.create(owner, { title: 'Notes', body: 'n\n' });
  service.seal(owner, 'notes');
  expect(docsReceiptsStep(service, join(log, 'no-staging'))(log).changed).toBe(
    2
  );

  // Machine B: `dispatch receipts restore` stages into
  // $DISPATCH_HOME/.dispatch/runs/<sha256(root)[0:12]>/docs-restore.
  process.env.DISPATCH_HOME = home;
  const root = realpathSync(initGitRepo('docs-restore-'));
  const cliStaging = join(
    home,
    '.dispatch',
    'runs',
    createHash('sha256').update(root).digest('hex').slice(0, 12),
    'docs-restore'
  );
  expect(cliStaging).toBe(join(runsDir(root), 'docs-restore'));
  mkdirSync(cliStaging, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(join(log, '.dispatch', 'docs')))
    copyFileSync(join(log, '.dispatch', 'docs', f), join(cliStaging, f));

  const handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
  });
  useTestAuth(handle);
  const api = `http://127.0.0.1:${handle.port}/api`;
  try {
    const spec = (await (await fetch(`${api}/docs/auth-spec`)).json()) as {
      doc: Record<string, unknown>;
      rev: Record<string, unknown>;
      text: string;
    };
    expect(spec.doc).toMatchObject({
      status: 'draft',
      unreviewed: true,
      restored: { status: 'accepted' },
    });
    expect(spec.rev).toMatchObject({ cause: 'restore', provisional: true });
    expect(spec.text).toBe('# Auth\nv1\n');
    const list = (await (await fetch(`${api}/docs`)).json()) as {
      docs: { handle: string; unreviewed: boolean }[];
    };
    expect(list.docs.map((d) => [d.handle, d.unreviewed]).sort()).toEqual([
      ['auth-spec', true],
      ['notes', true],
    ]);
    expect(existsSync(cliStaging)).toBe(false);
    const health = (await (await fetch(`${api}/docs/health`)).json()) as {
      restore?: { restored: number };
    };
    expect(health.restore?.restored).toBe(2);
  } finally {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
