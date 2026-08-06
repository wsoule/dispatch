import { applyDiscount } from '../checkout/discount.js';
import { query } from '../db/client.js';
import { search } from '../search/index.js';

export const BUILD_SHA = 'demo';

// Cheap endpoint for the load balancer to poll — task t-71ff03, already done.
export async function health(): Promise<Response> {
  await query('SELECT 1');
  return new Response(JSON.stringify({ ok: true, sha: BUILD_SHA }), {
    status: 200,
  });
}

export async function searchRoute(term: string): Promise<Response> {
  const skus = await search(term);
  return new Response(JSON.stringify({ skus }), { status: 200 });
}

export function checkoutRoute(code: string, subtotal: number): Response {
  return new Response(
    JSON.stringify({ total: applyDiscount(code, subtotal) }),
    { status: 200 }
  );
}

// This project's configured `verify.command` (see the demo generator's
// board.ts) is literally `bun run src/server/routes.ts`, and `verify.url`
// expects something answering at http://localhost:4000/health — so this
// file needs a real listener, not just exported handlers nothing calls.
// Gated on `import.meta.main` so importing these route functions (the test
// suite, or a future caller) never starts a server as a side effect.
if (import.meta.main) {
  Bun.serve({
    port: 4000,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return health();
      if (url.pathname === '/search') {
        return searchRoute(url.searchParams.get('q') ?? '');
      }
      if (url.pathname === '/checkout') {
        return checkoutRoute(
          url.searchParams.get('code') ?? '',
          Number(url.searchParams.get('subtotal') ?? '0')
        );
      }
      return new Response('not found', { status: 404 });
    },
  });
}
