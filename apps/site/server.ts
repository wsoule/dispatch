/**
 * Static server for the marketing site.
 *
 * Bun's own file serving rather than a dependency: the site is three files, and adding a static
 * server package would be more moving parts than the thing it serves. Railway sets PORT; the
 * fallback is only for running it locally.
 */
const PORT = Number(process.env.PORT ?? 3000);
const ROOT = new URL('./public/', import.meta.url);

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);
    // Everything that is not a real file falls back to index.html, so the site cannot 404 on a
    // path someone shared with a trailing slash or a stale link.
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = Bun.file(new URL(name, ROOT));
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          'cache-control':
            name === 'index.html' ? 'no-cache' : 'public, max-age=31536000',
        },
      });
    }
    return new Response(Bun.file(new URL('index.html', ROOT)), {
      status: 404,
      headers: { 'content-type': 'text/html' },
    });
  },
});

console.log(`dispatch site on :${PORT}`);
