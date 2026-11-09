import type { RunMeta } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  loadPairing,
  pairCodeFromHash,
  runsForPhone,
  runStateLabel,
  savePairing,
} from './mobileApi';
import { MobileApp } from './MobileApp';

function runMeta(
  over: Partial<RunMeta> & Pick<RunMeta, 'id' | 'state'>
): RunMeta {
  return {
    taskId: 't-1',
    taskTitle: `task ${over.id}`,
    executor: 'claude',
    branch: 'b',
    baseBranch: 'main',
    worktreePath: '/tmp/w',
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...over,
  } as RunMeta;
}

describe('pairCodeFromHash', () => {
  test('reads the code a pairing link carries', () => {
    expect(pairCodeFromHash('#pair=ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(pairCodeFromHash('#x=1&pair=ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(pairCodeFromHash('#decision=m-1')).toBeNull();
    expect(pairCodeFromHash('')).toBeNull();
  });
});

describe('runsForPhone', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');

  test('live runs first, then the last day, newest first; archived and old ones drop', () => {
    const { live, recent } = runsForPhone(
      [
        runMeta({
          id: 'r-old',
          state: 'finished',
          updatedAt: '2026-10-18T12:00:00.000Z',
        }),
        runMeta({
          id: 'r-done',
          state: 'finished',
          updatedAt: '2026-10-20T09:00:00.000Z',
        }),
        runMeta({
          id: 'r-failed',
          state: 'failed',
          updatedAt: '2026-10-20T11:00:00.000Z',
        }),
        runMeta({ id: 'r-run', state: 'running' }),
        runMeta({
          id: 'r-wait',
          state: 'awaiting-approval',
          updatedAt: '2026-10-20T11:30:00.000Z',
        }),
        runMeta({
          id: 'r-archived',
          state: 'finished',
          updatedAt: '2026-10-20T11:00:00.000Z',
          archivedAt: '2026-10-20T11:10:00.000Z',
        }),
      ],
      now
    );
    expect(live.map((r) => r.id)).toEqual(['r-wait', 'r-run']);
    expect(recent.map((r) => r.id)).toEqual(['r-failed', 'r-done']);
  });

  test('labels a finished run by whether anyone reviewed it', () => {
    expect(runStateLabel(runMeta({ id: 'a', state: 'finished' }))).toBe(
      'Ready for review'
    );
    expect(
      runStateLabel(
        runMeta({
          id: 'a',
          state: 'finished',
          reviewedAt: '2026-10-20T11:00:00.000Z',
        })
      )
    ).toBe('Done');
    expect(
      runStateLabel(runMeta({ id: 'a', state: 'interrupted-dirty' }))
    ).toBe('Failed');
  });
});

describe('MobileApp', () => {
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; init?: RequestInit; body: string }>;

  // A fake mobile listener: one open question, one gate, one run.
  function serve(routes: Record<string, () => Response>) {
    calls = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({
        url,
        init,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      const key = `${init?.method ?? 'GET'} ${url}`;
      const route = routes[key];
      return Promise.resolve(
        route === undefined ? new Response('{}', { status: 404 }) : route()
      );
    }) as typeof fetch;
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  function renderApp() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <MobileApp />
      </QueryClientProvider>
    );
  }

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    globalThis.fetch = realFetch;
    location.hash = '';
  });

  test('an unpaired phone pairs with the code from the link', async () => {
    location.hash = '#pair=ABCD-EFGH';
    serve({
      'POST /api/pair': () =>
        json({
          token: 'tok',
          device: { id: 'd-1' },
          handle: 'w',
          tier: 'decide',
        }),
      'GET /api/decisions/open': () => json({ items: [] }),
      'GET /api/runs': () => json([]),
    });
    renderApp();
    expect(screen.getByDisplayValue('ABCD-EFGH')).toBe(
      screen.getByLabelText('Pairing code')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await screen.findByText('Nothing is waiting on you');
    expect(loadPairing()).toEqual({ token: 'tok', device: 'd-1' });
    const body = JSON.parse(calls[0].body) as { code: string };
    expect(body.code).toBe('ABCD-EFGH');
  });

  test('approves a gate with its choice, sending the device token', async () => {
    savePairing({ token: 'tok', device: 'd-1' });
    serve({
      'GET /api/decisions/open': () =>
        json({
          items: [
            {
              id: 'm-gate',
              from: 'run:r-1',
              body: 'Run `rm -rf build`?',
              choices: ['approve', 'deny'],
              data: { type: 'tool-approval', tool: 'Bash' },
            },
          ],
        }),
      'GET /api/runs': () =>
        json([runMeta({ id: 'r-1', state: 'awaiting-approval' })]),
      'POST /api/messages/m-gate/reply': () => json({ message: {} }, 201),
    });
    renderApp();
    await screen.findByText('run:r-1 wants to run Bash');
    expect(screen.getByText('Needs you')).toBeTruthy();
    // A gate takes only its choices, never free text.
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/messages/m-gate/reply')).toBe(
        true
      )
    );
    const sent = calls.find((c) => c.url === '/api/messages/m-gate/reply');
    expect(new Headers(sent?.init?.headers).get('authorization')).toBe(
      'Bearer tok'
    );
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      choice: 'approve',
      body: 'Approve',
    });
  });

  test('answers a question in words', async () => {
    savePairing({ token: 'tok', device: 'd-1' });
    serve({
      'GET /api/decisions/open': () =>
        json({
          items: [{ id: 'm-q', from: 'run:r-2', body: 'Which database?' }],
        }),
      'GET /api/runs': () => json([]),
      'POST /api/messages/m-q/reply': () => json({ message: {} }, 201),
    });
    renderApp();
    const box = await screen.findByLabelText('Your answer');
    fireEvent.change(box, { target: { value: 'Postgres' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/messages/m-q/reply')).toBe(true)
    );
    const sent = calls.find((c) => c.url === '/api/messages/m-q/reply');
    expect(JSON.parse(sent?.body ?? '')).toEqual({ body: 'Postgres' });
  });

  test('an unpaired phone (401) goes back to the pairing screen', async () => {
    savePairing({ token: 'revoked', device: 'd-1' });
    serve({
      'GET /api/decisions/open': () => json({ error: 'not paired' }, 401),
      'GET /api/runs': () => json({ error: 'not paired' }, 401),
    });
    renderApp();
    await screen.findByLabelText('Pairing code');
    expect(loadPairing()).toBeNull();
  });
});
