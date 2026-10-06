/**
 * Static server for the marketing site.
 *
 * Bun's own file serving rather than a dependency: it's Astro's build output, and adding a static
 * server package would be more moving parts than the thing it serves. Railway sets PORT; the
 * fallback is only for running it locally.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fileFor } from './serverPaths';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = fileURLToPath(new URL('./dist/', import.meta.url));
const INDEX = resolve(ROOT, 'index.html');

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const path = pathname === '/' ? INDEX : await fileFor(ROOT, pathname);

    if (path !== null) {
      return new Response(Bun.file(path), {
        // Hashed _astro/ assets could take long cache lifetimes, but no-cache
        // revalidation is cheap at this size, so it stays.
        headers: { 'cache-control': 'no-cache' },
      });
    }

    // Everything that is not a real file falls back to index.html, so the site cannot 404 on a
    // path someone shared with a trailing slash or a stale link.
    return new Response(Bun.file(INDEX), {
      status: 404,
      headers: { 'content-type': 'text/html' },
    });
  },
});

console.log(`dispatch site on :${PORT}`);
