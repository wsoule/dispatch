import { describe, expect, it } from 'bun:test';

import { ApiError, createApiClient } from '../src/api';

const BASE = 'http://example.test';

// Answers every fetch with one response, recording each call.
function stub(response: () => Response): {
  calls: { url: string; init?: RequestInit }[];
  restore(): void;
} {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(response());
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

// The raw route needs the bearer header like every route, which an element
// `src` cannot send: the preview reads the bytes through this call instead.
describe('workspace file bytes', () => {
  it('reads the raw route with the bearer token and returns the body as a Blob', async () => {
    const s = stub(
      () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png' },
        })
    );
    try {
      const blob = await createApiClient(BASE, 'tok').fetchWorkspaceBlob(
        'img/a b.png',
        { runId: 'run-1' }
      );
      expect(s.calls[0].url).toBe(
        `${BASE}/api/files/raw?path=img%2Fa+b.png&runId=run-1`
      );
      expect(new Headers(s.calls[0].init?.headers).get('authorization')).toBe(
        'Bearer tok'
      );
      // A read: no content-type, so a cross-origin GET stays preflight-free.
      expect(
        new Headers(s.calls[0].init?.headers).get('content-type')
      ).toBeNull();
      expect(blob.type).toBe('image/png');
      expect(blob.size).toBe(4);
    } finally {
      s.restore();
    }
  });

  it('passes the abort signal through, and sends no runId for the checkout', async () => {
    const s = stub(() => new Response('x'));
    try {
      const controller = new AbortController();
      await createApiClient(BASE, 'tok').fetchWorkspaceBlob('a.pdf', {
        runId: null,
        signal: controller.signal,
      });
      expect(s.calls[0].url).toBe(`${BASE}/api/files/raw?path=a.pdf`);
      expect(s.calls[0].init?.signal).toBe(controller.signal);
    } finally {
      s.restore();
    }
  });

  it('throws the server error on a non-2xx, never a blob of the error body', async () => {
    const s = stub(
      () =>
        new Response(JSON.stringify({ error: 'no such file' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
    );
    try {
      const err = await createApiClient(BASE, 'tok')
        .fetchWorkspaceBlob('gone.png')
        .catch((error: unknown) => error);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).message).toBe('no such file');
    } finally {
      s.restore();
    }
  });
});
