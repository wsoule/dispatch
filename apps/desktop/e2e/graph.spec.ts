import { expect, test } from '@playwright/test';

import { APP_TOKEN } from './paths';
import { navLink, openDestination, waitForShell } from './shell';

// The Graph destination end to end: the sidebar row opens the dependency
// chart on the fixture's milestones, the view switch draws the tasks, a click
// on a task traces it and fills the inspector, and Open task quick-looks it
// in the drawer.

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

test('the Graph charts the fixture’s milestones, traces a task and quick-looks it', async ({
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

  // The fixture's milestones as cards on the milestone map.
  await expect(
    view.getByRole('group', { name: 'Milestone map' })
  ).toBeVisible();
  await expect(
    view.getByRole('button', { name: /Checkout rewrite, / })
  ).toBeVisible();

  // The view switch draws the tasks; a click traces one and the inspector
  // names it.
  await view.getByRole('radio', { name: 'Tasks' }).click();
  await expect(
    view.getByRole('group', { name: 'Task dependencies' })
  ).toBeVisible();
  const cart = view.getByRole('button', {
    name: /Persist the cart across devices, /,
  });
  await cart.click();
  await expect(cart).toHaveAttribute('aria-current', 'true');
  const inspector = view.getByTestId('chart-inspector');
  await inspector.getByRole('button', { name: 'Open task' }).click();
  const drawer = page.getByRole('dialog', {
    name: 'Persist the cart across devices',
  });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});
