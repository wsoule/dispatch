import { expect, test } from '@playwright/test';

import { type FixturePeerProcess, startFixturePeer } from './a2aPeer';
import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import { APP_TOKEN } from './paths';

// Adding a loopback peer is operator-tier, so the daemon is driven with the app token.
const APP = { authorization: `Bearer ${APP_TOKEN}` };

// This spec's own daemon on a copy of the fixture, and its own scripted peer
// on loopback, so the thread it leaves never reaches the shared fixture.
let daemon: IsolatedDaemon | null = null;
let peer: FixturePeerProcess | null = null;

test.describe('an outbound A2A thread', () => {
  test.afterAll(async () => {
    await peer?.stop();
    peer = null;
    await daemon?.stop();
    daemon = null;
  });

  test('completes @a2a:, asks the peer a blocking question, and shows its answer with the A2A pill', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
    daemon = await startIsolatedDaemon('a2a-outbound');
    peer = await startFixturePeer();
    const added = await request.post(`${daemon.origin}/api/a2a/peers`, {
      headers: APP,
      data: { alias: 'fixture', cardUrl: peer.cardUrl, token: peer.token },
    });
    expect(added.status()).toBe(201);

    await page.goto(daemon.appUrl);
    await page
      .locator('#dispatch-sidebar')
      .getByRole('button', { name: /^Threads/ })
      .click();
    await page.getByRole('button', { name: 'New thread' }).first().click();

    // `@a2a:` completes the peer; Enter turns it into a recipient pill.
    const box = page.getByLabel('New message');
    await box.fill('@a2a:fix');
    await expect(
      page
        .getByRole('listbox', { name: 'Recipients' })
        .getByRole('option', { name: /a2a:fixture/ })
    ).toBeVisible();
    await box.press('Enter');
    await expect(box).toHaveValue('');

    await page
      .getByRole('radiogroup', { name: 'Kind' })
      .getByRole('radio', { name: 'Question' })
      .click();
    const stamp = Date.now();
    await box.fill(`Which colour? (${stamp})`);
    await box.press('Enter');

    // The peer receives the ask, then answers it.
    await expect
      .poll(async () => (await peer?.opened())?.map((o) => o.body), {
        timeout: 20_000,
      })
      .toContain(`Which colour? (${stamp})`);
    await peer.answer('Blue.');

    const answer = page
      .getByRole('article')
      .filter({ hasText: 'Blue.' })
      .first();
    await expect(answer).toBeVisible({ timeout: 20_000 });
    await expect(
      answer.getByTitle('Sent from outside this machine over A2A')
    ).toHaveText('A2A');
  });
});
