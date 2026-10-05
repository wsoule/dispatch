import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { type FixturePeerProcess, startFixturePeer } from './a2aPeer';
import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';

// This spec's own daemon on a copy of the fixture, and its own scripted peer
// on loopback, so the peer it adds never reaches the shared fixture.
let daemon: IsolatedDaemon | null = null;
let peer: FixturePeerProcess | null = null;

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

test.describe('A2A peers in Settings', () => {
  test.afterAll(async () => {
    await peer?.stop();
    peer = null;
    await daemon?.stop();
    daemon = null;
  });

  test('adds, disables, enables, refreshes and removes a peer', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
    daemon = await startIsolatedDaemon('a2a-peers');
    peer = await startFixturePeer();

    await page.goto(daemon.appUrl);
    await openA2ASettings(page);

    // Add: the credential sits in a password field and is cleared on submit.
    await page.getByLabel('Peer alias').fill('fixture');
    await page.getByLabel('Card URL').fill(peer.cardUrl);
    const secret = page.getByLabel('Peer credential');
    await expect(secret).toHaveAttribute('type', 'password');
    await secret.fill(peer.token);
    await page.getByRole('button', { name: 'Add peer' }).click();
    await expect(secret).toHaveValue('');
    const row = page.getByText('a2a:fixture', { exact: true });
    await expect(row).toBeVisible();
    await expect(
      page.getByText(/^Not verified · Active · Fixture peer$/)
    ).toBeVisible();

    await page.getByRole('button', { name: 'Disable a2a:fixture' }).click();
    await expect(
      page.getByText(/^Not verified · Disabled · Fixture peer$/)
    ).toBeVisible();

    await page.getByRole('button', { name: 'Enable a2a:fixture' }).click();
    await expect(
      page.getByText(/^Not verified · Active · Fixture peer$/)
    ).toBeVisible();

    const fetched = await peer.cardFetches();
    await page.getByRole('button', { name: 'Refresh a2a:fixture' }).click();
    await expect.poll(() => peer?.cardFetches()).toBeGreaterThan(fetched);

    await page.getByRole('button', { name: 'Remove a2a:fixture' }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByText('No peers yet')).toBeVisible();
  });
});
