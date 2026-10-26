import { expect, type Locator, type Page } from '@playwright/test';

// The app shell as a person sees it: the sidebar's landmarks, not test ids.
// The sidebar is @dispatch/ui's AppShell (see components/shell/DispatchShell),
// so its rows are links in the "Primary" navigation and Settings a link in the
// sidebar's footer.

/** The sidebar rows, by their visible label. */
export type ShellDestinationLabel =
  | 'Overseer'
  | 'Issues'
  | 'Needs you'
  | 'Timeline'
  | 'Graph'
  | 'Threads'
  | 'Docs'
  | 'Runs';

export function primaryNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Primary' });
}

/** A sidebar row's link. A count reads after the label ("Needs you, 2
 * waiting on you"), so the name is matched on its start. */
export function navLink(page: Page, label: ShellDestinationLabel): Locator {
  return primaryNav(page).getByRole('link', {
    name: new RegExp(`^${label}\\b`),
  });
}

export async function waitForShell(page: Page): Promise<void> {
  await page.getByTestId('dispatch-shell').waitFor();
}

/** Opens a destination from the sidebar, as a click on its row. */
export async function openDestination(
  page: Page,
  label: ShellDestinationLabel
): Promise<void> {
  await navLink(page, label).click();
}

/** Opens Settings from the sidebar's footer link. */
export async function openSettings(page: Page): Promise<void> {
  await page
    .getByRole('complementary', { name: 'Sidebar' })
    .getByRole('link', { name: /^Settings\b/ })
    .click();
}

/** Asserts the Needs you row's count: the one number the orb badge, the
 * old "tasks ●" and the Needs you header all showed. */
export async function expectNeedsYouCount(
  page: Page,
  asks: number
): Promise<void> {
  await expect(
    primaryNav(page).getByRole('link', {
      name: new RegExp(`^Needs you\\b.*${asks} waiting on you`),
    })
  ).toBeVisible();
}
