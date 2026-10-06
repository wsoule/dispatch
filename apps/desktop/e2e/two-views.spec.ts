import { expect, type Page, test } from '@playwright/test';

import { APP_TOKEN } from './paths';

// Two views never mounts a list whose rows are conversations.
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

// The orb badge, "tasks ●" and the Needs you header are one number.
async function expectOneSetOfNumbers(page: Page, asks: number): Promise<void> {
  await expect(page.getByTestId('two-views-orb-count')).toHaveText(`${asks}`);
  await expect(page.getByTestId('two-views-count-asks')).toHaveText(
    `● ${asks}`
  );
}

test.beforeEach(async ({ page }) => {
  // The run's first load pays Vite's cold dependency bundling.
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem('dispatch:beta', JSON.stringify(['two-views']));
  });
});

test('Two views opens on Overseer, with no sidebar and one set of numbers', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await expect(page.getByTestId('two-views-shell')).toBeVisible();
  await expect(page.locator('#dispatch-sidebar')).toHaveCount(0);
  await expect(page.getByTestId('overseer-view')).toBeVisible();

  // The fixture's seeded run asks two questions on t-9b2d14.
  await expectOneSetOfNumbers(page, 2);
  await expect(page.getByTestId('overseer-asks-door')).toContainText(
    '2 asks wait on you'
  );
  await expectNoConversationLists(page);

  await page.getByTestId('overseer-asks-door').click();
  await expect(page.getByTestId('tasks-view')).toBeVisible();
  await expect(page.getByTestId('needs-you-count')).toHaveText('Needs you · 2');
  await expect(page.getByTestId('needs-you-row')).toHaveCount(2);
  // Both asks are on one task, and the strip counts tasks.
  await expect(page.getByTestId('tasks-strip-need-you')).toHaveText(
    '● 1 task needs you'
  );
  // The strip's ✕ ◇ ◐ are the top bar's.
  for (const [bucket, glyph] of [
    ['failed', '✕'],
    ['review', '◇'],
    ['working', '◐'],
  ] as const) {
    const top = await page
      .getByTestId(`two-views-count-${bucket}`)
      .textContent();
    const n = top?.replace(glyph, '').trim();
    await expect(page.getByTestId(`tasks-strip-${bucket}`)).toContainText(
      `${n}`
    );
  }
  await expectNoConversationLists(page);
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
  await expect(panel.getByText('Two views', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('tasks-view')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+1');
  await expect(page.getByTestId('overseer-view')).toBeVisible();
  await expectNoConversationLists(page);
});

test('a row opens its task beside the list', async ({ page, baseURL }) => {
  await page.goto(authedUrl(baseURL));
  await page.getByTestId('two-views-tasks').click();
  await page.getByText('Persist the cart across devices').first().click();
  await expect(page.getByRole('region', { name: 'Task' })).toBeVisible();
  await expect(page.getByTestId('tasks-view')).toContainText('about t-6c40de');
});
