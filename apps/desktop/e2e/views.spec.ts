import { expect, test } from '@playwright/test';

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

for (const view of VIEWS) {
  test(`${view.name} renders`, async ({ page }) => {
    // `goto('/')` would replace baseURL's whole path+query per WHATWG URL
    // joining, dropping `?root=&port=`; `''` keeps baseURL as-is.
    await page.goto('');
    await page.getByText('Dispatch').first().waitFor();
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
test('a colour utility beats the dense type treatments', async ({ page }) => {
  await page.goto('');
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
