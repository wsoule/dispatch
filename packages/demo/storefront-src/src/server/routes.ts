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
