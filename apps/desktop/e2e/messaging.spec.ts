import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP_TOKEN, DAEMON_PORT, HOME, ROOT } from './paths';

const DAEMON = `http://localhost:${DAEMON_PORT}`;
// Messaging refuses the shared agent token, so the daemon is driven with the app token.
const APP = { authorization: `Bearer ${APP_TOKEN}` };

// Duplicated from views.spec.ts, following the convention edit-diff.spec.ts documents.
function requireToken(): string {
  const token = process.env.DISPATCH_E2E_TOKEN;
  if (!token) {
    throw new Error(
      'DISPATCH_E2E_TOKEN is unset: global-setup.ts should have resolved it.'
    );
  }
  return token;
}

function authedUrl(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('baseURL is not configured');
  return `${baseURL}&token=${requireToken()}&appToken=${APP_TOKEN}`;
}

// The run's 0600 token file (orchestrator/paths.ts runTokenPath), keyed like global-setup.ts's daemon file.
function runTokenFile(runId: string): string {
  const key = createHash('sha256').update(ROOT).digest('hex').slice(0, 12);
  return join(HOME, '.dispatch', 'runs', key, `${runId}.token`);
}

async function getJson<T>(
  request: APIRequestContext,
  path: string
): Promise<T> {
  const res = await request.get(`${DAEMON}${path}`, { headers: APP });
  if (!res.ok()) {
    throw new Error(`GET ${path} failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

let created: { runId: string; taskId: string } | null = null;

test.describe('messaging end to end', () => {
  test.afterEach(async ({ request }) => {
    // overseer.spec.ts's undo, plus a cancel for a run a failure left parked, so the
    // screenshot suite's counts hold. No route closes the run's question, so a failed
    // attempt leaves it open under Needs you in every decide-tier window of the fixture.
    if (created === null) return;
    const { runId, taskId } = created;
    await request.post(`${DAEMON}/api/runs/${runId}/cancel`, { headers: APP });
    await request.post(`${DAEMON}/api/runs/${runId}/review`, {
      headers: APP,
      data: { action: 'discard' },
    });
    await request.post(`${DAEMON}/api/runs/${runId}/archive`, {
      headers: APP,
      data: { archived: true },
    });
    await request.patch(`${DAEMON}/api/tasks/${taskId}`, {
      headers: APP,
      data: { status: 'todo' },
    });
    created = null;
  });

  test('a run asks a blocking question, the human answers in Threads, and the run carries on', async ({
    page,
    baseURL,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');

    const me = (await getJson<{ ref: string }>(request, '/api/whoami')).ref;
    const ready = await getJson<{ meta: { id: string } }[]>(
      request,
      '/api/tasks/ready'
    );
    const taskId = ready[0]?.meta.id;
    if (taskId === undefined) {
      throw new Error('the storefront fixture has no ready task');
    }
    const dispatched = await request.post(
      `${DAEMON}/api/tasks/${taskId}/runs`,
      {
        headers: APP,
        data: { executor: 'fake-ask' },
      }
    );
    expect(dispatched.ok()).toBe(true);
    const runId = ((await dispatched.json()) as { id: string }).id;
    created = { runId, taskId };

    // fake-ask parks until a message is pushed in; ask as the run, with its own token.
    await expect
      .poll(() => existsSync(runTokenFile(runId)), { timeout: 15_000 })
      .toBe(true);
    const runToken = readFileSync(runTokenFile(runId), 'utf8').trim();
    const asked = await request.post(`${DAEMON}/api/messages`, {
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

    await page.goto(authedUrl(baseURL));
    const rail = page.locator('#dispatch-sidebar');
    await rail.getByRole('button', { name: /^Threads/ }).click();
    // Scoped to this run: a question an earlier failed attempt left open stays in Needs you.
    const question = page
      .getByRole('region', { name: 'Needs you' })
      .getByRole('button', {
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
      .locator('article')
      .getByRole('button', { name: new RegExp(runId) })
      .first()
      .click();
    await expect(page.getByText('Got the answer. Carrying on.')).toBeVisible();
    // The link's name carries the kind parsed from the text the agent read, and
    // its bubble shows the body without that framing.
    const answerLink = page.getByRole('button', {
      name: `Open thread: answer from ${me}`,
    });
    const answer = answerLink.locator('xpath=../..');
    await expect(answer.getByText('new cart', { exact: true })).toBeVisible();
    await expect(answer).not.toContainText('[message from');

    // The link returns to Threads on the question it answered.
    await answerLink.click();
    const thread = page.getByRole('region', { name: 'Thread' });
    await expect(
      thread.getByText('Which cart should the checkout read?')
    ).toBeVisible();
    await expect(
      thread.locator('article').filter({ hasText: 'Chose new cart' })
    ).toHaveCount(1);
  });
});
