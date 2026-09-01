import { expect, type Page, test } from '@playwright/test';

// Views are React state rather than routes, so each one is reached by its
// sidebar accelerator (visible as ⌘1–⌘7 in the sidebar) instead of a URL. The
// order below is `PROJECT_VIEW_ORDER` (see components/shell/Sidebar.tsx),
// which is what assigns the numbers — the Runs and Review pages that used to
// hold ⌘5/⌘6 were retired by the task-centric consolidation, and Inbox and
// Impact took those slots.
//
// Every entry here is one "press key, screenshot" shot. A run's diff is no
// longer reachable this way at all: it lives on a task's Diff tab now, which
// takes real navigation and its own content assertion — see the fixme'd
// `review detail` block below.
const VIEWS = [
  { name: 'overview', key: 'Meta+1' },
  { name: 'braindump', key: 'Meta+2' },
  { name: 'plans', key: 'Meta+3' },
  { name: 'tasks', key: 'Meta+4' },
  { name: 'inbox', key: 'Meta+5' },
  { name: 'impact', key: 'Meta+6' },
  { name: 'git', key: 'Meta+7' },
];

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
// has to be appended to the full URL string instead of joined onto it.
function authedUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not configured');
  return `${baseURL}&token=${requireToken()}`;
}

// Every view boots on Overview first (appNav.ts's initialNavState), so
// checking it here — before a test switches to whatever view it actually
// screenshots — guards all of them against the same failure: an
// unauthenticated fetch renders this exact empty state no matter which view
// ends up on screen. A blank render must fail the suite, not become the new
// baseline.
async function assertFixtureDataLoaded(page: Page): Promise<void> {
  // Named by the ControlRibbon stat tiles specifically (accessible name is
  // "<count> <label>"), because "Failed"/"Needs review" alone also match the
  // feed's group header and per-row status text — this is the one spot that
  // pins down a real, non-zero fixture count rather than just some text.
  await expect(page.getByRole('button', { name: '1 Failed' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '5 Needs review' })
  ).toBeVisible();
  await expect(
    page.getByText('Nothing running, nothing waiting on you.')
  ).toHaveCount(0);
}

// BASELINES, EXACTLY (branch: the rail's Runs | Warden tab toggle). The loop
// below produces 14 screenshot tests — 7 views x 2 themes — but
// views.spec.ts-snapshots/ holds 10 PNGs, and they fail in two different ways:
//
//   - overview, braindump, plans, tasks, git (10 PNGs) were captured before
//     the live rail existed, which every project view has carried since. These
//     diff against a stale baseline. The mask below is what stops the next
//     rail edit from re-staling them; it does not un-stale them now.
//   - inbox and impact (4 shots) have NO baseline at all — they were added to
//     VIEWS when they took the retired Runs/Review accelerators and never
//     captured. Playwright fails these with "A snapshot doesn't exist" and
//     writes the file, so `bun run e2e:update` does not refresh them, it
//     AUTHORS them. Look at those four before committing them; nobody has.
//
// All of it needs one run from an environment where Playwright can launch,
// which this branch's is not, for two independent reasons: the webServer
// cannot `posix_spawn` git, and the storefront fixture (e2e/paths.ts) is
// gitignored and keyed by root path, so a worktree has none to seed from.
// Neither ci.yml nor release.yml runs Playwright, so nothing else catches it.
for (const view of VIEWS) {
  test(`${view.name} renders`, async ({ page, baseURL }) => {
    await page.goto(authedUrl(baseURL));
    await page.getByText('Dispatch').first().waitFor();
    await assertFixtureDataLoaded(page);
    await page.keyboard.press(view.key);
    // The pulse on in-flight rows is the only animation these surfaces have;
    // let it settle so it can't shift a screenshot.
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot(`${view.name}.png`, {
      fullPage: true,
      // The live rail is on every project screen but is not what any of these
      // baselines is about, and it is chrome that keeps moving — the Runs |
      // Warden tab strip alone has changed shape three times. Unmasked, each
      // of those edits silently invalidates all 14 PNGs here with no CI job to
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
      mask: [page.locator('[data-testid="live-rail"]')],
    });
  });
}

