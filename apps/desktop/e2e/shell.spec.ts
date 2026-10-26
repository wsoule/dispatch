import { expect, type Page, test } from '@playwright/test';

import { APP_TOKEN } from './paths';
import {
  expectNeedsYouCount,
  navLink,
  openDestination,
  openSettings,
  primaryNav,
  waitForShell,
} from './shell';

// Overseer and Tasks never mount a list whose rows are conversations.
const CONVERSATION_LISTS = [
  '[role=listbox][aria-label*=Thread]',
  '[aria-label*=Channel]',
  '[aria-label*=Direct]',
  '[data-row-kind=thread]',
  '[data-row-kind=channel]',
];

function authedUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not configured');
  const token = process.env.DISPATCH_E2E_TOKEN;
  if (!token)
    throw new Error('DISPATCH_E2E_TOKEN is unset; see global-setup.ts');
  return `${baseURL}&token=${token}&appToken=${APP_TOKEN}`;
}

async function expectNoConversationLists(page: Page): Promise<void> {
  for (const selector of CONVERSATION_LISTS) {
    await expect(page.locator(selector), selector).toHaveCount(0);
  }
}

test.beforeEach(() => {
  // The run's first load pays Vite's cold dependency bundling.
  test.setTimeout(90_000);
});

test('the app opens on Overseer inside the shell, with one set of numbers', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await waitForShell(page);
  // The old Two views chrome is gone: the sidebar is the navigation.
  await expect(page.locator('#dispatch-sidebar')).toHaveCount(0);
  const nav = primaryNav(page);
  await expect(nav).toBeVisible();
  for (const label of [
    'Overseer',
    'Issues',
    'Needs you',
    'Timeline',
    'Graph',
    'Threads',
    'Docs',
    'Runs',
  ] as const) {
    await expect(navLink(page, label)).toBeVisible();
  }
  await expect(nav.locator('[aria-current="page"]')).toHaveAttribute(
    'href',
    '#/overseer'
  );
  await expect(page.getByTestId('overseer-view')).toBeVisible();

  // The fixture's seeded run asks two questions on t-9b2d14: the Overseer
  // row's badge, the Needs you row and the Needs you header are one number.
  await expectNeedsYouCount(page, 2);
  await expect(
    nav.getByRole('link', { name: /^Overseer\b.*2 waiting on you/ })
  ).toBeVisible();
  await expect(page.getByTestId('overseer-asks-door')).toContainText(
    '2 asks wait on you'
  );
  await expectNoConversationLists(page);

  await page.getByTestId('overseer-asks-door').click();
  const tasks = page.getByTestId('tasks-view');
  await expect(tasks).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveAttribute(
    'href',
    '#/issues'
  );
  // Overseer's own Needs you block stays mounted beside Tasks; count Tasks'.
  await expect(tasks.getByTestId('needs-you-count')).toHaveText(
    'Needs you · 2'
  );
  await expect(tasks.getByTestId('needs-you-row')).toHaveCount(2);
  // Both asks are on one task, and the Needs you preset tab counts tasks.
  await expect(
    tasks
      .getByRole('navigation', { name: 'Presets' })
      .getByRole('link', { name: /^Needs you/ })
  ).toHaveText('Needs you1');
  await expectNoConversationLists(page);
});

test('sidebar rows open their destinations and mark the current one', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await waitForShell(page);
  const nav = primaryNav(page);

  await openDestination(page, 'Issues');
  await expect(page.getByTestId('tasks-view')).toBeVisible();
  await expect(page.getByTestId('overseer-view')).toBeHidden();
  await expect(navLink(page, 'Issues')).toHaveAttribute('aria-current', 'page');

  await openDestination(page, 'Needs you');
  await expect(navLink(page, 'Needs you')).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page.getByTestId('tasks-view')).toBeVisible();

  await openDestination(page, 'Threads');
  await expect(navLink(page, 'Threads')).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);

  await openDestination(page, 'Timeline');
  await expect(page.getByTestId('timeline-view')).toBeVisible();
  await expect(navLink(page, 'Timeline')).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);

  await openDestination(page, 'Overseer');
  await expect(page.getByTestId('overseer-view')).toBeVisible();
  await expect(navLink(page, 'Overseer')).toHaveAttribute(
    'aria-current',
    'page'
  );
  // The crumb names the project and the place.
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' })
  ).toContainText('Overseer');
});

