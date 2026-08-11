import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { DAEMON_PORT } from './paths';

// Duplicated verbatim from `views.spec.ts`, following the convention its other
// copy in `edit-diff.spec.ts` documents: this token resolution is small enough
// to duplicate per call site rather than factor into a shared module.
function requireToken(): string {
  const token = process.env.DISPATCH_E2E_TOKEN;
  if (!token) {
    throw new Error(
      'DISPATCH_E2E_TOKEN is unset — global-setup.ts should have resolved it ' +
        'before any test ran. Without it every fetch 401s and the app renders ' +
        'its empty state instead of the fixture data this test checks for.'
    );
  }
  return token;
}

function authedUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not configured');
  return `${baseURL}&token=${requireToken()}`;
}

// The same daemon the app under test talks to, hit directly. The deny path's
// whole point is that NOTHING changed server-side, and the API is the ground
// truth for that — a UI-only check could pass because a row simply hadn't
// rendered yet.
async function listRunIds(request: APIRequestContext): Promise<Set<string>> {
  const res = await request.get(`http://localhost:${DAEMON_PORT}/api/runs`, {
    headers: { authorization: `Bearer ${requireToken()}` },
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
  const res = await request.get(
    `http://localhost:${DAEMON_PORT}/api/runs/${runId}`,
    { headers: { authorization: `Bearer ${requireToken()}` } }
  );
  if (!res.ok()) {
    throw new Error(`GET /api/runs/${runId} failed: ${res.status()}`);
  }
  return (await res.json()) as { meta: { taskId: string; state: string } };
}

// Run ids present before this spec touched anything. The cleanup below
// archives whatever appeared beyond these, so the run this spec dispatches
// (its one deliberate mutation) does not shift the ribbon counts and Runs
// rows the screenshot suite's baselines pin.
let baselineRunIds: Set<string> | null = null;

/**
 * The warden chat against the scripted fake backend (`FakeWarden`, registered
 * by bin.ts under DISPATCH_ENABLE_FAKES=1 and selected via the
 * `dispatch.devFakeWarden` devtool flag). The script's turns are: a status
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
 * in useWardenSession by invalidating the record query after each mutation
 * write.
 */
test.describe('warden chat end to end', () => {
  test.afterEach(async ({ request }) => {
    // Undo this spec's one deliberate mutation even on mid-test failure, so
    // nothing leaks into the counts and board columns the screenshot suite's
    // baselines pin ('5 Needs review' in particular). Three steps per run
    // that appeared beyond the baseline: discard its review (sets reviewedAt
    // — the overview feed counts even archived runs while that is unset),
    // archive it off the Runs list, and put its task back to `todo` (dispatch
    // flips a task to in-progress, the run finishing flips it on to
    // in-review). The task's appended activity lines stay — they are not
    // board-visible.
    if (baselineRunIds === null) return;
    const headers = { authorization: `Bearer ${requireToken()}` };
    const after = await listRunIds(request);
    for (const runId of after) {
      if (baselineRunIds.has(runId)) continue;
      const run = await getRun(request, runId);
      await request.post(
        `http://localhost:${DAEMON_PORT}/api/runs/${runId}/review`,
        { headers, data: { action: 'discard' } }
      );
      await request.post(
        `http://localhost:${DAEMON_PORT}/api/runs/${runId}/archive`,
        { headers, data: { archived: true } }
      );
      // The fake warden only ever dispatches a *ready* task, and ready means
      // unblocked `todo` — so `todo` is exactly the pre-test status.
      await request.patch(
        `http://localhost:${DAEMON_PORT}/api/tasks/${run.meta.taskId}`,
        { headers, data: { status: 'todo' } }
      );
    }
    baselineRunIds = null;
  });

  test('status answer, then deny leaves state alone and approve dispatches', async ({
    page,
    baseURL,
    request,
  }, testInfo) => {
    // Functional coverage, not visual — one theme is plenty, and running it
    // twice would dispatch (and have to clean up) a second run for no gain.
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');

    baselineRunIds = await listRunIds(request);

    // Route new conversations to the daemon's 'fake' warden backend — set
    // before load, same as any localStorage-keyed devtool. The overview rail
    // starts closed (same as edit-diff.spec.ts) for a different reason here:
    // it repeats task titles as buttons, which would double-count the
    // Runs-view row assertions below.
    await page.addInitScript(() => {
      window.localStorage.setItem('dispatch.devFakeWarden', '1');
      window.localStorage.setItem('dispatch:overview-rail', '0');
    });
    await page.goto(authedUrl(baseURL));
    await page.getByText('Dispatch').first().waitFor();

    // The Warden tab lives in the sidebar's global section (no ⌘N hint, so
    // its accessible name is exactly its label).
    await page.getByRole('button', { name: 'Warden' }).click();
    await expect(page.getByRole('heading', { name: 'Warden' })).toBeVisible();

    // --- Status round trip (scripted turn 0) ---------------------------
    await page
      .getByLabel('Warden opening question')
      .fill("What's going on in this project?");
    // `exact` matters: role-name matching is substring-based, and "Ask"
    // otherwise also matches the sidebar's "Tasks" row.
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
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
      [...afterDeny].filter((id) => !baselineRunIds?.has(id)),
      'denying the queued dispatch must not create a run'
    ).toEqual([]);

    // How many Runs-view rows the target task has BEFORE approval — the
    // fixture already seeds a finished run for some ready tasks, so the
    // approve path must assert on this count growing, not on the title
    // merely being present.
    const titlePattern = new RegExp(
      taskTitle.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    );
    const runRows = page.getByRole('button', { name: titlePattern });
    await page.keyboard.press('Meta+5');
    // A row every fixture seeds — once it is up, the runs list has rendered
    // and counting is meaningful.
    await expect(
      page
        .getByRole('button', { name: /Rate limit the search endpoint/ })
        .first()
    ).toBeVisible();
    const rowsBefore = await runRows.count();
    await page.getByRole('button', { name: 'Warden' }).click();

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
    const created = [...afterApprove].filter((id) => !baselineRunIds?.has(id));
    expect(created, 'approving must create exactly one run').toHaveLength(1);
    const dispatched = await getRun(request, created[0]);
    expect(dispatched.meta.taskId).toBe(taskId);

    // --- The approved dispatch is visible elsewhere in the app ---------
    // ⌘5 is the Runs view: the task the summary named gains exactly one row.
    await page.keyboard.press('Meta+5');
    await expect(runRows).toHaveCount(rowsBefore + 1, { timeout: 15_000 });
  });
});
