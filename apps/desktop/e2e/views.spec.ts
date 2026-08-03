import { expect, type Page, test } from '@playwright/test';

// Views are React state rather than routes, so each one is reached by its
// sidebar accelerator (visible as ⌘1–⌘7 in the sidebar) instead of a URL.
const VIEWS = [
  { name: 'overview', key: 'Meta+1' },
  { name: 'braindump', key: 'Meta+2' },
  { name: 'plans', key: 'Meta+3' },
  { name: 'tasks', key: 'Meta+4' },
  { name: 'runs', key: 'Meta+5' },
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
    page.getByText('No agents are running and nothing is waiting on you.')
  ).toHaveCount(0);
}

for (const view of VIEWS) {
  test(`${view.name} renders`, async ({ page, baseURL }) => {
    await page.goto(authedUrl(baseURL));
    await page.getByText('Dispatch').first().waitFor();
    await assertFixtureDataLoaded(page);
    await page.keyboard.press(view.key);
    // The pulse on in-flight rows is the only animation these surfaces have;
    // let it settle so it can't shift a screenshot.
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot(`${view.name}.png`, { fullPage: true });
  });
}

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
