import { expect, test } from '@playwright/test';
import { createServer } from 'node:net';

import { type IsolatedDaemon, startIsolatedDaemon } from './isolatedDaemon';
import { APP_TOKEN } from './paths';
import { openDestination } from './shell';

// The listener and client routes are decide-tier, so the daemon is driven with the app token.
const APP = { authorization: `Bearer ${APP_TOKEN}` };

// This spec's own daemon on a copy of the fixture: the ask it answers stays in
// the copy's Threads (a stamped thread and a decided row), so on the shared
// daemon it would show up in every views.spec.ts shot taken after it.
let daemon: IsolatedDaemon | null = null;

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

test.describe('A2A ask end to end', () => {
  // The copy goes with its daemon, so the listener and the client need no undoing.
  test.afterAll(async () => {
    await daemon?.stop();
    daemon = null;
  });

  test('an A2A client streams an ask, the owner answers in Threads, and the stream ends COMPLETED', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'dark', 'theme-independent flow');
    daemon = await startIsolatedDaemon('a2a-ask');
    const { origin, appUrl } = daemon;

    const port = await freePort();
    const listener = await request.put(`${origin}/api/a2a/listener`, {
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
    // The stamp names the client and the question, so the Threads row below
    // can only be this ask.
    const stamp = Date.now();
    const created = await request.post(`${origin}/api/a2a/clients`, {
      headers: APP,
      data: { name: `e2e-${stamp}`, approve: true },
    });
    expect(created.status()).toBe(201);
    const { token } = (await created.json()) as { token: string };

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

    await page.goto(appUrl);
    await openDestination(page, 'Threads');
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
