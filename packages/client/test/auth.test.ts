import { afterEach, describe, expect, it } from 'bun:test';

import {
  ApiError,
  connectEvents,
  createApiClient,
  isInsufficientTier,
  wsUrl,
} from '../src/api';
import type { SocketLike } from '../src/api';

// Captures the (url, init) every stubbed `fetch` was called with, so a test can
// assert on the exact headers a client method sent.
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

function authOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization');
}

// A socket that records nothing but the URL it was asked to open — enough to
// assert what `connectEvents` put in the query string.
function recordingSocket(urls: string[]): (url: string) => SocketLike {
  return (url) => {
    urls.push(url);
    return {
      addEventListener: () => {},
      close: () => {},
    } as SocketLike;
  };
}

const globals = globalThis as { __DISPATCH_DAEMON_TOKEN__?: unknown };

afterEach(() => {
  delete globals.__DISPATCH_DAEMON_TOKEN__;
});

describe('bearer token on every API call', () => {
  it('sends the client token on a read', async () => {
    const fetches = stubFetch();
    try {
      await createApiClient('http://d.test', 'agent-tok').fetchTasks();
      expect(authOf(fetches.calls[0]?.init)).toBe('Bearer agent-tok');
    } finally {
      fetches.restore();
    }
  });

  it('sends the client token on a state change, alongside content-type', async () => {
    const fetches = stubFetch();
    try {
      await createApiClient('http://d.test', 'agent-tok').addInbox({
        text: 'hi',
      });
      const headers = new Headers(fetches.calls[0]?.init?.headers);
      expect(headers.get('authorization')).toBe('Bearer agent-tok');
      expect(headers.get('content-type')).toBe('application/json');
    } finally {
      fetches.restore();
    }
  });

  it('sends the app token when the client was built with one', async () => {
    const fetches = stubFetch();
    try {
      await createApiClient('http://d.test', 'app-tok').decideScopeRequest(
        'r-1',
        'sr-1',
        true
      );
      expect(fetches.calls[0]?.url).toBe(
        'http://d.test/api/runs/r-1/scope-requests/sr-1/decide'
      );
      expect(authOf(fetches.calls[0]?.init)).toBe('Bearer app-tok');
    } finally {
      fetches.restore();
    }
  });

  it('sends no authorization header at all when no token is available', async () => {
    const fetches = stubFetch();
    try {
      await createApiClient('http://d.test').fetchTasks();
      expect(authOf(fetches.calls[0]?.init)).toBeNull();
    } finally {
      fetches.restore();
    }
  });
});

describe("the auth failure's stable code", () => {
  // Stub fetch that answers one auth error, so a test can assert what the
  // thrown ApiError carried out of it.
  function stubAuthError(status: number, code: string): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'some prose', code }), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    return () => (globalThis.fetch = original);
  }

  it('reaches the caller on a 403, so a client can key on it rather than the prose', async () => {
    const restore = stubAuthError(403, 'auth_insufficient_tier');
    try {
      const err = await createApiClient('http://d.test', 'agent-tok')
        .decideScopeRequest('r-1', 'sr-1', true)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(403);
      expect((err as ApiError).code).toBe('auth_insufficient_tier');
      expect(isInsufficientTier(err)).toBe(true);
    } finally {
      restore();
    }
  });

  it('does not mistake a 401 for a tier problem', async () => {
    const restore = stubAuthError(401, 'auth_missing_token');
    try {
      const err = await createApiClient('http://d.test')
        .fetchTasks()
        .catch((e: unknown) => e);
      expect((err as ApiError).code).toBe('auth_missing_token');
      expect(isInsufficientTier(err)).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('token injected into the served page', () => {
  it('is used when the caller passes none', async () => {
    globals.__DISPATCH_DAEMON_TOKEN__ = 'injected-tok';
    const fetches = stubFetch();
    try {
      await createApiClient('http://d.test').fetchTasks();
      expect(authOf(fetches.calls[0]?.init)).toBe('Bearer injected-tok');
    } finally {
      fetches.restore();
    }
  });

  it('loses to an explicit token', async () => {
    globals.__DISPATCH_DAEMON_TOKEN__ = 'injected-tok';
    const fetches = stubFetch();
    try {
      await createApiClient('http://d.test', 'explicit-tok').fetchTasks();
      expect(authOf(fetches.calls[0]?.init)).toBe('Bearer explicit-tok');
    } finally {
      fetches.restore();
    }
  });

  it('is ignored when it is not a non-empty string', async () => {
    globals.__DISPATCH_DAEMON_TOKEN__ = '';
    const fetches = stubFetch();
    try {
      await createApiClient('http://d.test').fetchTasks();
      expect(authOf(fetches.calls[0]?.init)).toBeNull();
    } finally {
      fetches.restore();
    }
  });
});

describe('the websocket token', () => {
  it('rides in the query string, since a WebSocket sets no headers', () => {
    expect(wsUrl('http://127.0.0.1:4771', 'agent tok/1')).toBe(
      'ws://127.0.0.1:4771/ws?token=agent%20tok%2F1'
    );
  });

  it('is absent from the URL when there is no token', () => {
    expect(wsUrl('http://127.0.0.1:4771')).toBe('ws://127.0.0.1:4771/ws');
  });

  it('reaches the socket connectEvents opens', () => {
    const urls: string[] = [];
    const dispose = connectEvents('http://127.0.0.1:4771', () => {}, {
      createSocket: recordingSocket(urls),
      token: 'agent-tok',
    });
    dispose();
    expect(urls).toEqual(['ws://127.0.0.1:4771/ws?token=agent-tok']);
  });

  it('reaches the socket a bound client opens', () => {
    const urls: string[] = [];
    const dispose = createApiClient(
      'http://127.0.0.1:4771',
      'agent-tok'
    ).connectEvents(() => {}, { createSocket: recordingSocket(urls) });
    dispose();
    expect(urls).toEqual(['ws://127.0.0.1:4771/ws?token=agent-tok']);
  });
});
