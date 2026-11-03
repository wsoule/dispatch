import { expect, type Locator, type Page, test } from '@playwright/test';

import { APP_TOKEN } from './paths';
import { openSettings, waitForShell } from './shell';

// The localStorage key lib/theme.ts exports (THEME_STORAGE_KEY); spelled out
// here because a spec should fail when the stored key changes under it. Each
// test gets a fresh browser context whose storage holds only Setup's done
// flag (playwright.config.ts's storageState), so every test starts with no
// theme stored: on "system".
const THEME_KEY = 'dispatch:theme';

function authedUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not configured');
  const token = process.env.DISPATCH_E2E_TOKEN;
  if (!token)
    throw new Error('DISPATCH_E2E_TOKEN is unset; see global-setup.ts');
  return `${baseURL}&token=${token}&appToken=${APP_TOKEN}`;
}

// The project's OS scheme ('dark' or 'light' in playwright.config.ts), which
// "system" follows; the sidebar toggle flips to the opposite of it.
function osScheme(): 'dark' | 'light' {
  return test.info().project.use.colorScheme === 'dark' ? 'dark' : 'light';
}

function storedTheme(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), THEME_KEY);
}

const SYSTEM_ROW = 'Follow the system theme';

// Opens the command palette and narrows it to the "Follow the system theme"
// row, which exists only while a light or dark choice is stored. It waits for
// the menu and checks the typed query landed in it, so a later "the row is
// gone" cannot pass just because the menu never opened.
async function searchPaletteForSystemTheme(page: Page): Promise<Locator> {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type(SYSTEM_ROW);
  await expect(palette.getByRole('combobox')).toHaveValue(SYSTEM_ROW);
  return palette;
}

// Records html[data-theme] when the parser finishes the document
// (readyState 'interactive'), which is before any module script runs: what
// the pre-paint script in <body> wrote, before the app could touch it.
// Init scripts run on every navigation, page.reload() included.
async function recordThemeBeforeApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState !== 'interactive') return;
      document.documentElement.dataset.e2eThemeBeforeApp =
        document.documentElement.dataset.theme ?? '';
    });
  });
}

test.beforeEach(() => {
  // The run's first load pays Vite's cold dependency bundling.
  test.setTimeout(90_000);
});

test('the sidebar toggle flips the theme, and a reload keeps it', async ({
  page,
  baseURL,
}) => {
  await recordThemeBeforeApp(page);
  await page.goto(authedUrl(baseURL));
  await waitForShell(page);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'system');
  await expect(html).toHaveAttribute('data-e2e-theme-before-app', 'system');

  const flipped = osScheme() === 'dark' ? 'light' : 'dark';
  await page
    .getByRole('complementary', { name: 'Sidebar' })
    .getByRole('button', { name: 'Switch between light and dark' })
    .click();
  await expect(html).toHaveAttribute('data-theme', flipped);
  expect(await storedTheme(page)).toBe(flipped);

  // The pre-paint script reads the stored choice back before the app runs,
  // so the reload never paints the OS theme first.
  await page.reload();
  await waitForShell(page);
  await expect(html).toHaveAttribute('data-e2e-theme-before-app', flipped);
  await expect(html).toHaveAttribute('data-theme', flipped);
});

test('Settings › General › Theme › System goes back to following the OS', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await waitForShell(page);
  await openSettings(page);
  const theme = page.getByRole('radiogroup', { name: 'Theme' });
  const html = page.locator('html');

  await theme.getByRole('radio', { name: 'Dark' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(await storedTheme(page)).toBe('dark');

  await theme.getByRole('radio', { name: 'System' }).click();
  await expect(html).toHaveAttribute('data-theme', 'system');
  await expect(theme.getByRole('radio', { name: 'System' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  expect(await storedTheme(page)).toBeNull();
});

test('the palette row "Follow the system theme" clears a stored choice', async ({
  page,
  baseURL,
}) => {
  await page.goto(authedUrl(baseURL));
  await waitForShell(page);
  await openSettings(page);
  await page
    .getByRole('radiogroup', { name: 'Theme' })
    .getByRole('radio', { name: 'Dark' })
    .click();
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');

  const palette = await searchPaletteForSystemTheme(page);
  const row = palette.getByRole('option', { name: SYSTEM_ROW, exact: true });
  await expect(row).toBeVisible();
  await row.click();
  await expect(html).toHaveAttribute('data-theme', 'system');
  expect(await storedTheme(page)).toBeNull();

  // With nothing stored the row has nothing to undo, so it is gone.
  const reopened = await searchPaletteForSystemTheme(page);
  await expect(
    reopened.getByRole('option', { name: SYSTEM_ROW, exact: true })
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
});
