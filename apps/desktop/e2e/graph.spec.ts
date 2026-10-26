import { expect, test } from '@playwright/test';

import { APP_TOKEN } from './paths';
import { navLink, openDestination, waitForShell } from './shell';

// The Graph destination end to end: the sidebar row opens the dependency
// graph at the workspace's milestone level, the level tabs switch the scope,
// a fixture milestone is a box, and a second press on a locked box
// quick-looks its task in the drawer.

// global-setup.ts resolves the daemon's per-run token before any test worker
// starts and hands it over via the environment.
function requireToken(): string {
  const token = process.env.DISPATCH_E2E_TOKEN;
  if (!token) {
    throw new Error(
      'DISPATCH_E2E_TOKEN is unset — global-setup.ts should have resolved it ' +
        'before any test ran.'
    );
  }
  return token;
}

// `baseURL` already carries `?root=&port=`; the tokens are appended to the
// full URL string (a relative goto would replace the query).
function authedUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not configured');
  return `${baseURL}&token=${requireToken()}&appToken=${APP_TOKEN}`;
}

test('the Graph draws the fixture’s milestones, switches level and quick-looks a box', async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
  await page.goto(authedUrl(baseURL));
  await waitForShell(page);
  await openDestination(page, 'Graph');
  await expect(navLink(page, 'Graph')).toHaveAttribute('aria-current', 'page');
  const view = page.getByTestId('graph-view');
  await expect(
    view.getByRole('heading', { level: 1, name: 'Dependencies' })
  ).toBeVisible();

  // The drawing's summary, and the fixture's epics as milestone boxes (every
  // box opens a task, so each is a button).
  await expect(
    view.getByRole('img', { name: /^Milestone dependency graph/ })
  ).toBeVisible();
  const checkout = view.getByRole('button', { name: /^Checkout rewrite\b/ });
  await expect(checkout).toBeVisible();
  await expect(
    view.getByRole('button', { name: /^Search relevance\b/ })
  ).toBeVisible();

  // The level tabs: Issues draws the tasks instead.
  const tabs = view.getByRole('navigation', { name: 'Graph level' });
  await expect(tabs.getByRole('link', { name: 'Milestones' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await tabs.getByRole('link', { name: 'Issues' }).click();
  await expect(
    view.getByRole('img', { name: /^Issue dependency graph/ })
  ).toBeVisible();
  await expect(
    view.getByRole('button', { name: /^Persist the cart across devices\b/ })
  ).toBeVisible();
  await view
    .getByRole('navigation', { name: 'Graph level' })
    .getByRole('link', { name: 'Milestones' })
    .click();

  // Enter locks the box (its action strip appears); Enter again opens it:
  // the task drawer, closed by Escape.
  await checkout.focus();
  await page.keyboard.press('Enter');
  await expect(checkout).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Checkout rewrite' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(checkout).toBeVisible();
});