test('keys switch views and open Settings without leaving the view', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await expect(page.getByTestId('overseer-view')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+2');
  await expect(page.getByTestId('tasks-view')).toBeVisible();
  await expect(page.getByTestId('overseer-view')).toBeHidden();

  await page.keyboard.press('ControlOrMeta+,');
  const panel = page.getByTestId('settings-panel');
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole('heading', { name: 'General', level: 1 })
  ).toBeVisible();
  // Settings is the current place while it is open.
  await expect(
    page
      .getByRole('complementary', { name: 'Sidebar' })
      .getByRole('link', { name: /^Settings\b/ })
  ).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('tasks-view')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+1');
  await expect(page.getByTestId('overseer-view')).toBeVisible();
  await expectNoConversationLists(page);
});

test('the sidebar footer opens Settings; "[" collapses the rail', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await waitForShell(page);
  await openSettings(page);
  const panel = page.getByTestId('settings-panel');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // The app owns the key (the shell's own binding is off); the choice is kept.
  await page.keyboard.press('[');
  await expect(page.locator('html')).toHaveAttribute(
    'data-shell-collapsed',
    'true'
  );
  await expect(
    page.getByRole('button', { name: 'Expand sidebar' })
  ).toBeVisible();
  await page.keyboard.press('[');
  await expect(page.locator('html')).toHaveAttribute(
    'data-shell-collapsed',
    'false'
  );
});

test('a row click quick-looks its task in the slide-over; Enter opens the page', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await openDestination(page, 'Issues');
  const row = page.getByText('Persist the cart across devices').first();
  await row.click();
  // The slide-over is a dialog named by the task's title, over the list.
  const drawer = page.getByRole('dialog', {
    name: 'Persist the cart across devices',
  });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect(page.getByTestId('issues-table')).toBeVisible();
  // Its row is the current one; Esc closes the drawer and keeps the list.
  await expect(
    page.locator('[data-nav-item="row"][aria-current="true"]')
  ).toContainText('Persist the cart across devices');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId('issues-table')).toBeVisible();

  // Enter on the row opens the full page: TaskDetail's page layout, the task's title as
  // the page heading, its lifecycle tabs under it, and the crumb ending on the task.
  await row.focus();
  await page.keyboard.press('Enter');
  const view = page.getByTestId('tasks-view');
  await expect(
    view.getByRole('heading', {
      level: 1,
      name: 'Persist the cart across devices',
    })
  ).toBeVisible();
  await expect(
    view.getByRole('navigation', { name: 'Lifecycle' }).getByRole('link')
  ).toHaveText([/^Spec/, /^Run/, /^Review/, /^Summary/]);
  await expect(
    view.getByRole('navigation', { name: 'Breadcrumb' })
  ).toContainText('t-6c40de');
});

test('a task’s conversation is one flat timeline with a composer locked to it', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await openDestination(page, 'Issues');
  // Enter opens the full page (a click would only quick-look the task).
  await page.getByText('Add address autocomplete').first().focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.getByTestId('conversation')).toBeVisible();
  await expect(page.getByTestId('timeline-message').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Send to t-9b2d14 ↑' })
  ).toBeVisible();
  await expectNoConversationLists(page);
});

test('a route survives a reload: the Timeline row stays current, a task page shows its task', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await waitForShell(page);
  // Opening the Timeline writes its route into the hash, beside the daemon's
  // ?root=&port= (which stay in the search part).
  await openDestination(page, 'Timeline');
  await expect(page.getByTestId('timeline-view')).toBeVisible();
  await expect(page).toHaveURL(/\?root=.*#\/timeline$/);
  await page.reload();
  await waitForShell(page);
  await expect(page.getByTestId('timeline-view')).toBeVisible();
  await expect(navLink(page, 'Timeline')).toHaveAttribute(
    'aria-current',
    'page'
  );

  // A task page's route names the task; the reloaded window shows it.
  await openDestination(page, 'Issues');
  await page.getByText('Persist the cart across devices').first().focus();
  await page.keyboard.press('Enter');
  const view = page.getByTestId('tasks-view');
  await expect(
    view.getByRole('heading', {
      level: 1,
      name: 'Persist the cart across devices',
    })
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/task\/t-6c40de/);
  await page.reload();
  await waitForShell(page);
  await expect(
    page.getByTestId('tasks-view').getByRole('heading', {
      level: 1,
      name: 'Persist the cart across devices',
    })
  ).toBeVisible();
  await expect(navLink(page, 'Issues')).toHaveAttribute('aria-current', 'page');
});
