import { expect, type Page, test } from '@playwright/test';

import { APP_TOKEN } from './paths';

// Each shot opens its page the way a person does: Tasks and Threads from the
// top bar, every other page under Tasks from its command-menu row (the label
// `buildPaletteEntries` gives it), so a renamed or dropped page fails here
// rather than silently screenshotting another one.
const VIEWS: { name: string; open: (page: Page) => Promise<void> }[] = [
  { name: 'tasks', open: (page) => clickTopBar(page, 'two-views-tasks') },
  { name: 'threads', open: (page) => clickTopBar(page, 'two-views-threads') },
  { name: 'plans', open: (page) => openFromPalette(page, 'Open Plans') },
  { name: 'braindump', open: (page) => openFromPalette(page, 'Open Notes') },
  { name: 'git', open: (page) => openFromPalette(page, 'Open Git') },
  { name: 'files', open: (page) => openFromPalette(page, 'Open Files') },
  { name: 'impact', open: (page) => openFromPalette(page, 'Open Impact') },
];

async function clickTopBar(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click();
}

// Runs one command-menu row by its exact label.
async function openFromPalette(page: Page, label: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const row = page.getByRole('option', { name: label, exact: true });
  await expect(row, `no command-menu row named ${label}`).toBeVisible();
  await row.click();
}

// global-setup.ts resolves the daemon's per-run token before any test worker
// starts and hands it over via the environment; this fails loudly rather than
// letting a test silently visit an unauthenticated URL if that ever changes.
function requireToken(): string {
  const token = process.env.DISPATCH_E2E_TOKEN;
  if (!token) {
    throw new Error(
      'DISPATCH_E2E_TOKEN is unset — global-setup.ts should have resolved it ' +
        'before any test ran. Without it every fetch 401s and the app renders ' +
        'its empty state instead of the fixture data these tests check for.'
    );
  }
  return token;
}

// `baseURL` already carries `?root=&port=`. A relative `page.goto('/')` would
// replace that whole path+query per WHATWG URL joining rules, so the token
// has to be appended to the full URL string instead of joined onto it. The app
// token opens the window as the owner, which Threads needs to show its threads.
function authedUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not configured');
  return `${baseURL}&token=${requireToken()}&appToken=${APP_TOKEN}`;
}

// The app opens on Overseer, whose top bar carries the fixture's counts. This
// checks them before a test opens whatever page it actually screenshots,
// guarding every shot against the same failure: an unauthenticated fetch
// renders zero counts no matter which page ends up on screen. A blank render
// must fail the suite, not become the new baseline.
async function assertFixtureDataLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId('two-views-shell')).toBeVisible();
  // The seeded r-88bf02 run asks the owner two questions on t-9b2d14.
  await expect(page.getByTestId('two-views-count-asks')).toHaveText('● 2');
  await expect(page.getByTestId('two-views-count-review')).toHaveText('◇ 4');
  await expect(page.getByTestId('two-views-count-failed')).toHaveText('✕ 1');
}

// Every baseline here predates the Overseer/Tasks layout and the inbox,
// overview and landing pages it retired; each needs a reviewed refresh, never
// a local one.
for (const view of VIEWS) {
  test(`${view.name} renders`, async ({ page, baseURL }) => {
    await page.goto(authedUrl(baseURL));
    await assertFixtureDataLoaded(page);
    await view.open(page);
    // The pulse on in-flight rows is the only animation these surfaces have;
    // let it settle so it can't shift a screenshot.
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot(`${view.name}.png`, {
      fullPage: true,
      // The Git view's right pane renders the fixture repo's own working-tree
      // diff, which every daemon boot and every run of this suite appends to
      // (ledger lines, task frontmatter) — data, not layout. The file tree
      // and the chrome around it are still compared.
      mask: [page.locator('[data-slot="git-right-pane"]')],
    });
  });
}

