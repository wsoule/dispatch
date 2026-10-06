import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createServer } from 'node:net';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import { APP_TOKEN } from './paths';

// Opening a loopback listener is operator-tier: the app token drives it.
const APP = { authorization: `Bearer ${APP_TOKEN}` };

// Two daemons, each on its own copy of the fixture, paired with each other.
let a: IsolatedDaemon | null = null;
let b: IsolatedDaemon | null = null;

// A loopback port nothing listens on now, for an A2A listener.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        resolve(
          typeof address === 'object' && address !== null ? address.port : 0
        )
      );
    });
  });
}

async function openListener(
  request: APIRequestContext,
  d: IsolatedDaemon
): Promise<void> {
  const port = await freePort();
  const res = await request.put(`${d.origin}/api/a2a/listener`, {
    headers: APP,
    data: { enabled: true, host: '127.0.0.1', port },
  });
  expect(res.status()).toBe(200);
}

// Settings → A2A, through the `G S` shortcut and the Settings page list.
async function openA2ASettings(page: Page): Promise<void> {
  await page.locator('#dispatch-sidebar').waitFor();
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'A2A', exact: true })
    .click();
}

test.describe('pairing two Dispatch agents', () => {
  test.afterAll(async () => {
    await a?.stop();
    await b?.stop();
    a = null;
    b = null;
  });

  test('one code pairs both sides with the same SAS, mail arrives with the A2A pill, and Remove unpairs both', async ({
    browser,
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
    test.setTimeout(120_000);
    a = await startIsolatedDaemon('a2a-pair-a');
    b = await startIsolatedDaemon('a2a-pair-b');
    await openListener(request, a);
    await openListener(request, b);

    // A makes a code; it is shown once.
    await page.goto(a.appUrl);
    await openA2ASettings(page);
    await page.getByLabel('Pair as').fill('bob');
    await page.getByRole('button', { name: 'Pair with…' }).click();
    const shown = page
      .locator('code')
      .filter({ hasText: 'dispatch-a2a-pair:' });
    await expect(shown).toBeVisible();
    const code = (await shown.textContent()) ?? '';
    expect(code.startsWith('dispatch-a2a-pair:')).toBe(true);

    // B enters it, in its own browser context (the app keeps one daemon per origin).
    const pageB = await (await browser.newContext()).newPage();
    await pageB.goto(b.appUrl);
    await openA2ASettings(pageB);
    const field = pageB.getByLabel('Pairing code');
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill(code);
    await pageB.getByLabel('Their alias').fill('alice');
    await pageB.getByRole('button', { name: 'Enter code' }).click();
    await expect(field).toHaveValue('');
    const sasLine = pageB.getByText(/^SAS /).first();
    await expect(sasLine).toBeVisible({ timeout: 20_000 });
    const sas = (await sasLine.textContent()) ?? '';

    // A shows the same SAS once the code is put away.
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(shown).toHaveCount(0);
    await page.reload();
    await openA2ASettings(page);
    await expect(page.getByText(sas, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/^Signed · Active/)).toBeVisible();

    // B writes to a2a:alice; it reaches A's threads with the A2A pill.
    await pageB
      .locator('#dispatch-sidebar')
      .getByRole('button', { name: /^Threads/ })
      .click();
    await pageB.getByRole('button', { name: 'New thread' }).first().click();
    const box = pageB.getByLabel('New message');
    await box.fill('@a2a:ali');
    await expect(
      pageB
        .getByRole('listbox', { name: 'Recipients' })
        .getByRole('option', { name: /a2a:alice/ })
    ).toBeVisible();
    await box.press('Enter');
    const stamp = Date.now();
    await box.fill(`Hello over the pairing (${stamp})`);
    await box.press('Enter');

    await page
      .locator('#dispatch-sidebar')
      .getByRole('button', { name: /^Threads/ })
      .click();
    await page
      .getByRole('listbox', { name: 'Threads' })
      .getByRole('option', {
        name: new RegExp(`Hello over the pairing \\(${stamp}\\)`),
      })
      .click({ timeout: 30_000 });
    const arrived = page
      .getByRole('article')
      .filter({ hasText: `Hello over the pairing (${stamp})` })
      .first();
    await expect(arrived).toBeVisible({ timeout: 30_000 });
    await expect(
      arrived.getByTitle('Sent from outside this machine over A2A')
    ).toHaveText('A2A');

    // Removing the peer on A unpairs B too.
    await openA2ASettings(page);
    await page.getByRole('button', { name: 'Remove a2a:bob' }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect
      .poll(
        async () => {
          await pageB.reload();
          await openA2ASettings(pageB);
          return (await pageB.getByText(/^Signed · Disabled/).count()) > 0;
        },
        { timeout: 30_000 }
      )
      .toBe(true);
  });
});
