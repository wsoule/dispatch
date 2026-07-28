/**
 * Static server for the marketing site.
 *
 * Bun's own file serving rather than a dependency: the site is three files, and adding a static
 * server package would be more moving parts than the thing it serves. Railway sets PORT; the
 * fallback is only for running it locally.
 */
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const INDEX = resolve(ROOT, 'index.html');

/**
 * Maps a request path to a file inside public/, or null if it points anywhere else.
 *
 * This started as `new URL(pathname, publicDir)`, which is wrong in a way worth recording: that
 * constructor resolves URLs, it does not join paths, so a request for `/file:///etc/hosts`
 * carries its own scheme, the base is discarded, and the server hands out an arbitrary file. The
 * `..` case people reach for first was never the hole — the URL parser normalises double-dot
 * segments, including their percent-encoded spellings, before they reach here.
 *
 * So containment is asserted rather than assumed: decode to a plain string, resolve it, and
 * require the result to still sit under ROOT. That does not depend on knowing every parser quirk.
 */
function resolveInRoot(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  const full = resolve(ROOT, `.${decoded}`);
  return full.startsWith(ROOT) || `${full}${sep}` === ROOT ? full : null;
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const path = pathname === '/' ? INDEX : resolveInRoot(pathname);

    if (path !== null) {
      const file = Bun.file(path);
      if (await file.exists()) {
        return new Response(file, {
          // A year of caching is only safe for a filename that changes when its
          // contents do, and nothing here is content-hashed — app.js keeps its
          // name across deploys, so a year would pin visitors to whichever
          // version they happened to load first. Revalidation is cheap at this
          // size; being wrong about it is not.
          headers: { 'cache-control': 'no-cache' },
        });
      }
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
