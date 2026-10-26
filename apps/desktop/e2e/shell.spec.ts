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

test('a row opens its task beside the list', async ({ page, baseURL }) => {
  await page.goto(authedUrl(baseURL));
  await openDestination(page, 'Issues');
  await page.getByText('Persist the cart across devices').first().click();
  await expect(page.getByRole('region', { name: 'Task' })).toBeVisible();
  await expect(page.getByTestId('tasks-view')).toContainText('about t-6c40de');
  // The open task is the last crumb.
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' })
  ).toContainText('Persist the cart across devices');
});

test('a task’s conversation is one flat timeline with a composer locked to it', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await openDestination(page, 'Issues');
  await page.getByText('Add address autocomplete').first().click();
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.getByTestId('conversation')).toBeVisible();
  await expect(page.getByTestId('timeline-message').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Send to t-9b2d14 ↑' })
  ).toBeVisible();
  await expectNoConversationLists(page);
});
