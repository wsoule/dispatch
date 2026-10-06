import { expect, type Page, test } from '@playwright/test';

import { APP_TOKEN } from './paths';

// Each shot opens its view from the sidebar row carrying its `data-nav-item`
// (a `ProjectView` id), so a new rail row cannot shift which view a shot shows.
const VIEWS = [
  { name: 'inbox', navItem: 'inbox' },
  { name: 'threads', navItem: 'threads' },
  { name: 'overview', navItem: 'overview' },
  { name: 'tasks', navItem: 'board' },
  { name: 'plans', navItem: 'plans' },
  { name: 'braindump', navItem: 'brain-dump' },
  { name: 'landing', navItem: 'landing' },
  { name: 'git', navItem: 'branches' },
  { name: 'files', navItem: 'files' },
  { name: 'impact', navItem: 'impact' },
];

// Opens a project view by its sidebar row, failing clearly if the row is gone.
async function openView(page: Page, navItem: string): Promise<void> {
  const row = page.locator(`#dispatch-sidebar [data-nav-item="${navItem}"]`);
  await expect(row, `no sidebar row for the ${navItem} view`).toBeVisible();
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

// The app opens on Home (appNav.ts's initialNavState), so this opens Overview
// and checks its counts before a test switches to whatever view it actually
// screenshots. That guards all of them against the same failure: an
// unauthenticated fetch renders this exact empty state no matter which view
// ends up on screen. A blank render must fail the suite, not become the new
// baseline.
async function assertFixtureDataLoaded(page: Page): Promise<void> {
  await openView(page, 'overview');
  // Named by the ControlRibbon pills specifically (accessible name is
  // "<label>, <count>"), because "Failed"/"Review" alone also match the
  // feed's group header and per-row status text — this is the one spot that
  // pins down a real, non-zero fixture count rather than just some text.
  // The seeded r-88bf02 question moves t-9b2d14 from Review to Answer for the owner.
  await expect(page.getByRole('button', { name: 'Answer, 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review, 4' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Failed, 1' })).toBeVisible();
  await expect(
    page.getByText('Nothing running, nothing waiting on you.')
  ).toHaveCount(0);
}

// threads and files have no baseline yet, and the others were captured under the
// old ⌘N map, some of another view; each needs a reviewed refresh, never a local one.
for (const view of VIEWS) {
  test(`${view.name} renders`, async ({ page, baseURL }) => {
    await page.goto(authedUrl(baseURL));
    await page.locator('#dispatch-sidebar').waitFor();
    await assertFixtureDataLoaded(page);
    await openView(page, view.navItem);
    // The pulse on in-flight rows is the only animation these surfaces have;
    // let it settle so it can't shift a screenshot.
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot(`${view.name}.png`, {
      fullPage: true,
      // The live rail is on every project screen but is not what any of these
      // baselines is about, and it is chrome that keeps moving — the Runs |
      // Overseer tab strip alone has changed shape three times. Unmasked, each
      // of those edits silently invalidates every PNG here with no CI job to
      // catch it. Masked, the rail still occupies its 240px, so a view
      // squeezed beside it still regresses visibly.
      //
      // What the mask does cost is every pixel *inside* that column, and
      // LiveRail.test.tsx cannot make up the difference: happy-dom has no
      // layout engine at all, so nothing there can see the rail render at the
      // wrong width, overflow its column, or clip its composer. The
      // 'the live rail keeps its column' test below covers that directly
      // instead — as measured geometry rather than as pixels, so it needs no
      // baseline of its own and stays honest through cosmetic rail edits.
      // The frame's status strip is live chrome too: "Synced 1m ago" and the
      // day's spend change with the clock and with every run the suite makes.
      // The Git view's right pane renders the fixture repo's own working-tree
      // diff, which every daemon boot and every run of this suite appends to
      // (ledger lines, task frontmatter) — data, not layout. The file tree
      // and the chrome around it are still compared.
      mask: [
        page.locator('[data-testid="live-rail"]'),
        page.locator('[data-slot="frame-status-strip"]'),
        page.locator('[data-slot="git-right-pane"]'),
      ],
    });
  });
}

/**
 * The coverage the mask above removes, put back as geometry instead of pixels.
 * A rail that renders at the wrong width, overflows its column, or clips its
 * composer is invisible to both suites otherwise: the screenshots paint it
 * magenta, and LiveRail.test.tsx runs in happy-dom, which has no layout engine
 * (OverseerChat.test.tsx has to hand-define scrollHeight/scrollTop for exactly
 * that reason). Measured rather than captured, so it needs no baseline to
 * review and does not re-break every time the tab strip changes shape.
 *
 * NOT YET OBSERVED GREEN, the same as overseer.spec.ts's rail case and for the
 * same two reasons — `bun run e2e --list` discovers it, which proves only that
 * it parses and type-checks. Running it here dies in the webServer with
 * `ENOENT: posix_spawn 'git'` before a browser ever launches.
 *
 * It is also narrower than what the mask removes: width, horizontal overflow
 * and composer containment on one view in one theme, versus every pixel of the
 * rail across every view in both themes. The tab strip, run rows, attention strip,
 * amber badge and collapsed strip have no visual coverage anywhere. That trade
 * is a human's to rule on, not a closed question.
 */
test('the live rail keeps its column on a project view', async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'dark', 'layout is theme-independent');

  await page.goto(authedUrl(baseURL));
  await page.locator('#dispatch-sidebar').waitFor();
  await assertFixtureDataLoaded(page);

  // The rail is a fixed 244px column (Linear's `--sidebar-width`), painted on
  // the frame beside the inset panel — see packages/ui/src/sidebar.tsx.
  const rail = page.locator('#dispatch-sidebar');
  await expect(rail).toBeVisible();
  const railBox = await rail.boundingBox();
  if (railBox === null) throw new Error('the rail has no layout box');
  expect(railBox.width).toBeCloseTo(244, 0);

  // Nothing inside may spill past that column — a long task title in the
  // Live agents section is precisely what the screenshot mask would now hide.
  const overflow = await rail.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // The live-agents section is the part that moves; it must sit inside the
  // column rather than be clipped out of it.
  const live = page.getByTestId('live-rail');
  await expect(live).toBeVisible();
  const liveBox = await live.boundingBox();
  if (liveBox === null) throw new Error('the live-agents section has no box');
  expect(liveBox.x).toBeGreaterThanOrEqual(railBox.x);
  expect(liveBox.x + liveBox.width).toBeLessThanOrEqual(
    railBox.x + railBox.width
  );
});

// The queue-only "review" shot above never opened a diff, which is exactly the
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
// FIXME (branch: the task-centric consolidation, 98bf1858): the page this
// drives no longer exists. Retargeting is Inbox → a "Needs review" row →
// TaskView's Diff tab, and that first half is mechanical. What has no
// replacement is the second half: the run review surface no longer renders a
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
    // Collapses the live-agents rail — it is not part of what this test checks
    // and would otherwise compete for width alongside the viewport widening
    // above. The rail never hides entirely now, only narrows to a strip.
    await page.addInitScript(() => {
      window.localStorage.setItem('dispatch:live-rail', '1');
    });
    await page.goto(authedUrl(baseURL));
    await page.locator('#dispatch-sidebar').waitFor();
    await assertFixtureDataLoaded(page);
    await openView(page, 'inbox');

    // The Inbox's needs-review row (see `Row` in InboxView.tsx): the task
    // title plus a relative timestamp. Matched loosely on the title because
    // the bare title also names other, currently-hidden buttons this same
    // task shows elsewhere in the shell, and Playwright's strict mode counts
    // those regardless of visibility.
    const queueRow = page.getByRole('button', {
      name: /Rate limit the search endpoint/,
    });
    await expect(
      queueRow,
      'the "Rate limit the search endpoint" run is not in the review queue — ' +
        "this machine's seeded fixture (.agents/ignore/storefront-home) may " +
        'be stale rather than this being a real regression'
    ).toBeVisible();
    await queueRow.click();

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
