import { openSqliteDb, updateConfig } from '@dispatch/core';
import { openMessagesDb, SqliteMessageStore } from '@dispatch/protocol';
import { afterAll, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { runsDir } from '../../src/orchestrator/paths.js';
import { initGitRepo, StallingExecutor } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';

const originalHome = process.env.DISPATCH_HOME;
const home = realpathSync(mkdtempSync(join(tmpdir(), 'docs-gate-boot-home-')));
process.env.DISPATCH_HOME = home;
const root = realpathSync(initGitRepo('docs-gate-boot-'));
const executor = new StallingExecutor();

afterAll(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function boot(): Promise<{ handle: ServerHandle; api: string }> {
  const handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    registerExecutors: (o) => o.registerExecutor('claude', executor),
  });
  useTestAuth(handle);
  return { handle, api: `http://127.0.0.1:${handle.port}/api` };
}

function stampDocsDb(version: number): void {
  const db = openSqliteDb(join(runsDir(root), 'docs.db'));
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
}

const post = (api: string, path: string, body: unknown) =>
  fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

it('review focus 3: with the store unavailable the handler throws and recover() applies the answer once docs.db opens', async () => {
  let { handle, api } = await boot();
  await post(api, '/docs', { title: 'Spec', body: 'v1\n' });
  await post(api, '/docs/spec/status', { status: 'accepted' });
  const task = (await (
    await post(api, '/tasks', { title: 'Proposer' })
  ).json()) as { meta: { id: string } };
  const run = (await (
    await post(api, `/tasks/${task.meta.id}/runs`, { executor: 'claude' })
  ).json()) as { id: string };
  for (let i = 0; i < 200; i++) {
    const r = (await (await fetch(`${api}/runs/${run.id}`)).json()) as {
      meta: { state: string };
    };
    if (r.meta.state === 'running') break;
    await new Promise((res) => setTimeout(res, 20));
  }
  const proposed = (await (
    await rawFetch(`${api}/docs/spec/edit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${executor.lastRunToken ?? ''}`,
      },
      body: JSON.stringify({ ops: [{ op: 'append', text: 'v2' }] }),
    })
  ).json()) as { status: string; gate: string };
  expect(proposed.status).toBe('proposed');
  await handle.stop();

  stampDocsDb(2);
  ({ handle, api } = await boot());
  expect((await fetch(`${api}/docs`)).status).toBe(503);
  expect(
    (
      await post(api, `/messages/${proposed.gate}/reply`, {
        body: '',
        choice: 'approve',
      })
    ).ok
  ).toBe(true);
  await handle.stop();

  const messages = openMessagesDb(join(runsDir(root), 'messages.db'));
  expect(
    new SqliteMessageStore(messages)
      .unappliedAnsweredGates()
      .map((g) => g.question.id)
  ).toEqual([proposed.gate]);
  messages.close();

  stampDocsDb(1);
  ({ handle, api } = await boot());
  const revisions = (await (
    await fetch(`${api}/docs/spec/revisions`)
  ).json()) as { revisions: { cause: string }[] };
  expect(revisions.revisions.filter((r) => r.cause === 'approve')).toHaveLength(
    1
  );
  expect(
    ((await (await fetch(`${api}/docs/spec`)).json()) as { text: string }).text
  ).toBe('v1\nv2\n');
  await handle.stop();
});

// Stage v1's exit (spec:2152-2155), with the policy in the real config.yml.
it('v1 exit: an agent edit to an accepted spec waits in Needs you at rung 3 and applies itself at rung 4', async () => {
  const { handle, api } = await boot();
  await post(api, '/docs', { title: 'Exit spec', body: 'v1\n' });
  await post(api, '/docs/exit-spec/status', { status: 'accepted' });
  const task = (await (
    await post(api, '/tasks', { title: 'Routine proposer' })
  ).json()) as { meta: { id: string } };
  const run = (await (
    await post(api, `/tasks/${task.meta.id}/runs`, { executor: 'claude' })
  ).json()) as { id: string };
  for (let i = 0; i < 200; i++) {
    const r = (await (await fetch(`${api}/runs/${run.id}`)).json()) as {
      meta: { state: string };
    };
    if (r.meta.state === 'running') break;
    await new Promise((res) => setTimeout(res, 20));
  }
  const edit = async (text: string) =>
    (await (
      await rawFetch(`${api}/docs/exit-spec/edit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${executor.lastRunToken ?? ''}`,
        },
        body: JSON.stringify({ ops: [{ op: 'append', text }] }),
      })
    ).json()) as { status: string; gate?: string };

  updateConfig(root, { policy: { rung: 3 } });
  const waiting = await edit('at rung 3');
  expect(waiting.status).toBe('proposed');
  const items = (
    (await (await fetch(`${api}/decisions`)).json()) as {
      items: { kind: string; runId?: string }[];
    }
  ).items;
  expect(items.some((i) => i.kind === 'doc' && i.runId === run.id)).toBe(true);
  expect(
    ((await (await fetch(`${api}/docs/exit-spec`)).json()) as { text: string })
      .text
  ).toBe('v1\n');

  // The open proposal is withdrawn by a reopen and re-accept, so rung 4 sees a fresh write.
  await post(api, '/docs/exit-spec/status', { status: 'draft' });
  await post(api, '/docs/exit-spec/status', { status: 'accepted' });
  updateConfig(root, { policy: { rung: 4 } });
  const applied = await edit('at rung 4');
  expect(applied.status).toBe('saved');
  expect(
    ((await (await fetch(`${api}/docs/exit-spec`)).json()) as { text: string })
      .text
  ).toBe('v1\nat rung 4\n');
  await handle.stop();
});
