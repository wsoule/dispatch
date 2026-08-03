import type { ServerHandle } from '../src/index.js';

// Registering a handle attaches its app token to loopback requests to that port
// that carry no Authorization header of their own, so suites written before
// token auth keep working with the real guard still running on every request.
const tokensByPort = new Map<number, string>();

/** Unpatched fetch, for the tests that must arrive without a token. */
export const rawFetch = globalThis.fetch;

let installed = false;

function portOf(href: string): number | null {
  try {
    const { port } = new URL(href);
    return port === '' ? null : Number(port);
  } catch {
    return null;
  }
}

export function useTestAuth(handle: ServerHandle): void {
  tokensByPort.set(handle.port, handle.tokens.appToken);
  if (installed) return;
  installed = true;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (typeof input === 'string' || input instanceof URL) {
      const port = portOf(String(input));
      const token = port === null ? undefined : tokensByPort.get(port);
      if (token !== undefined) {
        const headers = new Headers(init?.headers);
        if (!headers.has('authorization')) {
          headers.set('authorization', `Bearer ${token}`);
          return rawFetch(input as string, { ...init, headers });
        }
      }
    }
    return rawFetch(input as string, init);
  }) as typeof fetch;
}

// The browser WebSocket API cannot set headers, so /ws also takes the token as
// a query parameter — this builds the URL a test should open.
export function wsUrl(handle: ServerHandle): string {
  return `ws://127.0.0.1:${handle.port}/ws?token=${handle.tokens.appToken}`;
}
