import { isLoopbackAddress } from './shared.js';

// Below this a response is a few packets, and compressing it is pure cost.
const MIN_COMPRESSED_BYTES = 32 * 1024;
// Measured on the 2000-task meta list (1.1MB): level 2 takes 2.4ms for 70KB,
// level 6 takes 7ms for 49KB, and the daemon compresses on its one thread.
const GZIP_LEVEL = 2;

// Whether an Accept-Encoding header admits gzip (named, or `*`, with q > 0).
function acceptsGzip(header: string | null): boolean {
  if (header === null) return false;
  return header.split(',').some((part) => {
    const [coding = '', ...params] = part.split(';').map((s) => s.trim());
    if (coding.toLowerCase() !== 'gzip' && coding !== '*') return false;
    const q = params.find((p) => p.toLowerCase().startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/**
 * Gzips a large JSON response for a client on another machine: a teammate
 * reaching this daemon in team-local mode. A loopback client (the desktop
 * app, the CLI, MCP) gets it untouched. Reading the 1.1MB meta list over
 * loopback took 9ms plain against 12ms gzipped in WKWebView (the desktop's
 * engine) and 13.8ms against 15.8ms in Chromium; over an emulated 100 megabit
 * link, Chromium took 138ms plain against 33ms gzipped.
 *
 * `peer` is the client's address, or null when the transport has none.
 */
export async function compressForNetwork(
  req: Request,
  res: Response,
  peer: string | null
): Promise<Response> {
  if (peer === null || isLoopbackAddress(peer)) return res;
  if (res.headers.has('content-encoding')) return res;
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('application/json')) return res;
  if (!acceptsGzip(req.headers.get('accept-encoding'))) return res;
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength < MIN_COMPRESSED_BYTES) {
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  const headers = new Headers(res.headers);
  headers.set('content-encoding', 'gzip');
  headers.append('vary', 'accept-encoding');
  headers.delete('content-length');
  return new Response(Bun.gzipSync(body, { level: GZIP_LEVEL }), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
