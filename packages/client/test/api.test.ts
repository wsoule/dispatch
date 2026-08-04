import { describe, expect, it } from 'bun:test';

import type { ApiClient, TaskDraft } from '../src/api';
import {
  createApiClient,
  httpToWs,
  taskDraftToCreateInput,
  taskQueryString,
} from '../src/api';

// Captures the (url, init) a stubbed `fetch` was called with, so a test can
// inspect exactly what a client method sent without a real network call.
function stubFetch(): {
  calls: Array<{ url: string; init?: RequestInit }>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    url: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe('httpToWs', () => {
  it('swaps http for ws and appends /ws', () => {
    expect(httpToWs('http://127.0.0.1:4771')).toBe('ws://127.0.0.1:4771/ws');
  });

  it('swaps https for wss and appends /ws', () => {
    expect(httpToWs('https://dispatch.example')).toBe(
      'wss://dispatch.example/ws'
    );
  });
});

describe('taskQueryString', () => {
  it('returns an empty string with no filter', () => {
    expect(taskQueryString()).toBe('');
    expect(taskQueryString({})).toBe('');
  });

  it('encodes a single filter field', () => {
    expect(taskQueryString({ status: 'todo' })).toBe('?status=todo');
  });

  it('encodes multiple filter fields in status/kind/parent order', () => {
    expect(
      taskQueryString({ status: 'todo', kind: 'task', parent: 'epic-1' })
    ).toBe('?status=todo&kind=task&parent=epic-1');
  });

  it('emits archived=1 only when archived is true', () => {
    expect(taskQueryString({ archived: true })).toBe('?archived=1');
    expect(taskQueryString({ archived: false })).toBe('');
  });
});

describe('taskDraftToCreateInput', () => {
  it('folds acceptanceCriteria into the description (createTask ignores a separate field)', () => {
    const draft: TaskDraft = {
      title: 'Add a logout button',
      description: 'Let signed-in users end their session.',
      acceptanceCriteria: [
        'Button visible in the header',
        'Click clears the session',
      ],
      priority: 'high',
    };
    expect(taskDraftToCreateInput(draft)).toEqual({
      title: 'Add a logout button',
      kind: 'task',
      priority: 'high',
      description:
        'Let signed-in users end their session.\n\n' +
        'Acceptance criteria:\n\n' +
        '- Button visible in the header\n- Click clears the session',
    });
  });

  it('emits a bare description when the draft has no acceptanceCriteria', () => {
    const draft: TaskDraft = {
      title: 'Tiny tweak',
      description: 'Just do the thing.',
      acceptanceCriteria: [],
      priority: 'none',
    };
    expect(taskDraftToCreateInput(draft)).toEqual({
      title: 'Tiny tweak',
      kind: 'task',
      priority: 'none',
      description: 'Just do the thing.',
    });
  });
});

// Regression coverage: several ApiClient methods skip jsonBody() and pass a
// bare `body`, relying entirely on request() to default the header.
describe('request() defaults content-type: application/json for a JSON body', () => {
  it('adds the header for a POST built without jsonBody() (addInbox)', async () => {
    const stub = stubFetch();
    try {
      await createApiClient('http://example.test').addInbox({ text: 'hi' });
      expect(stub.calls).toHaveLength(1);
      const headers = new Headers(stub.calls[0].init?.headers);
      expect(headers.get('content-type')).toBe('application/json');
    } finally {
      stub.restore();
    }
  });

  it('adds the header for a PATCH built without jsonBody() (updateConfig)', async () => {
    const stub = stubFetch();
    try {
      await createApiClient('http://example.test').updateConfig({});
      expect(stub.calls).toHaveLength(1);
      const headers = new Headers(stub.calls[0].init?.headers);
      expect(headers.get('content-type')).toBe('application/json');
    } finally {
      stub.restore();
    }
  });
});

// The header has to be unconditional on writes, not body-conditional: while a
// body-less POST arrived without it, the server's content-type check could never
// be promoted from the body readers to a blanket router-level guard.
describe('request() declares content-type on every state-changing request', () => {
  const bodyless: Array<[string, (c: ApiClient) => Promise<unknown>]> = [
    ['POST /api/git/pull', (c) => c.gitPull()],
    ['POST /api/inbox/cluster', (c) => c.clusterInbox()],
    ['POST /api/runs/:id/cancel', (c) => c.cancelRun('run-1')],
    ['POST /api/runs/:id/stop', (c) => c.stopRun('run-1')],
    ['POST /api/runs/:id/resume', (c) => c.resumeRun('run-1')],
    ['POST /api/notes/:id/enrich', (c) => c.enrichNote('note-1')],
    ['POST /api/merge-queue/ready', (c) => c.enqueueMergeReady()],
    ['DELETE /api/notes/:id', (c) => c.deleteNote('note-1')],
  ];

  for (const [label, call] of bodyless) {
    it(`sends the header on a body-less ${label}`, async () => {
      const stub = stubFetch();
      try {
        await call(createApiClient('http://example.test'));
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0].init?.body).toBeUndefined();
        const headers = new Headers(stub.calls[0].init?.headers);
        expect(headers.get('content-type')).toBe('application/json');
      } finally {
        stub.restore();
      }
    });
  }

  // A content-type on a GET would make it a non-simple cross-origin request and
  // buy a preflight for a request that carries nothing.
  it('leaves a read with no content-type header at all', async () => {
    const stub = stubFetch();
    try {
      await createApiClient('http://example.test').fetchGitStatus();
      expect(stub.calls).toHaveLength(1);
      const headers = new Headers(stub.calls[0].init?.headers);
      expect(headers.has('content-type')).toBe(false);
    } finally {
      stub.restore();
    }
  });
});
