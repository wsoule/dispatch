import { describe, expect, it } from 'bun:test';

import { createApiClient } from '../src/api';
import type { ApiClient } from '../src/api';

// Captures the (url, init) a stubbed `fetch` was called with. Mirrors
// api.test.ts's helper — kept local since neither helper is exported.
function stubFetch(responseBody: unknown = {}): {
  calls: Array<{ url: string; init?: RequestInit }>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((
    url: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

// Parses a stubbed call's JSON body back into an object for assertion.
function sentJson(call: { init?: RequestInit }): unknown {
  const body = call.init?.body;
  if (typeof body !== 'string') {
    throw new Error(`expected a JSON string body, got ${typeof body}`);
  }
  return JSON.parse(body);
}

const BASE = 'http://example.test';

// These bindings must hit the exact routes packages/server/src/messaging/
// routes.ts registers, with the request shape its handlers parse and every
// address/channel-name path segment percent-encoded.
describe('sendMessage', () => {
  it('POSTs /api/messages with the SendInput body', async () => {
    const stub = stubFetch();
    try {
      const client: ApiClient = createApiClient(BASE);
      await client.sendMessage({
        to: ['agent:wyat/x'],
        kind: 'message',
        body: 'hi',
      });
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].url).toBe(`${BASE}/api/messages`);
      expect(stub.calls[0].init?.method).toBe('POST');
      expect(sentJson(stub.calls[0])).toEqual({
        to: ['agent:wyat/x'],
        kind: 'message',
        body: 'hi',
      });
      const headers = new Headers(stub.calls[0].init?.headers);
      expect(headers.has('idempotency-key')).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it('sends the Idempotency-Key header when given', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).sendMessage(
        { to: ['agent:wyat/x'], kind: 'message', body: 'hi' },
        { idempotencyKey: 'key-1' }
      );
      const headers = new Headers(stub.calls[0].init?.headers);
      expect(headers.get('idempotency-key')).toBe('key-1');
    } finally {
      stub.restore();
    }
  });
});

describe('getMessage', () => {
  it('GETs /api/messages/:id', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).getMessage('m-abc123');
      expect(stub.calls[0].url).toBe(`${BASE}/api/messages/m-abc123`);
      expect(stub.calls[0].init?.method).toBeUndefined();
    } finally {
      stub.restore();
    }
  });
});

describe('replyToMessage', () => {
  it('POSTs /api/messages/:id/reply with the reply body', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).replyToMessage('m-abc123', {
        body: 'sure',
        choice: 'approve',
      });
      expect(stub.calls[0].url).toBe(`${BASE}/api/messages/m-abc123/reply`);
      expect(stub.calls[0].init?.method).toBe('POST');
      expect(sentJson(stub.calls[0])).toEqual({
        body: 'sure',
        choice: 'approve',
      });
    } finally {
      stub.restore();
    }
  });
});

describe('waitForAnswer', () => {
  it('GETs /api/messages/:id/answer with no query when wait is omitted', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).waitForAnswer('m-abc123');
      expect(stub.calls[0].url).toBe(`${BASE}/api/messages/m-abc123/answer`);
    } finally {
      stub.restore();
    }
  });

  it('appends ?wait=1 when wait is true', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).waitForAnswer('m-abc123', { wait: true });
      expect(stub.calls[0].url).toBe(
        `${BASE}/api/messages/m-abc123/answer?wait=1`
      );
    } finally {
      stub.restore();
    }
  });
});

describe('getThread', () => {
  it('GETs /api/threads/:id', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).getThread('m-root1');
      expect(stub.calls[0].url).toBe(`${BASE}/api/threads/m-root1`);
    } finally {
      stub.restore();
    }
  });
});

describe('listRecentThreads', () => {
  it('GETs /api/threads with no query when limit is omitted', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).listRecentThreads();
      expect(stub.calls[0].url).toBe(`${BASE}/api/threads`);
    } finally {
      stub.restore();
    }
  });

  it('appends ?limit=N when given', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).listRecentThreads(25);
      expect(stub.calls[0].url).toBe(`${BASE}/api/threads?limit=25`);
    } finally {
      stub.restore();
    }
  });
});

