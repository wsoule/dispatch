import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import { APP_TOKEN } from './paths';
import { navLink, openDestination, waitForShell } from './shell';

// The Timeline destination end to end: the sidebar row opens the chart, a
// project lane carries its dated milestone as a bar, the zoom switches, the
// missing-input banners list what the fixture lacks, and a bar quick-looks
// its milestone with the drawer's Milestone section.

const APP = { authorization: `Bearer ${APP_TOKEN}` };

// The storefront fixture's milestones (its two epics) have no project and no
// date, so this spec gives one of them both, on its own daemon so the shared
// fixture views.spec.ts screenshots stays as it was.
let daemon: IsolatedDaemon | null = null;

function requireDaemon(): IsolatedDaemon {
  if (daemon === null) throw new Error('the isolated daemon is not running');
  return daemon;
}

async function api<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown
): Promise<T> {
  const res = await request.fetch(`${requireDaemon().origin}/api${path}`, {
    method,
    headers: APP,
    data,
  });
  expect(
    res.ok(),
    `${method} ${path}: ${res.status()} ${await res.text()}`
  ).toBe(true);
  return (res.status() === 204 ? null : await res.json()) as T;
}

/** A calendar day `days` from today, as the task store writes due dates. */
function dayFromNow(days: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

test.afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

test('the Timeline draws a project lane with its dated milestone, zooms, and lists the missing inputs', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
  test.setTimeout(120_000);
  daemon = await startIsolatedDaemon('timeline');

  // A project to hold the checkout epic, and a due date three weeks out so
  // the bar falls inside the chart's window (14 days back, 70 ahead).
  const project = await api<{ meta: { id: string } }>(
    request,
    'POST',
    '/tasks',
    { title: 'Storefront relaunch', kind: 'project' }
  );
  await api(request, 'PATCH', '/tasks/e-4a19c2', {
    parent: project.meta.id,
    dueDate: dayFromNow(21),
  });

  await page.goto(daemon.appUrl);
  await waitForShell(page);
  await openDestination(page, 'Timeline');
  await expect(navLink(page, 'Timeline')).toHaveAttribute(
    'aria-current',
    'page'
  );
  const view = page.getByTestId('timeline-view');
  await expect(
    view.getByRole('heading', { level: 1, name: 'Timeline' })
  ).toBeVisible();

  // The lane (the project, with "No lead" under its name) and its bar.
  const chart = view.getByRole('region', { name: /^Timeline, / });
  await expect(
    chart.getByRole('group', { name: /^Storefront relaunch\b/ })
  ).toBeVisible();
  const bar = chart.getByRole('button', { name: /^Checkout rewrite, / });
  await expect(bar).toBeVisible();

  // Weeks / Months.
  const zoom = view.getByRole('radiogroup', { name: 'Zoom' });
  await zoom.getByRole('radio', { name: 'Months' }).click();
  await expect(zoom.getByRole('radio', { name: 'Months' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(bar).toBeVisible();

  // The other epic still has no date, and the new project no lead.
  const banners = view.getByRole('region', { name: 'Missing inputs' });
  await expect(banners.getByText(/has no target date/)).toBeVisible();
  await expect(banners.getByText(/has no lead/)).toBeVisible();

  // A bar quick-looks its milestone, whose drawer carries the Milestone section.
  await bar.click();
  const drawer = page.getByRole('dialog', { name: 'Checkout rewrite' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'Milestone' })).toBeVisible();
  await expect(drawer.getByRole('list', { name: 'Rubric' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(bar).toBeVisible();
});
