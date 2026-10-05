import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createServer } from 'node:net';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import { APP_TOKEN } from './paths';

// Listener and pairing setup are operator-tier on loopback: the app token.
const APP = { authorization: `Bearer ${APP_TOKEN}` };

let a: IsolatedDaemon | null = null;
let b: IsolatedDaemon | null = null;

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

async function openA2ASettings(page: Page): Promise<void> {
  await page.locator('#dispatch-sidebar').waitFor();
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'A2A', exact: true })
    .click();
}

test.describe('rotating the card key', () => {
  test.afterAll(async () => {
    await a?.stop();
    await b?.stop();
    a = null;
    b = null;
  });

  test('Rotate keeps the pairing: the peer re-pins and stays Signed', async ({
    browser,
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
    test.setTimeout(120_000);
    a = await startIsolatedDaemon('a2a-keys-a');
    b = await startIsolatedDaemon('a2a-keys-b');
    for (const d of [a, b]) {
      const port = await freePort();
      const res = await request.put(`${d.origin}/api/a2a/listener`, {
        headers: APP,
        data: { enabled: true, host: '127.0.0.1', port },
      });
      expect(res.status()).toBe(200);
    }
    const offered = await request.post(`${a.origin}/api/a2a/pairings`, {
      headers: APP,
      data: { alias: 'bob' },
    });
    expect(offered.status()).toBe(201);
    const { code } = (await offered.json()) as { code: string };
    const accepted = await request.post(`${b.origin}/api/a2a/pairings/accept`, {
      headers: APP,
      data: { code, alias: 'alice' },
    });
    expect(accepted.status()).toBe(200);

    await page.goto(a.appUrl);
    await openA2ASettings(page);
    await page.getByRole('button', { name: 'Rotate key' }).click();
    await page.getByRole('button', { name: 'Rotate', exact: true }).click();
    const note = page.getByText(/^New key /);
    await expect(note).toBeVisible({ timeout: 20_000 });
    const fingerprint =
      /^New key (\S+)\./.exec((await note.textContent()) ?? '')?.[1] ?? '';
    expect(fingerprint).not.toBe('');

    const pageB = await (await browser.newContext()).newPage();
    await pageB.goto(b.appUrl);
    await openA2ASettings(pageB);
    await expect(pageB.getByText(/^Signed · Active/)).toBeVisible();
    await expect(pageB.getByText(fingerprint, { exact: true })).toBeVisible();
  });
});
