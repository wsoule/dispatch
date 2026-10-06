import { afterEach, describe, expect, it } from 'bun:test';

import { createApiClient } from '../src/apiClient.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// The CLI's own client mirrors GET /api/conversations (packages/client too).
describe('getConversation', () => {
  it('GETs /api/conversations with its query', async () => {
    const urls: string[] = [];
    globalThis.fetch = ((input: string) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], next: null }))
      );
    }) as typeof fetch;
    const client = createApiClient('http://127.0.0.1:1', 'tok');
    await client.getConversation({ about: 'task:t-1', limit: 10 });
    await client.getConversation({ with: 'human:sam', before: 'm-2' });
    expect(urls).toEqual([
      'http://127.0.0.1:1/api/conversations?about=task%3At-1&limit=10',
      'http://127.0.0.1:1/api/conversations?with=human%3Asam&before=m-2',
    ]);
  });
});
