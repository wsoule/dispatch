import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';
import { waitFor } from '../messaging/harness.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';
import { approvedClient, useSeedBase } from './seed.js';

const PR_URL = 'https://github.com/example/repo/pull/7';

// Answers only what the PR poll needs to list PR 7 as open.
function gh(_cwd: string, cmd: string[]): Promise<CommandResult> {
  const argv = cmd.join(' ');
  const ok = (stdout: string) =>
    Promise.resolve({ ok: true, stdout, stderr: '' });
  if (argv === 'gh --version') return ok('gh version 2.0.0');
  if (argv === 'git remote get-url origin')
    return ok('https://github.com/example/repo.git');
  if (argv.startsWith('gh pr list')) {
    return ok(
      JSON.stringify([
        {
          number: 7,
          url: PR_URL,
          title: 'Rate-limit uploads',
          headRefName: 'dispatch/rate-limit-uploads',
          author: { login: 'wyat' },
          isDraft: false,
          updatedAt: '2026-09-28T00:00:00Z',
        },
      ])
    );
  }
  return Promise.resolve({ ok: false, stdout: '', stderr: 'not stubbed' });
}

let home: string;
let root: string;
let handle: ServerHandle;
const originalHome = process.env.DISPATCH_HOME;

// A daemon whose fake run commits one file, then waits for a message.
beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-work-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-work-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
    prCommandRunner: gh,
    registerExecutors: (o) =>
      o.registerExecutor(
        'fake',
        new FakeExecutor({
          session: 's-work',
          steps: [
            {
              write: (cwd) =>
                writeFileSync(
                  join(cwd, 'limits.ts'),
                  'export const LIMIT = 10;\n'
                ),
              commitMessage: 'Add upload limits',
            },
            { awaitMessage: true },
          ],
          finish: { state: 'finished' },
        })
      ),
  });
  useTestAuth(handle);
  useSeedBase(`http://127.0.0.1:${handle.port}`);
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// The daemon's own reads: the transcript's evidence, the worktree's diff, the PR poll.
it('publishes a real run’s diff, evidence and open PR through the daemon', async () => {
  const port = handle.a2a.port!;
  const { caller } = await approvedClient('acme');
  const opened = await port.open(caller, {
    clientMessageId: 'c-h1',
    contextId: null,
    kind: 'handoff',
    to: null,
    replyTo: null,
    body: 'Please add limits.',
    refs: [],
    work: { skill: 'handoff', title: 'Rate-limit uploads' },
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  const row = handle.a2a.store!.getTask(opened.taskId)!;
  await handle.messaging.engine.reply(
    row.gate!,
    { body: '', choice: 'approve' },
    { address: port.deps.ownerRef, canDecide: true }
  );
  const run = await handle.orchestrator.dispatch(row.dispatchTask!, 'fake');
  await waitFor(
    () => handle.orchestrator.diff(run.id).files.length > 0,
    10_000
  );
  handle.orchestrator.recordEvidence(run.id, {
    command: 'bun test',
    exitCode: 0,
    durationMs: 900,
    summary: '12 pass',
  });
  handle.orchestrator.sendMessage(run.id, 'Wrap up.');
  await waitFor(
    () =>
      handle.orchestrator.list().find((r) => r.id === run.id)?.state ===
      'finished',
    10_000
  );
  handle.orchestrator.setRunPrUrl(run.id, PR_URL);
  await handle.prManager.pollOnce();

  const facts = (await port.facts(caller, opened.taskId))!;
  expect(facts.work.pr).toEqual({
    kind: 'pr',
    url: PR_URL,
    number: 7,
    state: 'open',
  });
  expect(facts.work.diffstat).toMatchObject({
    files: 1,
    insertions: 1,
    deletions: 0,
    perFile: [{ path: 'limits.ts' }],
  });
  expect(facts.work.evidence).toMatchObject({
    items: [{ command: 'bun test', summary: '12 pass' }],
  });
});
