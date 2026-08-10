// Ids are exactly 16 lowercase hex chars — the same shape SessionManager
// mints them in (see randomBytes(8).toString('hex') in src/sessions.ts).
const SESSION_PATH = /^\/s\/([0-9a-f]{16})(\/.*)?$/;

export interface ParsedSessionPath {
  id: string;
  kind: 'html' | 'api' | 'ws' | 'alive';
  rest: string;
}

// Rewrites /s/<id>/(api/…|ws|alive|) into the route kind the server should
// dispatch on. Returns null for anything that isn't a well-formed session
// path (wrong id shape, or a suffix none of the known routes own).
export function parseSessionPath(pathname: string): ParsedSessionPath | null {
  const match = SESSION_PATH.exec(pathname);
  if (match === null) return null;
  const id = match[1];
  const rest = match[2] ?? '';
  if (rest === '' || rest === '/') return { id, kind: 'html', rest: '' };
  if (rest === '/alive') return { id, kind: 'alive', rest: '' };
  if (rest === '/ws') return { id, kind: 'ws', rest: '/ws' };
  if (rest.startsWith('/api/')) return { id, kind: 'api', rest };
  return null;
}

/**
 * Forward an /s/<id>/api/* request to the session daemon on 127.0.0.1:port.
 * Strips Origin (the daemon hard-403s non-localhost origins on non-GET
 * requests) and Host (fetch sets its own for the loopback target); preserves
 * method, body, and auth headers; never follows redirects itself.
 */
export async function proxyHttp(
  req: Request,
  port: number,
  apiPath: string
): Promise<Response> {
  const url = new URL(req.url);
  const target = `http://127.0.0.1:${port}${apiPath}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete('origin');
  headers.delete('host');
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    // Required by fetch whenever body is a ReadableStream (streaming a
    // request body implies the request "reads" while it "writes").
    ...(hasBody ? { duplex: 'half' as const } : {}),
    redirect: 'manual',
  });
}
