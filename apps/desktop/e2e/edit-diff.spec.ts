import { expect, test } from '@playwright/test';

// Duplicated verbatim from `views.spec.ts` rather than factored into a shared
// module — the same call already reasons that this token resolution is small
// enough to duplicate per call site (its own comment on `global-setup.ts`
// notes the daemon-file key scheme is independently duplicated four times
// already), so a second copy here follows the existing convention rather than
// introducing a new one.
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

/**
 * !!! THIS SPEC HAS NEVER BEEN EXECUTED !!!
 *
 * Playwright cannot launch in the environment this was written in — its
 * webServer cannot `posix_spawn` git there — so nothing below has been run
 * against the real app.
 * Every selector and wait was chosen by reading `PierreReviewDiff.tsx` and
 * `@pierre/diffs`'s *compiled* output (its editable region is a
 * `role="textbox"` `contenteditable` element with `aria-multiline="true"` —
 * see `node_modules/@pierre/diffs/dist/components/File.js`), never by
 * observing the running app. Treat a first run of this spec as a debugging
 * session, not a rubber stamp: if a selector doesn't match, the fix is far
 * more likely to be in this file than in the app.
 *
 * Scope is deliberately the one path task-9's brief asked for: open a
 * terminal run's review, click the pencil on a file, wait for edit mode,
 * type, save, and assert the diff re-renders with the new text. Suggestions,
 * `Apply now`, anchor drift, and the 409 error paths are out of scope here on
 * purpose — they're covered by unit/render tests in `packages/server` and
 * `apps/desktop` instead. See that plan's Testing section
 * (`docs/archive/specs/2026-08-04-editable-review-diff-design.md`).
 *
 * FIXME (branch: the task-centric consolidation, 98bf1858): the Review page
 * this drives was retired; the run review surface now lives on a task's Diff
 * tab, reached via Inbox (⌘5) → a "Needs review" row. That navigation is
 * mechanical, but the file-selection step below is not: `RunReviewView`
 * renders no changed-files tree and passes no `only` narrowing to
 * `PierreReviewDiff`, so there is no `treeitem` to click and no guarantee of
 * exactly one pencil. Left explicit rather than guessed at, since Playwright
 * cannot launch in the environment this branch was written in.
 */