/**
 * The coverage the mask above removes, put back as geometry instead of pixels.
 * A rail that renders at the wrong width, overflows its column, or clips its
 * composer is invisible to both suites otherwise: the screenshots paint it
 * magenta, and LiveRail.test.tsx runs in happy-dom, which has no layout engine
 * (WardenChat.test.tsx has to hand-define scrollHeight/scrollTop for exactly
 * that reason). Measured rather than captured, so it needs no baseline to
 * review and does not re-break every time the tab strip changes shape.
 *
 * NOT YET OBSERVED GREEN, the same as warden.spec.ts's rail case and for the
 * same two reasons — `bun run e2e --list` discovers it, which proves only that
 * it parses and type-checks. Running it here dies in the webServer with
 * `ENOENT: posix_spawn 'git'` before a browser ever launches.
 *
 * It is also narrower than what the mask removes: width, horizontal overflow
 * and composer containment on one view in one theme, versus every pixel of the
 * rail across 7 views x 2 themes. The tab strip, run rows, attention strip,
 * amber badge and collapsed strip have no visual coverage anywhere. That trade
 * is a human's to rule on, not a closed question.
 */
test('the live rail keeps its column on a project view', async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'dark', 'layout is theme-independent');

  // '0' is expanded — the state the rail boots in for every screenshot above.
  await page.addInitScript(() => {
    window.localStorage.setItem('dispatch:live-rail', '0');
  });
  await page.goto(authedUrl(baseURL));
  await page.getByText('Dispatch').first().waitFor();
  await assertFixtureDataLoaded(page);

  const rail = page.getByTestId('live-rail');
  await expect(rail).toBeVisible();
  const railBox = await rail.boundingBox();
  if (railBox === null) throw new Error('the live rail has no layout box');

  // The invariant is `w-60` — 15rem — not a pixel count. global.css sets
  // `html { font-size: clamp(16px, 0.55vw + 9.5px, 21px) }`, so 15rem is the
  // 240px the mask reserved only while the viewport stays at or below roughly
  // 1182px; playwright.config.ts pins 1036 today, but a later change there
  // would fail this test with the rail perfectly correct. Measuring the root
  // font-size and multiplying keeps the assertion on the rail's width rather
  // than on the viewport the config happens to use.
  const remPx = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  );
  expect(railBox.width).toBeCloseTo(15 * remPx, 0);

  // Nothing inside may spill past that column — a long task title or the tab
  // strip overflowing is precisely what the mask would now hide.
  const overflow = await rail.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // The Warden tab's composer is the tallest thing the rail has to fit, and
  // the surface this branch added: it has to land inside the column, not be
  // clipped out of it by the transcript above.
  await page.getByRole('tab', { name: 'Warden' }).click();
  const composer = page.getByLabel('Warden opening question');
  await expect(composer).toBeVisible();
  const composerBox = await composer.boundingBox();
  if (composerBox === null) throw new Error('the rail composer has no box');
  expect(composerBox.x).toBeGreaterThanOrEqual(railBox.x);
  expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(
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
// drives no longer exists. Retargeting is Inbox (⌘5) → a "Needs review" row →
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
    await page.getByText('Dispatch').first().waitFor();
    await assertFixtureDataLoaded(page);
    await page.keyboard.press('Meta+5');

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

// `.dense-meta`/`.dense-label` set a default colour, so a Tailwind colour
// utility on the same element must outrank them. Only a real browser can decide
// that — it turns on cascade layers, which happy-dom does not implement.
test('a colour utility beats the dense type treatments', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await page.getByText('Dispatch').first().waitFor();

  const colours = await page.evaluate(() => {
    const read = (className: string) => {
      const probe = document.createElement('span');
      probe.className = className;
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    };
    return {
      plain: read('dense-meta'),
      overridden: read('dense-meta text-foreground'),
      label: read('dense-label text-foreground'),
      foreground: read('text-foreground'),
    };
  });

  expect(colours.overridden).toBe(colours.foreground);
  expect(colours.label).toBe(colours.foreground);
  expect(colours.plain).not.toBe(colours.foreground);
});
