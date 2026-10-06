import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import { REPO } from './paths';

// Two daemons with no A2A listener, paired over a bare repo in the e2e
// scratch dir: pair, ask, answer, unpair (T55).
let a: IsolatedDaemon | null = null;
let b: IsolatedDaemon | null = null;
let scratch: string | null = null;

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

// A bare repo both daemons reach, as a teammate link's remote.
function bareRemote(): string {
  const dir = join(REPO, '.agents', 'ignore', 'e2e-isolated');
  mkdirSync(dir, { recursive: true });
  scratch = realpathSync(mkdtempSync(join(dir, 'a2a-link-remote-')));
  const remote = join(scratch, 'links.git');
  // No inherited GIT_* (a hook's GIT_DIR, say) reaches the child git.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
  );
  execFileSync('git', ['init', '-q', '--bare', remote], { env });
  return remote;
}

test.describe('pairing over a teammate link', () => {
  test.afterAll(async () => {
    await a?.stop();
    await b?.stop();
    a = null;
    b = null;
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  });

  test('a link pairs with no listener, carries a message both sides see, and Remove unpairs both', async ({
    browser,
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
    test.setTimeout(240_000);
    const remote = bareRemote();
    a = await startIsolatedDaemon('a2a-link-a');
    b = await startIsolatedDaemon('a2a-link-b');

    // A offers over the link; the code is shown once.
    await page.goto(a.appUrl);
    await openA2ASettings(page);
    await page.getByLabel('Pair as').fill('bob');
    await page.getByLabel('Over a link (git remote)').fill(remote);
    await page.getByRole('button', { name: 'Pair with…' }).click();
    const shown = page
      .locator('code')
      .filter({ hasText: 'dispatch-a2a-pair:' });
    await expect(shown).toBeVisible();
    const code = (await shown.textContent()) ?? '';

    // B enters it; the SAS shows at once, with no request to A.
    const pageB = await (await browser.newContext()).newPage();
    await pageB.goto(b.appUrl);
    await openA2ASettings(pageB);
    await pageB.getByLabel('Pairing code').fill(code);
    await pageB.getByLabel('Their alias').fill('alice');
    await pageB.getByRole('button', { name: 'Enter code' }).click();
    const sasLine = pageB.getByText(/^SAS /).first();
    await expect(sasLine).toBeVisible({ timeout: 20_000 });
    const sas = (await sasLine.textContent()) ?? '';

    // A completes once it reads B's proof on the branch, with the same SAS.
    await page.getByRole('button', { name: 'Done' }).click();
    await expect
      .poll(
        async () => {
          await page.reload();
          await openA2ASettings(page);
          return (await page.getByText(sas, { exact: true }).count()) > 0;
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    await expect(page.getByText(/^Link · Active/)).toBeVisible();
    await expect(
      page
        .locator('section', {
          has: page.getByRole('heading', { name: 'Links', exact: true }),
        })
        .getByText('a2a:bob')
    ).toBeVisible();

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
    await box.fill(`Hello over the link (${stamp})`);
    await box.press('Enter');

    await page
      .locator('#dispatch-sidebar')
      .getByRole('button', { name: /^Threads/ })
      .click();
    await page
      .getByRole('listbox', { name: 'Threads' })
      .getByRole('option', {
        name: new RegExp(`Hello over the link \\(${stamp}\\)`),
      })
      .click({ timeout: 60_000 });
    const arrived = page
      .getByRole('article')
      .filter({ hasText: `Hello over the link (${stamp})` })
      .first();
    await expect(arrived).toBeVisible({ timeout: 30_000 });
    await expect(
      arrived.getByTitle('Sent from outside this machine over A2A')
    ).toHaveText('A2A');

    // Removing the peer on A unpairs B over the link.
    await openA2ASettings(page);
    await page.getByRole('button', { name: 'Remove a2a:bob' }).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect
      .poll(
        async () => {
          await pageB.reload();
          await openA2ASettings(pageB);
          return (await pageB.getByText(/^Link · Disabled/).count()) > 0;
        },
        { timeout: 60_000 }
      )
      .toBe(true);
  });
});
