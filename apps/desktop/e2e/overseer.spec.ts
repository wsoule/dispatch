import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';

// This spec's own daemon on a copy of the fixture, so the run it dispatches
// never shifts the counts and rows views.spec.ts screenshots.
let daemon: IsolatedDaemon | null = null;

function requireDaemon(): IsolatedDaemon {
  if (daemon === null) throw new Error('the isolated daemon is not running');
  return daemon;
}

// The same daemon the app under test talks to, hit directly. The deny path's
// whole point is that NOTHING changed server-side, and the API is the ground
// truth for that — a UI-only check could pass because a row simply hadn't
// rendered yet.
async function listRunIds(request: APIRequestContext): Promise<Set<string>> {
  const { origin, agentToken } = requireDaemon();
  const res = await request.get(`${origin}/api/runs`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  if (!res.ok()) {
    throw new Error(
      `GET /api/runs failed: ${res.status()} ${await res.text()}`
    );
  }
  const runs = (await res.json()) as { id: string; taskId: string }[];
  return new Set(runs.map((run) => run.id));
}

async function getRun(
  request: APIRequestContext,
  runId: string
): Promise<{ meta: { taskId: string; state: string } }> {
  const { origin, agentToken } = requireDaemon();
  const res = await request.get(`${origin}/api/runs/${runId}`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  if (!res.ok()) {
    throw new Error(`GET /api/runs/${runId} failed: ${res.status()}`);
  }
  return (await res.json()) as { meta: { taskId: string; state: string } };
}

/**
 * The overseer chat against the scripted fake backend (`FakeOverseer`, registered
 * by bin.ts under DISPATCH_ENABLE_FAKES=1 and selected via the
 * `dispatch.devFakeOverseer` devtool flag). The script's turns are: a status
 * answer derived from a real `list_runs` read, then two turns that each queue
 * a `dispatch_task` of the first ready task on the fake executor. That gives
 * the flow this spec exists to cover: status Q/A, a confirm card, the deny
 * path (nothing changes), and the approve path (a fake-dispatched run really
 * appears).
 *
 * Unlike `edit-diff.spec.ts`, this spec HAS been executed and debugged green
 * against the real app (2026-08-10, storefront fixture seeded locally): it
 * passed twice back-to-back, and the fixture counts views.spec.ts pins
 * ('1 Failed' / '5 Needs review') were re-verified intact afterward. It also
 * caught a real race on its first run — a turn settling before the start
 * response landed left the transcript on the pending spinner forever — fixed
 * in useOverseerSession by invalidating the record query after each mutation
 * write.
 */
test.describe('overseer chat end to end', () => {
  // The copy goes with its daemon, so the dispatched run needs no undoing.
  test.afterAll(async () => {
    await daemon?.stop();
    daemon = null;
  });

  test('status answer, then deny leaves state alone and approve dispatches', async ({
    page,
    request,
  }, testInfo) => {
    // Functional coverage, not visual — one theme is plenty, and running it
    // twice would dispatch (and have to clean up) a second run for no gain.
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');

    daemon = await startIsolatedDaemon('overseer');
    // Run ids present before this spec touched anything, so the one run it
    // dispatches can be told apart from the fixture's.
    const baselineRunIds = await listRunIds(request);

    // Route new conversations to the daemon's 'fake' overseer backend — set
    // before load, same as any localStorage-keyed devtool. The live rail
    await page.addInitScript(() => {
      window.localStorage.setItem('dispatch.devFakeOverseer', '1');
    });
    await page.goto(requireDaemon().appUrl);
    await page.locator('#dispatch-sidebar').waitFor();

    // The overseer's row, labelled Assistant, sits in the rail's top group;
    // other "Assistant" labels would make an unscoped lookup ambiguous.
    const rail = page.locator('#dispatch-sidebar');
    const overseerRow = rail.getByRole('button', { name: /^Assistant/ });
    await overseerRow.click();
    await expect(page.getByLabel('Overseer opening question')).toBeVisible();

    // --- Status round trip (scripted turn 0) ---------------------------
    await page
      .getByLabel('Overseer opening question')
      .fill("What's going on in this project?");
    // `exact` matters: role-name matching is substring-based, and "Ask"
    // otherwise also matches the sidebar's "Tasks" row.
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // The reply is derived from a real list_runs read against the fixture —
    // the exact counts belong to the fixture, so pin the shape, not the sum.
    await expect(
      page.getByText(/Status check: this project has \d+ runs on record/)
    ).toBeVisible({ timeout: 15_000 });
    // The read-only tool call is recorded in the transcript as a tool row.
    await expect(page.getByText('list_runs').first()).toBeVisible();

    // --- Queue a mutation (scripted turn 1) ----------------------------
    await page
      .getByLabel('Follow-up message')
      .fill('Dispatch the next ready task for me.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const confirmHeader = page.getByText('Needs your approval');
    await expect(confirmHeader).toBeVisible({ timeout: 15_000 });

    // While the approval waits, the rail's Overseer row carries the pending
    // count — the only rail surface the parked overseer has now that the
    // Runs | Overseer tab strip is gone.
    await expect(overseerRow).toContainText('1');

    // The card's summary comes from dispatch_task.describe:
    //   Dispatch <id> "<title>" with the fake executor
    // Read it off the Approve button's aria-label (`Approve: <summary>`) —
    // the one place it appears exactly once — to learn which task the fake
    // picked. The card also renders the summary as text, and the seeded
    // fixture may hold other copies of the title, so text locators would be
    // ambiguous here.
    const summaryPattern = /Dispatch (t-\w+) "(.+)" with the fake executor/;
    const approveButton = page.getByRole('button', { name: /^Approve:/ });
    const approveLabel = await approveButton.getAttribute('aria-label');
    const match = approveLabel?.match(summaryPattern);
    if (!match) throw new Error(`unexpected action summary: ${approveLabel}`);
    const [, taskId, taskTitle] = match;

    // --- Deny: nothing may happen --------------------------------------
    await page.getByRole('button', { name: /^Deny:/ }).click();
    await expect(page.getByText(/^Denied: Dispatch /)).toBeVisible();
    await expect(confirmHeader).toHaveCount(0);

    const afterDeny = await listRunIds(request);
    expect(
      [...afterDeny].filter((id) => !baselineRunIds.has(id)),
      'denying the queued dispatch must not create a run'
    ).toEqual([]);

    // How many Runs-view rows the target task has BEFORE approval — the
    // fixture already seeds a finished run for some ready tasks, so the
    // approve path must assert on this count growing, not on the title
    // merely being present.
    const titlePattern = new RegExp(
      taskTitle.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    );
    // All agents lists one row per run on record, so the task's title count
    // there is the number of runs it has.
    const allAgents = rail.getByRole('button', { name: /^All agents/ });
    const runRows = page.getByText(titlePattern);
    await allAgents.click();
    // A row every fixture seeds — once it is up, the runs list has rendered
    // and counting is meaningful.
    await expect(
      page.getByText(/Rate limit the search endpoint/).first()
    ).toBeVisible();
    const rowsBefore = await runRows.count();
    await overseerRow.click();

    // --- Ask again (scripted turn 2), approve this time ----------------
    await page
      .getByLabel('Follow-up message')
      .fill('Actually, go ahead and dispatch it.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(confirmHeader).toBeVisible({ timeout: 15_000 });

    // Approving runs the dispatch server-side before the call resolves, so
    // the applied row showing up means the run exists.
    await approveButton.click();
    await expect(page.getByText(/^Applied: Dispatch /)).toBeVisible({
      timeout: 15_000,
    });

    const afterApprove = await listRunIds(request);
    const created = [...afterApprove].filter((id) => !baselineRunIds.has(id));
    expect(created, 'approving must create exactly one run').toHaveLength(1);
    const dispatched = await getRun(request, created[0]);
    expect(dispatched.meta.taskId).toBe(taskId);

    // --- The approved dispatch is visible elsewhere in the app ---------
    // All agents: the task the summary named gains exactly one row.
    await allAgents.click();
    await expect(runRows).toHaveCount(rowsBefore + 1, { timeout: 15_000 });
  });
});
