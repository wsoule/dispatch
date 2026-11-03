import { expect, type Page, test } from '@playwright/test';

import { APP_TOKEN } from './paths';
import { expectNeedsYouCount, openDestination, waitForShell } from './shell';

// Each shot opens its page the way a person does: Issues and Threads from the
// sidebar, every other page under Tasks from its command-menu row (the label
// `buildPaletteEntries` gives it), so a renamed or dropped page fails here
// rather than silently capturing another one. The board shot opens Issues and
// picks Board in its Tasks layout control. That choice lives in the window's
// navigation state and its URL hash (`?mode=board`), and every test loads a
// fresh page in a fresh browser context, so the tasks shot still opens on the
// list.
const VIEWS: { name: string; open: (page: Page) => Promise<void> }[] = [
  { name: 'tasks', open: (page) => openDestination(page, 'Issues') },
  {
    name: 'board',
    open: async (page) => {
      await openDestination(page, 'Issues');
      await page
        .getByRole('radiogroup', { name: 'Tasks layout' })
        .getByRole('radio', { name: 'Board' })
        .click();
      await expect(page.getByTestId('board-pane')).toBeVisible();
    },
  },
  { name: 'threads', open: (page) => openDestination(page, 'Threads') },
  { name: 'files', open: (page) => openFromPalette(page, 'Open Files') },
];

// Runs one command-menu row by its exact label.
async function openFromPalette(page: Page, label: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const row = page.getByRole('option', { name: label, exact: true });
  await expect(row, `no command-menu row named ${label}`).toBeVisible();
  await row.click();
}

const FIXED_NOW = new Date('2026-10-09T12:00:00Z');

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

// The app opens on Overseer, whose sidebar and asks door carry the fixture's
// counts. This checks them before a test opens whatever page it actually
// screenshots, guarding every shot against the same failure: an
// unauthenticated fetch renders zero counts no matter which page ends up on
// screen. A blank render must fail the suite, not become the new baseline.
async function assertFixtureDataLoaded(page: Page): Promise<void> {
  await waitForShell(page);
  // The seeded r-88bf02 run asks the owner two questions on t-9b2d14.
  await expectNeedsYouCount(page, 2);
  await expect(page.getByTestId('overseer-asks-door')).toContainText(
    '2 asks wait on you'
  );
}

// Baselines are the Gr8r desktop on the storefront fixture, refreshed with
// `moonx desktop:e2e-update --ignore-ci-checks` on macOS (CI does not run this
// suite); review every PNG first.
for (const view of VIEWS) {
  test(`${view.name} renders`, async ({ page, baseURL }) => {
    // Rows show ages like "78d ago"; a fixed clock keeps them from drifting
    // a day at a time out of the baseline.
    await page.clock.setFixedTime(FIXED_NOW);
    await page.goto(authedUrl(baseURL));
    await assertFixtureDataLoaded(page);
    await view.open(page);
    // Opening from the command menu leaves the pointer over the page, where
    // it can reveal a row's hover actions; park it off to the side.
    await page.mouse.move(0, 0);
    // The pulse on in-flight rows is the only animation these surfaces have;
    // let it settle so it can't shift a screenshot.
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot(`${view.name}.png`, {
      fullPage: true,
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
// The review surface is a task page's Review tab: t-2e91aa ("Move cart state
// to the session store") has a finished, unreviewed run whose diff the
// fixture keeps as a snapshot (r-2e91aa.diff.json under storefront-home), so
// the page opens on Review. Its own describe for a wider viewport: the page
// sets the diff beside a review rail and the task's properties rail, which
// leave the diff column too narrow to read at the suite's shared 1036px.
test.describe('review detail', () => {
  test.use({ viewport: { width: 1600, height: 1100 } });

  test('renders an open diff', async ({ page, baseURL }) => {
    await page.clock.setFixedTime(FIXED_NOW);
    await page.goto(authedUrl(baseURL));
    await assertFixtureDataLoaded(page);
    await openDestination(page, 'Issues');

    // The task's row opens its page: Enter on a row, as a person does.
    const taskRow = page
      .getByTestId('issues-table')
      .getByText('Move cart state to the session store')
      .first();
    await expect(
      taskRow,
      'the "Move cart state to the session store" task is not in the Tasks ' +
        "list — this machine's seeded fixture (.agents/ignore/storefront) may " +
        'be stale rather than this being a real regression'
    ).toBeVisible();
    await taskRow.focus();
    await page.keyboard.press('Enter');
    const view = page.getByTestId('tasks-view');
    await expect(
      view.getByRole('heading', {
        level: 1,
        name: 'Move cart state to the session store',
      })
    ).toBeVisible();
    // A finished run's task opens on its review.
    await expect(
      view
        .getByRole('navigation', { name: 'Lifecycle' })
        .getByRole('link', { name: /^Review/ })
    ).toHaveAttribute('aria-current', 'page');

    // The review rail lists the run's changed files; picking one scrolls the
    // whole-patch diff to it. The list is the run's own diff snapshot, which
    // is gitignored and machine-local, so a missing row fails with a reason.
    const fileRow = view.getByRole('button', {
      name: 'M src/cart/CartProvider.ts',
    });
    await expect(
      fileRow,
      "src/cart/CartProvider.ts is not in the changed-files list — this run's " +
        'seeded diff snapshot is gitignored/machine-local and appears to be ' +
        'missing or stale here, rather than this being a real render ' +
        'regression'
    ).toBeVisible();
    await fileRow.click();

    // The actual failure mode: the file header renders regardless of the bug
    // (it sits outside the virtualized region), so asserting only on it
    // would pass against an empty pane. This comment is a line the run added,
    // so its presence means `CodeView` measured a real, non-zero viewport and
    // rendered rows into it — not just mounted.
    const addedLine = view.getByText('Cart state lives in the session store');
    await expect(
      addedLine,
      'the CartProvider.ts diff pane shows no code — CodeView likely ' +
        'measured a zero-height scroll container (the exact failure fixed in ' +
        '60e99e8)'
    ).toBeVisible({ timeout: 10_000 });
    // `toBeVisible` alone is not enough: a zero-height `overflow-auto`
    // container still leaves its virtualizer's overscan rows attached with a
    // non-empty bounding box, so the line can be "visible" by that check alone
    // while actually clipped to nothing by its own ancestor — the exact shape
    // of the regression this test exists to catch. `toBeInViewport` instead
    // checks the element's intersection with the page after clipping, which
    // a collapsed scroll container drives to zero.
    await expect(
      addedLine,
      "CartProvider.ts's added line is attached but clipped to nothing — " +
        "CodeView's scroll container likely has zero real height"
    ).toBeInViewport();

    // The review rail scrolls up and down only. A row wider than the rail let
    // it scroll sideways, and a click on a changed file could then shift every
    // section's left edge out of view.
    const rail = view.getByRole('complementary', { name: 'Review checklist' });
    expect(
      await rail.evaluate((el) => el.scrollWidth - el.clientWidth),
      'the review rail is wider inside than out, so it scrolls sideways'
    ).toBe(0);

    // Same pointer park and settle as every other view shot.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot('review-detail.png', {
      fullPage: true,
    });
  });
});