test.describe('editing a run diff end to end', () => {
  // Same viewport override as `review detail` in views.spec.ts, and for the
  // same reason: the review grid's fixed-width columns leave the diff pane
  // too narrow to show real content at the suite's shared 1036px viewport.
  test.use({ viewport: { width: 1600, height: 1100 } });

  test.fixme('clicking the pencil, typing, and saving re-renders the diff', async ({
    page,
    baseURL,
  }) => {
    // Collapses the live-agents rail, same as `review detail` in
    // views.spec.ts — it is not part of what this test checks and would
    // otherwise compete for width alongside the widened viewport above.
    await page.addInitScript(() => {
      window.localStorage.setItem('dispatch:live-rail', '1');
    });
    await page.goto(authedUrl(baseURL));
    await page.getByText('Dispatch').first().waitFor();
    await page.keyboard.press('Meta+5');

    // Same fixture run views.spec.ts's `review detail` test already relies
    // on: "Rate limit the search endpoint" is seeded `finished` with no
    // `reviewedAt`, which is exactly what `PierreReviewDiff`'s `canEdit`
    // gate requires (`isTerminalRunState(meta.state) && meta.reviewedAt ===
    // undefined`) for the pencil to render at all.
    const queueRow = page.getByRole('button', {
      name: /Rate limit the search endpoint/,
    });
    await expect(
      queueRow,
      'the "Rate limit the search endpoint" run is not in the review queue — ' +
        "this machine's seeded fixture (.agents/ignore/storefront-home) may " +
        'be stale, un-generated, or already reviewed by an earlier manual ' +
        'pass, rather than this being a real regression'
    ).toBeVisible();
    await queueRow.click();

    // Same row views.spec.ts clicks. This step is the reason the whole block
    // is fixme'd: it used to set the retired Review page's `selected` state,
    // which narrowed `PierreReviewDiff`'s `only` prop to this one file and is
    // why exactly one pencil is expected below rather than one per changed
    // file. The task Diff tab renders no such tree and no such narrowing.
    const fileRow = page.getByRole('treeitem', { name: 'rate_limit.ts' });
    await expect(
      fileRow,
      "rate_limit.ts is not in the changed-files list — this run's seeded " +
        'diff snapshot is gitignored/machine-local and may be missing or ' +
        'stale here'
    ).toBeVisible();
    await fileRow.click();

    // Same non-empty-pane guard views.spec.ts's own diff test uses, before
    // trying to click into an editor that might not have rendered anything.
    const firstLine = page.getByText('rule0', { exact: true });
    await expect(firstLine).toBeVisible({ timeout: 10_000 });
    await expect(firstLine).toBeInViewport();

    // The pencil — `renderHeaderMetadata` in PierreReviewDiff.tsx, aria-label
    // "Edit this file" while not yet editing.
    const editButton = page.getByRole('button', { name: 'Edit this file' });
    await expect(
      editButton,
      'no pencil rendered for rate_limit.ts — canEdit requires a terminal, ' +
        'unreviewed run; the fixture run may not satisfy that (already ' +
        'reviewed/merged, or not "finished") on this machine'
    ).toBeVisible();
    await editButton.click();

    // `beginEdit` (PierreReviewDiff.tsx) awaits `ensureLoaded` — a real
    // fetch to GET /runs/:id/file — before flipping `editing`, which is what
    // swaps the pencil for Save/Cancel. Waiting for it doubles as the
    // load-gate assertion: if the fetch fails, `editing` never flips and this
    // times out instead of silently entering edit mode on an empty document
    // (the exact failure the load gate exists to prevent — see
    // PierreReviewDiff.test.tsx's "load gate" tests).
    const saveButton = page.getByRole('button', { name: 'Save' });
    await expect(saveButton).toBeVisible({ timeout: 10_000 });

    // The editable region itself: `contentEditable: "true"`, `role:
    // "textbox"`, `ariaMultiLine: "true"` in @pierre/diffs' compiled
    // editor.js. Scoped by `aria-multiline` specifically to rule out
    // ReviewThread's plain `<textarea>` reply box, which browsers also
    // expose with an implicit textbox role but never sets that ARIA
    // attribute on.
    const editor = page.locator('[role="textbox"][aria-multiline="true"]');
    await expect(
      editor,
      'no contenteditable region attached after entering edit mode — the ' +
        "editor's document may be empty (the exact spike failure the load " +
        'gate exists to prevent) or Pierre may render its editable region ' +
        'differently than the compiled source read while writing this test'
    ).toBeVisible();

    // Click the already-verified first line to focus the editor and land
    // the caret on that line, then jump to its end before typing. A click
    // alone only approximates a caret position from pixel coordinates; this
    // test only needs the marker text to land somewhere in the file, not at
    // an exact column, so precision beyond "end of a known line" isn't
    // needed.
    const marker = 'EDITED_BY_E2E_SPEC';
    await firstLine.click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${marker}`);

    // Ends the edit session as a deliberate save. Per @pierre/diffs' own doc
    // comment, `onItemEditComplete` fires once, with final contents, when
    // edit turns off — which is what drives `handleEditComplete`
    // (PierreReviewDiff.tsx) to POST /runs/:id/edits, commit on the run
    // branch, and (via the existing `review.changed` SSE handler in
    // useDispatchProject.ts) invalidate the run-diff query.
    await saveButton.click();

    // Rules out the two recoverable-409 sentences (`editErrorMessage` in
    // reviewDiffItems.ts) explicitly, rather than relying on the marker
    // assertion below alone to imply success — a stale cached copy of the
    // diff could in principle already contain matching text independent of
    // whether this save actually succeeded.
    await expect(
      page.getByText('this edit was not saved', { exact: false })
    ).toHaveCount(0);

    // The assertion this spec exists for: the diff re-rendered against the
    // new commit and shows the reviewer's edit.
    await expect(page.getByText(marker, { exact: false })).toBeVisible({
      timeout: 10_000,
    });

    // Editing ended cleanly — the pencil is back rather than the header still
    // showing Save/Cancel, which would mean the save never completed.
    await expect(
      page.getByRole('button', { name: 'Edit this file' })
    ).toBeVisible();
  });
});
