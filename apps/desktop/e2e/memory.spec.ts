import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import { APP_TOKEN } from './paths';
import { openDestination } from './shell';

// Deciding a memory gate is decide tier, so the daemon is driven with the app token.
const APP = { authorization: `Bearer ${APP_TOKEN}` };
const TITLE = 'e2e hazard';

// This spec's own daemon on a copy of the fixture: the runs it dispatches, the
// gate it decides and the team entry it saves stay in the copy, so they never
// reach the shared fixture views.spec.ts screenshots.
let daemon: IsolatedDaemon | null = null;

function requireDaemon(): IsolatedDaemon {
  if (daemon === null) throw new Error('the isolated daemon is not running');
  return daemon;
}

async function getJson<T>(
  request: APIRequestContext,
  path: string
): Promise<T> {
  const res = await request.get(`${requireDaemon().origin}${path}`, {
    headers: APP,
  });
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
  const res = await request.post(
    `${requireDaemon().origin}/api/tasks/${taskId}/runs`,
    {
      headers: APP,
      data: { executor },
    }
  );
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

test.describe('memory end to end', () => {
  // The copy goes with its daemon, so the runs, the gate and the entry need no
  // undoing.
  test.afterAll(async () => {
    await daemon?.stop();
    daemon = null;
  });

  test('a run proposes a team hazard, the human approves it in Needs you, and the next run is shown it', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
    daemon = await startIsolatedDaemon('memory');

    expect(
      await e2eEntries(request),
      'the fixture already holds an e2e hazard'
    ).toEqual([]);
    // The fixture's one unblocked ready task; its stacked siblings cannot cut a
    // worktree, so the second run is dispatched on this task again.
    const task = (
      await getJson<{ meta: { id: string } }[]>(request, '/api/tasks/ready')
    )[0]?.meta;
    if (task === undefined) {
      throw new Error('the storefront fixture has no ready task');
    }

    // fake-remember posts the hazard to /api/memory with its run token, then finishes.
    const proposer = await dispatch(request, task.id, 'fake-remember');
    await expect
      .poll(() => runState(request, proposer), { timeout: 15_000 })
      .toBe('finished');

    await page.goto(requireDaemon().appUrl);
    await openDestination(page, 'Threads');
    // Scoped to this run, among the fixture's own open gates.
    const gate = page
      .getByRole('group', { name: 'Needs you', exact: true })
      .getByRole('option')
      .filter({ hasText: 'proposes a team memory (hazard)' })
      .filter({ hasText: proposer });
    await gate.click();
    // Overseer keeps its own Needs you mounted; the opened gate is under Tasks.
    const card = page
      .getByTestId('tasks-view')
      .locator('[data-slot="memory-gate-card"]');
    await expect(card.getByText(TITLE, { exact: true })).toBeVisible();
    await card.getByRole('radio', { name: 'Approve' }).click();
    await expect(gate).toHaveCount(0);

    const [entry] = await e2eEntries(request);
    expect(entry, 'approving saved no team entry').toBeDefined();

    // The next run's prompt carries the approved hazard in its memory index.
    const reader = await dispatch(request, task.id, 'fake');
    const index = await getJson<{ included: string[] }>(
      request,
      `/api/memory/index?runId=${reader}`
    );
    expect(index.included).toContain(entry.handle);
  });
});