// No shot above opens a diff, which is exactly the
// surface that regressed in fix/review-surface (60e99e8): `CodeView` rendered
// its file header but produced a zero-height virtualizer underneath it, with
// no console error. A screenshot alone would not have caught that — an empty
// pane and a populated one differ only by pixels `maxDiffPixels: 200` can
// absorb, and the header renders identically either way — so this asserts
// real code content is present before ever taking one.
//
// Scoped to its own describe for a wider viewport: the review grid's three
// fixed-width columns (190/200/290px + gaps, 728px minimum) leave the
// flexible diff column only a sliver of the suite's shared 1036px viewport —
// too narrow to show anything, which is a real but distinct layout gap from
// the height bug this test exists to catch. A wider viewport isolates the two
// rather than asserting around whichever one happens to be squeezing the pane.
//
// FIXME (branch: the task-centric consolidation, 98bf1858): the review queue
// this once drove is gone; it now opens the run's task from the Tasks list
// instead. What has no replacement is the next step: the run review surface no longer renders a
// changed-files tree at all (`RunReviewView` hands the whole patch to
// `PierreReviewDiff` with no `only` narrowing), so the `treeitem` click below
// — the step that selects the one file whose content is then asserted — has
// nothing to click. Rewriting the assertion needs the real DOM of the new
// surface, and Playwright cannot launch in the environment this branch was
// written in (its webServer cannot `posix_spawn` git), so it is left explicit
// rather than guessed at.
test.describe('review detail', () => {
  test.use({ viewport: { width: 1600, height: 1100 } });

  test.fixme('renders an open diff', async ({ page, baseURL }) => {
    await page.goto(authedUrl(baseURL));
    await assertFixtureDataLoaded(page);
    await page.getByTestId('two-views-tasks').click();

    // The task's row in the Tasks list opens its page beside the list.
    const taskRow = page
      .getByTestId('tasks-view')
      .getByRole('gridcell', { name: 'Rate limit the search endpoint' });
    await expect(
      taskRow,
      'the "Rate limit the search endpoint" task is not in the Tasks list — ' +
        "this machine's seeded fixture (.agents/ignore/storefront-home) may " +
        'be stale rather than this being a real regression'
    ).toBeVisible();
    await taskRow.click();

    // The changed-files list is keyed off this run's own diff snapshot
    // (.agents/ignore/storefront-home/.dispatch/runs/**/r-de238d.diff.json),
    // which is gitignored and machine-local — a known, accepted limitation of
    // this harness. Fail with a legible reason rather than a bare locator
    // timeout if that snapshot is ever missing on the machine running this.
    //
    // Matched by role/name rather than title: the list is `@pierre/trees`'
    // `FileTree`, whose rows are `role="treeitem"` with the filename as their
    // accessible name (see `getFileTreeRowAriaLabel` in
    // `@pierre/trees/dist/render/FileTreeView.js`) — it sets `title` only on
    // the git-status icon, not the row itself.
    const fileRow = page.getByRole('treeitem', { name: 'rate_limit.ts' });
    await expect(
      fileRow,
      "rate_limit.ts is not in the changed-files list — this run's seeded " +
        'diff snapshot is gitignored/machine-local and appears to be ' +
        'missing or stale here, rather than this being a real render ' +
        'regression'
    ).toBeVisible();
    await fileRow.click();

    // The actual failure mode: the file header renders regardless of the bug
    // (it sits outside the virtualized region), so asserting only on it
    // would pass against an empty pane. `rule0` is the first token of the
    // first line of the real file content, so its presence means `CodeView`
    // measured a real, non-zero viewport and rendered rows into it — not
    // just mounted.
    const firstLine = page.getByText('rule0', { exact: true });
    await expect(
      firstLine,
      'rate_limit.ts diff pane shows no code — CodeView likely measured a ' +
        'zero-height scroll container (the exact failure fixed in 60e99e8)'
    ).toBeVisible({ timeout: 10_000 });
    // `toBeVisible` alone is not enough: a zero-height `overflow-auto`
    // container still leaves its virtualizer's overscan rows attached with a
    // non-empty bounding box, so `rule0` can be "visible" by that check alone
    // while actually clipped to nothing by its own ancestor — the exact shape
    // of the regression this test exists to catch. `toBeInViewport` instead
    // checks the element's intersection with the page after clipping, which
    // a collapsed scroll container drives to zero.
    await expect(
      firstLine,
      "rate_limit.ts's first line is attached but clipped to nothing — " +
        "CodeView's scroll container likely has zero real height"
    ).toBeInViewport();

    // Same settle as every other view shot, for the same reason.
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot('review-detail.png', {
      fullPage: true,
    });
  });
});
