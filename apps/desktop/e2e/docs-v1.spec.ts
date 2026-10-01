import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import type { StdioMcp } from './mcp';
import { startAgentMcp } from './mcp';
import { APP_TOKEN } from './paths';

// Docs v1, end to end: an agent's edit to an accepted spec waits as a doc gate
// the human approves from its card, and Publish to repo from the doc page
// creates the elevated publish task. Each runs on its own fixture copy.

const APP = { authorization: `Bearer ${APP_TOKEN}` };

let daemon: IsolatedDaemon | null = null;
let mcp: StdioMcp | null = null;

function requireDaemon(): IsolatedDaemon {
  if (daemon === null) throw new Error('the isolated daemon is not running');
  return daemon;
}

async function api<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  data?: unknown
): Promise<T> {
  const res = await request.fetch(`${requireDaemon().origin}/api${path}`, {
    method,
    headers: APP,
    data,
  });
  expect(
    res.ok(),
    `${method} ${path}: ${res.status()} ${await res.text()}`
  ).toBe(true);
  return (await res.json()) as T;
}

test.afterEach(async () => {
  mcp?.close();
  mcp = null;
  await daemon?.stop();
  daemon = null;
});

test("v1 exit: an agent's edit to an accepted spec waits as a gate the human approves", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
  test.setTimeout(90_000);
  daemon = await startIsolatedDaemon('docs-v1-gate');
  await api(request, 'POST', '/docs', {
    title: 'Gate spec',
    body: '# Gate spec\n## API\nv1\n',
  });
  await api(request, 'POST', '/docs/gate-spec/status', { status: 'accepted' });

  const name = 'docs-v1-e2e';
  mcp = await startAgentMcp(daemon.root, daemon.home, name);
  expect(await mcp.tool('doc_list', {})).toContain('awaiting approval');
  const { agents } = await api<{
    agents: { address: string; status: string }[];
  }>(request, 'GET', '/agents/roster');
  const pending = agents.find(
    (a) => a.address.endsWith(`/${name}`) && a.status === 'pending'
  );
  if (pending === undefined) throw new Error(`${name} never registered`);
  await api(
    request,
    'POST',
    `/agents/${encodeURIComponent(pending.address)}/approve`,
    {}
  );
  // At the default rung the edit becomes a proposal behind a doc gate.
  const proposed = await mcp.tool('doc_save', {
    doc: 'gate-spec',
    ops: [{ op: 'replace_section', section: 'API', text: 'v2 from the agent' }],
  });
  expect(proposed).toMatch(/proposal|proposed/i);

  await page.goto(daemon.appUrl);
  await page
    .locator('#dispatch-sidebar')
    .getByRole('button', { name: /^Threads/ })
    .click();
  await page
    .getByRole('group', { name: 'Needs you', exact: true })
    .getByRole('option', { name: /proposes an edit to an accepted doc/ })
    .first()
    .click();
  await expect(
    page.getByText('Apply this edit to an accepted doc?')
  ).toBeVisible();
  await expect(page.getByText('merges cleanly')).toBeVisible();
  await page.getByRole('radio', { name: 'Approve' }).click();

  await expect
    .poll(
      async () =>
        (await api<{ text: string }>(request, 'GET', '/docs/gate-spec')).text,
      { timeout: 15_000 }
    )
    .toBe('# Gate spec\n## API\nv2 from the agent\n');
  const read = await api<{ rev: { cause: string } }>(
    request,
    'GET',
    '/docs/gate-spec'
  );
  expect(read.rev.cause).toBe('approve');
});

test('Publish to repo from the doc page creates the elevated publish task', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
  test.setTimeout(60_000);
  daemon = await startIsolatedDaemon('docs-v1-publish');
  await api(request, 'POST', '/docs', {
    title: 'Publish spec',
    body: '# Publish spec\nready\n',
  });
  // The task is the point here; no run is started for it.
  await page.route('**/api/docs/*/publish', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<
      string,
      unknown
    >;
    await route.continue({
      postData: JSON.stringify({ ...body, dispatch: false }),
    });
  });

  await page.goto(daemon.appUrl);
  await page.locator('#dispatch-sidebar [data-nav-item="docs"]').click();
  await page.getByRole('button', { name: 'Publish spec', exact: true }).click();
  await page.getByRole('button', { name: 'Publish to repo' }).click();
  await page.getByLabel('Path in the repo').fill('docs/publish-spec.md');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(
    page.getByText(/Publishing to docs\/publish-spec\.md: task/)
  ).toBeVisible();

  const tasks = await api<
    { meta: { title: string; risk: string; writes: string[] } }[]
  >(request, 'GET', '/tasks');
  const task = tasks.find(
    (t) =>
      t.meta.title ===
      'Publish doc publish-spec (rev 1) to docs/publish-spec.md'
  );
  expect(task?.meta.risk).toBe('elevated');
  expect(task?.meta.writes).toEqual(['docs/publish-spec.md']);
});
