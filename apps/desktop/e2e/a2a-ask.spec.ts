import { expect, test } from '@playwright/test';
import { createServer } from 'node:net';

import { APP_TOKEN, DAEMON_PORT } from './paths';

const DAEMON = `http://localhost:${DAEMON_PORT}`;
// The listener and client routes are decide-tier, so the daemon is driven with the app token.
const APP = { authorization: `Bearer ${APP_TOKEN}` };

// Duplicated from messaging.spec.ts, following the convention edit-diff.spec.ts documents.
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

// A loopback port nothing listens on now, for the A2A listener.
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

// Reads an SSE response's `data:` frames until the server ends it, as an A2A client would.
async function readEvents(res: Response): Promise<string[]> {
  if (res.body === null) throw new Error(`no stream body (${res.status})`);
  const events: string[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return events;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n\n');
    while (cut !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (frame.startsWith('data: ')) events.push(frame.slice('data: '.length));
      cut = buffer.indexOf('\n\n');
    }
  }
}

let added: { address: string } | null = null;

test.describe('A2A ask end to end', () => {
  test.afterEach(async ({ request }) => {
    // Leave the fixture as found: listener off, the test client revoked.
    await request.delete(`${DAEMON}/api/a2a/listener`, { headers: APP });
    if (added !== null) {
      await request.post(
        `${DAEMON}/api/agents/${encodeURIComponent(added.address)}/revoke`,
        { headers: APP }
      );
    }
    added = null;
  });

  test('an A2A client streams an ask, the owner answers in Threads, and the stream ends COMPLETED', async ({
    page,
    baseURL,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');

    const port = await freePort();
    const listener = await request.put(`${DAEMON}/api/a2a/listener`, {
      headers: APP,
      data: {
        enabled: true,
        host: '127.0.0.1',
        port,
        publicUrl: null,
        tls: null,
        trustForwardedFor: false,
        standalone: false,
      },
    });
    expect(await listener.json()).toMatchObject({ listening: true });
    // A revoked name is never reusable, so each run takes a fresh one.
    const stamp = Date.now();
    const created = await request.post(`${DAEMON}/api/a2a/clients`, {
      headers: APP,
      data: { name: `e2e-${stamp}`, approve: true },
    });
    expect(created.status()).toBe(201);
    const { address, token } = (await created.json()) as {
      address: string;
      token: string;
    };
    added = { address };

    // Stamped, so a question an earlier failed attempt left open never matches.
    const ask = `Is /sessions final? (${stamp})`;
    const stream = fetch(`http://127.0.0.1:${port}/a2a/v1/message:stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'A2A-Version': '1.0',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          messageId: `e2e-ask-${stamp}`,
          role: 'ROLE_USER',
          parts: [{ text: ask }],
        },
      }),
    }).then(readEvents);

    await page.goto(authedUrl(baseURL));
    await page
      .locator('#dispatch-sidebar')
      .getByRole('button', { name: /^Threads/ })
      .click();
    const question = page
      .getByRole('group', { name: 'Needs you', exact: true })
      .getByRole('option', {
        name: new RegExp(String.raw`Is /sessions final\? \(${stamp}\)`),
      });
    await question.click();
    // ThreadPane's PromptBar; Enter submits.
    const reply = page.getByLabel('Reply', { exact: true });
    await reply.fill('Yes, final.');
    await reply.press('Enter');

    const events = await stream;
    expect(events[0]).toContain('"task"');
    expect(events.at(-1)).toContain('TASK_STATE_COMPLETED');
    expect(events.join('\n')).toContain('Yes, final.');
    await expect(question).toHaveCount(0);
  });
});
