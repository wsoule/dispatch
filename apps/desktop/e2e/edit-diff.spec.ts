import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import { APP_TOKEN } from './paths';
import { waitForShell } from './shell';

// Editing a run's diff end to end: open a finished run's review on its task
// page, click the pencil on a changed file, wait for edit mode, type, save,
// and see the diff re-render with the new text. Suggestions, `Apply now`,
// anchor drift and the 409 error paths are covered by unit and render tests
// in `packages/server` and `apps/desktop` instead (see
// `docs/archive/specs/2026-08-04-editable-review-diff-design.md`).

// Run reads and dispatch are driven with the app token.
const APP = { authorization: `Bearer ${APP_TOKEN}` };

// A ready fixture task, and a file on its base branch that its run changes.
const TASK_ID = 't-3f8a21';
const TASK_TITLE = 'Validate discount codes server-side';
const FILE = 'src/checkout/discount.ts';
// The line the run's change adds to FILE, and the reviewer's edit to it.
const ADDED = '// Codes are checked server-side now.';
const MARKER = 'EDITED_BY_E2E_SPEC';

// This spec's own daemon on a copy of the fixture: the run it dispatches and
// the commit the edit makes stay in the copy, never in the shared fixture
// views.spec.ts screenshots.
let daemon: IsolatedDaemon | null = null;

function requireDaemon(): IsolatedDaemon {
  if (daemon === null) throw new Error('the isolated daemon is not running');
  return daemon;
}

async function api<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST',
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

// Commits a change to an existing file in the run's worktree, as the agent
// would have. The fake executor only ever adds a new file, and Pierre's editor
// attaches to changed files alone (a new or deleted file has no pencil).
function commitAgentChange(worktree: string): void {
  // No inherited GIT_* (a hook's GIT_DIR, say) reaches the child git.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
  );
  const path = join(worktree, FILE);
  const before = readFileSync(path, 'utf8');
  writeFileSync(path, `${ADDED}\n${before}`);
  execFileSync('git', ['add', FILE], { cwd: worktree, env });
  execFileSync('git', ['commit', '-q', '-m', 'check codes server-side'], {
    cwd: worktree,
    env,
  });
}

test.describe('editing a run diff end to end', () => {
  // At the suite's 1036px the task page stacks its properties and review
  // checklist above the diff and scrolls as one page, so the changed line
  // stays below the fold; 1600px keeps the rails beside the diff (drawn
  // unified there, its column being narrower than split needs).
  test.use({ viewport: { width: 1600, height: 1100 } });

  // The copy goes with its daemon, so the run and the edit need no undoing.
  test.afterAll(async () => {
    await daemon?.stop();
    daemon = null;
  });

  test('clicking the pencil, typing, and saving re-renders the diff', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
    test.setTimeout(120_000);
    daemon = await startIsolatedDaemon('edit-diff');

    // The pencil needs a run that is done and not yet reviewed, with its
    // worktree still on disk: a fresh run of the fake executor is exactly that.
    const ready = await api<{ meta: { id: string } }[]>(
      request,
      'GET',
      '/tasks/ready'
    );
    expect(
      ready.map((task) => task.meta.id),
      `${TASK_ID} is not ready in the storefront fixture`
    ).toContain(TASK_ID);
    const { id: runId } = await api<{ id: string }>(
      request,
      'POST',
      `/tasks/${TASK_ID}/runs`,
      { executor: 'fake' }
    );
    await expect
      .poll(
        async () =>
          (
            await api<{ meta: { state: string } }>(
              request,
              'GET',
              `/runs/${runId}`
            )
          ).meta.state,
        { timeout: 30_000 }
      )
      .toBe('finished');
    const { meta } = await api<{ meta: { worktreePath: string } }>(
      request,
      'GET',
      `/runs/${runId}`
    );
    commitAgentChange(meta.worktreePath);

    // The task page opens on the finished run's review.
    await page.goto(`${requireDaemon().appUrl}#/task/${TASK_ID}`);
    await waitForShell(page);
    const view = page.getByTestId('tasks-view');
    await expect(
      view.getByRole('heading', { level: 1, name: TASK_TITLE })
    ).toBeVisible();
    await expect(
      view
        .getByRole('navigation', { name: 'Lifecycle' })
        .getByRole('link', { name: /^Review/ })
    ).toHaveAttribute('aria-current', 'page');

    // The changed file is in the review rail; picking it scrolls the diff to it.
    await view.getByRole('button', { name: `M ${FILE}` }).click();
    const addedLine = view.getByText(ADDED);
    await expect(addedLine).toBeVisible({ timeout: 10_000 });
    await expect(addedLine).toBeInViewport();

    // The pencil — `renderHeaderMetadata` in PierreReviewDiff.tsx. The run's
    // other file (the fake executor's new FAKE_OUTPUT.txt) has none, so this
    // is the one pencil on the page.
    const editButton = view.getByRole('button', { name: 'Edit this file' });
    await expect(editButton).toHaveCount(1);
    await editButton.click();

    // `beginEdit` awaits a real GET /runs/:id/file before it flips `editing`,
    // which is what swaps the pencil for Save and Cancel. Waiting for Save
    // doubles as the load gate: if the read fails, edit mode never starts.
    const saveButton = view.getByRole('button', { name: 'Save', exact: true });
    await expect(saveButton).toBeVisible({ timeout: 10_000 });
    const editor = view.locator('[role="textbox"][aria-multiline="true"]');
    await expect(
      editor,
      'no editable region attached after entering edit mode'
    ).toBeVisible();

    // Lands the caret at the end of the added line and types the marker.
    // Pierre's editor takes the caret from the document's `selectionchange`,
    // which fires a task after the click, and drops keys that arrive before
    // it (a person never types that fast). Its caret overlay (`data-caret`)
    // appears once it has the selection, so the keys wait for that.
    await editor.getByText(ADDED).click();
    await expect(view.locator('[data-caret]')).toHaveCount(1);
    await page.keyboard.press('End');
    await page.keyboard.type(` ${MARKER}`);
    await expect(editor.getByText(`${ADDED} ${MARKER}`)).toBeVisible();
    await saveButton.click();

    // Neither recoverable-409 sentence (`editErrorMessage` in
    // reviewDiffItems.ts) shows, the commit holds the edit, and the diff
    // re-renders against it with the pencil back.
    await expect(
      view.getByText('this edit was not saved', { exact: false })
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await api<{ contents: string }>(
              request,
              'GET',
              `/runs/${runId}/file?path=${encodeURIComponent(FILE)}&side=new`
            )
          ).contents,
        { timeout: 10_000 }
      )
      .toContain(`${ADDED} ${MARKER}`);
    await expect(view.getByText(`${ADDED} ${MARKER}`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(saveButton).toHaveCount(0);
    await expect(editButton).toBeVisible();
  });
});
