import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { APP_TOKEN, DAEMON_PORT } from './paths';

const DAEMON = `http://localhost:${DAEMON_PORT}`;
// Deciding a memory gate is decide tier, so the daemon is driven with the app token.
const APP = { authorization: `Bearer ${APP_TOKEN}` };
const TITLE = 'e2e hazard';

// Duplicated from views.spec.ts, following the convention edit-diff.spec.ts documents.
function requireToken(): string {
  const token = process.env.DISPATCH_E2E_TOKEN;
  if (!token) {
    throw new Error(
      'DISPATCH_E2E_TOKEN is unset: global-setup.ts should have resolved it.'
    );
  }
  return token;
}

function authedUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not configured');
  return `${baseURL}&token=${requireToken()}&appToken=${APP_TOKEN}`;
}

async function getJson<T>(
  request: APIRequestContext,
  path: string
): Promise<T> {
  const res = await request.get(`${DAEMON}${path}`, { headers: APP });
  if (!res.ok()) {
    throw new Error(`GET ${path} failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function runState(
  request: APIRequestContext,
  runId: string
): Promise<string> {
  return (
    await getJson<{ meta: { state: string } }>(request, `/api/runs/${runId}`)
  ).meta.state;
}

async function dispatch(
  request: APIRequestContext,
  taskId: string,
  executor: string
): Promise<string> {
  const res = await request.post(`${DAEMON}/api/tasks/${taskId}/runs`, {
    headers: APP,
    data: { executor },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

// Active team entries with the e2e title, by id.
async function e2eEntries(
  request: APIRequestContext
): Promise<{ id: string; handle: string }[]> {
  const { entries } = await getJson<{
    entries: { id: string; handle: string; title: string }[];
  }>(request, '/api/memory?scope=team');
  return entries.filter((e) => e.title === TITLE);
}

// What the test changed, so afterEach can put it back.
const created: {
  runIds: string[];
  tasks: { id: string; status: string }[];
} = { runIds: [], tasks: [] };

test.describe('memory end to end', () => {
  test.afterEach(async ({ request }) => {
    // Rejects a gate a failure left open, deletes the entry an approval made,
    // and undoes the runs like messaging.spec.ts, so the fixture holds.
    const { items } = await getJson<{
      items: { id: string; data?: { type?: string; proposalId?: string } }[];
    }>(request, '/api/decisions/open');
    const ours = new Set(created.runIds.map((id) => `run:${id}`));
    for (const gate of items) {
      const proposalId = gate.data?.proposalId;
      if (gate.data?.type !== 'memory' || proposalId === undefined) continue;
      const { proposal } = await getJson<{ proposal: { author: string } }>(
        request,
        `/api/memory/proposals/${proposalId}`
      );
      if (!ours.has(proposal.author)) continue;
      await request.post(`${DAEMON}/api/messages/${gate.id}/reply`, {
        headers: APP,
        data: {
          body: 'Closed: the e2e attempt ended first.',
          choice: 'reject',
        },
      });
    }
    for (const entry of await e2eEntries(request)) {
      await request.delete(`${DAEMON}/api/memory/${entry.id}`, {
        headers: APP,
      });
    }
    for (const runId of created.runIds) {
      await request.post(`${DAEMON}/api/runs/${runId}/cancel`, {
        headers: APP,
      });
      await request.post(`${DAEMON}/api/runs/${runId}/review`, {
        headers: APP,
        data: { action: 'discard' },
      });
      await request.post(`${DAEMON}/api/runs/${runId}/archive`, {
        headers: APP,
        data: { archived: true },
      });
    }
    for (const task of created.tasks) {
      await request.patch(`${DAEMON}/api/tasks/${task.id}`, {
        headers: APP,
        data: { status: task.status },
      });
    }
    created.runIds = [];
    created.tasks = [];
  });

  test('a run proposes a team hazard, the human approves it in Needs you, and the next run is shown it', async ({
    page,
    baseURL,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');

    expect(
      await e2eEntries(request),
      'the fixture already holds an e2e hazard from an earlier attempt'
    ).toEqual([]);
    // The fixture's one unblocked ready task; its stacked siblings cannot cut a
    // worktree, so the second run is dispatched on this task again.
    const task = (
      await getJson<{ meta: { id: string; status: string } }[]>(
        request,
        '/api/tasks/ready'
      )
    )[0]?.meta;
    if (task === undefined) {
      throw new Error('the storefront fixture has no ready task');
    }
    created.tasks.push({ id: task.id, status: task.status });

    // fake-remember posts the hazard to /api/memory with its run token, then finishes.
    const proposer = await dispatch(request, task.id, 'fake-remember');
    created.runIds.push(proposer);
    await expect
      .poll(() => runState(request, proposer), { timeout: 15_000 })
      .toBe('finished');

    await page.goto(authedUrl(baseURL));
    const rail = page.locator('#dispatch-sidebar');
    await rail.getByRole('button', { name: /^Threads/ }).click();
    // Scoped to this run: a gate an earlier failed attempt left open stays in Needs you.
    const gate = page
      .getByRole('group', { name: 'Needs you', exact: true })
      .getByRole('option')
      .filter({ hasText: 'proposes a team memory (hazard)' })
      .filter({ hasText: proposer });
    await gate.click();
    const card = page.locator('[data-slot="memory-gate-card"]');
    await expect(card.getByText(TITLE, { exact: true })).toBeVisible();
    await card.getByRole('radio', { name: 'Approve' }).click();
    await expect(gate).toHaveCount(0);

    const [entry] = await e2eEntries(request);
    expect(entry, 'approving saved no team entry').toBeDefined();

    // The next run's prompt carries the approved hazard in its memory index.
    const reader = await dispatch(request, task.id, 'fake');
    created.runIds.push(reader);
    const index = await getJson<{ included: string[] }>(
      request,
      `/api/memory/index?runId=${reader}`
    );
    expect(index.included).toContain(entry.handle);
  });
});