describe('getMailbox', () => {
  it('GETs /api/mailbox with no query by default', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).getMailbox();
      expect(stub.calls[0].url).toBe(`${BASE}/api/mailbox`);
    } finally {
      stub.restore();
    }
  });

  it('encodes an explicit address and joins states with a comma', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).getMailbox('agent:wyat/x', [
        'held',
        'pushed',
      ]);
      expect(stub.calls[0].url).toBe(
        `${BASE}/api/mailbox?address=agent%3Awyat%2Fx&state=held%2Cpushed`
      );
    } finally {
      stub.restore();
    }
  });
});

describe('markDeliveryRead', () => {
  it('POSTs /api/deliveries/:id/read', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).markDeliveryRead('d-abc123');
      expect(stub.calls[0].url).toBe(`${BASE}/api/deliveries/d-abc123/read`);
      expect(stub.calls[0].init?.method).toBe('POST');
    } finally {
      stub.restore();
    }
  });
});

describe('listChannels', () => {
  it('GETs /api/channels', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).listChannels();
      expect(stub.calls[0].url).toBe(`${BASE}/api/channels`);
    } finally {
      stub.restore();
    }
  });
});

describe('joinChannel', () => {
  it('POSTs /api/channels/:name/members with an encoded channel name and no member when omitted', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).joinChannel('epic/e-abc123');
      expect(stub.calls[0].url).toBe(
        `${BASE}/api/channels/epic%2Fe-abc123/members`
      );
      expect(stub.calls[0].init?.method).toBe('POST');
      expect(sentJson(stub.calls[0])).toEqual({});
    } finally {
      stub.restore();
    }
  });

  it('includes member in the body when given', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).joinChannel('epic/e-abc123', 'agent:wyat/x');
      expect(sentJson(stub.calls[0])).toEqual({ member: 'agent:wyat/x' });
    } finally {
      stub.restore();
    }
  });
});

describe('leaveChannel', () => {
  it('DELETEs /api/channels/:name/members/:addr with both segments encoded', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).leaveChannel('epic/e-abc123', 'agent:wyat/x');
      expect(stub.calls[0].url).toBe(
        `${BASE}/api/channels/epic%2Fe-abc123/members/agent%3Awyat%2Fx`
      );
      expect(stub.calls[0].init?.method).toBe('DELETE');
    } finally {
      stub.restore();
    }
  });
});

describe('listAgentRoster', () => {
  it('GETs /api/agents/roster', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).listAgentRoster();
      expect(stub.calls[0].url).toBe(`${BASE}/api/agents/roster`);
    } finally {
      stub.restore();
    }
  });
});

describe('agent decisions', () => {
  it('approveAgent POSTs /api/agents/:addr/approve with the address encoded', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).approveAgent('agent:wyat/x');
      expect(stub.calls[0].url).toBe(
        `${BASE}/api/agents/agent%3Awyat%2Fx/approve`
      );
      expect(stub.calls[0].init?.method).toBe('POST');
    } finally {
      stub.restore();
    }
  });

  it('revokeAgent POSTs /api/agents/:addr/revoke', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).revokeAgent('agent:wyat/x');
      expect(stub.calls[0].url).toBe(
        `${BASE}/api/agents/agent%3Awyat%2Fx/revoke`
      );
    } finally {
      stub.restore();
    }
  });

  it('muteAgent(addr, true) POSTs .../mute', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).muteAgent('agent:wyat/x', true);
      expect(stub.calls[0].url).toBe(
        `${BASE}/api/agents/agent%3Awyat%2Fx/mute`
      );
    } finally {
      stub.restore();
    }
  });

  it('muteAgent(addr, false) POSTs .../unmute', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).muteAgent('agent:wyat/x', false);
      expect(stub.calls[0].url).toBe(
        `${BASE}/api/agents/agent%3Awyat%2Fx/unmute`
      );
    } finally {
      stub.restore();
    }
  });
});

describe('openDecisions', () => {
  it('GETs /api/decisions/open', async () => {
    const stub = stubFetch();
    try {
      await createApiClient(BASE).openDecisions();
      expect(stub.calls[0].url).toBe(`${BASE}/api/decisions/open`);
    } finally {
      stub.restore();
    }
  });
});
