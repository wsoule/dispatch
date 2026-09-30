import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import { APP_TOKEN } from './paths';

// Messaging refuses the shared agent token, so the daemon is driven with the app token.
const APP = { authorization: `Bearer ${APP_TOKEN}` };

// This spec's own daemon on a copy of the fixture, so the run it dispatches and
// the thread it leaves never reach the shared fixture views.spec.ts screenshots.
let daemon: IsolatedDaemon | null = null;

function requireDaemon(): IsolatedDaemon {
  if (daemon === null) throw new Error('the isolated daemon is not running');
  return daemon;
}

// The run's 0600 token file (orchestrator/paths.ts runTokenPath), keyed like global-setup.ts's daemon file.
function runTokenFile(runId: string): string {
  const { root, home } = requireDaemon();
  const key = createHash('sha256').update(root).digest('hex').slice(0, 12);
  return join(home, '.dispatch', 'runs', key, `${runId}.token`);
}

async function getJson<T>(
  request: APIRequestContext,
  path: string
): Promise<T> {
  const res = await request.get(`${requireDaemon().origin}${path}`, {
    headers: APP,
  });
  if (!res.ok()) {
    throw new Error(`GET ${path} failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

test.describe('messaging end to end', () => {
  // The copy goes with its daemon, so nothing the flow wrote needs undoing.
  test.afterAll(async () => {
    await daemon?.stop();
    daemon = null;
  });

  test('a run asks a blocking question, the human answers in Threads, and the run carries on', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
    daemon = await startIsolatedDaemon('messaging');

    const me = (await getJson<{ ref: string }>(request, '/api/whoami')).ref;
    const ready = await getJson<{ meta: { id: string } }[]>(
      request,
      '/api/tasks/ready'
    );
    const taskId = ready[0]?.meta.id;
    if (taskId === undefined) {
      throw new Error('the storefront fixture has no ready task');
    }
    // Held mail would reach the new run at start and release its wait before it asks.
    const held = await getJson<{ items: { message: { id: string } }[] }>(
      request,
      `/api/mailbox?address=task:${taskId}&state=held`
    );
    expect(
      held.items.map((item) => item.message.id),
      `task ${taskId} has held mail in the fixture`
    ).toEqual([]);
    const dispatched = await request.post(
      `${requireDaemon().origin}/api/tasks/${taskId}/runs`,
      {
        headers: APP,
        data: { executor: 'fake-ask' },
      }
    );
    expect(dispatched.ok()).toBe(true);
    const runId = ((await dispatched.json()) as { id: string }).id;

    // fake-ask parks until a message is pushed in; ask as the run, with its own token.
    await expect
      .poll(() => existsSync(runTokenFile(runId)), { timeout: 15_000 })
      .toBe(true);
    const runToken = readFileSync(runTokenFile(runId), 'utf8').trim();
    const asked = await request.post(`${requireDaemon().origin}/api/messages`, {
      headers: { authorization: `Bearer ${runToken}` },
      data: {
        to: [me],
        kind: 'question',
        blocking: true,
        choices: ['old cart', 'new cart'],
        body: 'Which cart should the checkout read?',
      },
    });
    expect(asked.status()).toBe(201);

    await page.goto(requireDaemon().appUrl);
    const rail = page.locator('#dispatch-sidebar');
    await rail.getByRole('button', { name: /^Threads/ }).click();
    // Scoped to this run, among the fixture's own open questions.
    const question = page
      .getByRole('group', { name: 'Needs you', exact: true })
      .getByRole('option', {
        name: new RegExp(
          String.raw`Which cart should the checkout read\?.*${runId}`
        ),
      });
    await question.click();
    await page.getByRole('button', { name: 'new cart', exact: true }).click();

    // The answer is pushed into the parked run, which plays its last step and finishes.
    await expect
      .poll(
        async () =>
          (
            await getJson<{ meta: { state: string } }>(
              request,
              `/api/runs/${runId}`
            )
          ).meta.state,
        { timeout: 15_000 }
      )
      .toBe('finished');
    await expect(question).toHaveCount(0);

    // The run chat shows the answer where the agent saw it, and what it did next.
    await page
      .getByRole('article')
      .getByRole('button', { name: new RegExp(runId) })
      .first()
      .click();
    await expect(page.getByText('Got the answer. Carrying on.')).toBeVisible();
    // The link's name carries the kind parsed from the text the agent read, and
    // its bubble shows the body without that framing.
    const answerLink = page.getByRole('button', {
      name: `Open thread: answer from ${me}`,
    });
    await expect(answerLink).toBeVisible();
    const log = page.getByRole('region', { name: 'Run log', exact: true });
    await expect(log.getByText('new cart', { exact: true })).toBeVisible();
    await expect(log).not.toContainText('[message from');

    // The link returns to Threads on the question it answered.
    await answerLink.click();
    const thread = page.getByRole('region', { name: 'Thread', exact: true });
    await expect(
      thread.getByText('Which cart should the checkout read?')
    ).toBeVisible();
    await expect(
      thread.getByRole('article').filter({ hasText: 'Chose new cart' })
    ).toHaveCount(1);
  });
});
