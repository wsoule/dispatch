// Ids are exactly 16 lowercase hex chars — the same shape SessionManager
// mints them in (see randomBytes(8).toString('hex') in src/sessions.ts).
const SESSION_PATH = /^\/s\/([0-9a-f]{16})(\/.*)?$/;

export interface ParsedSessionPath {
  id: string;
  kind: 'html' | 'api' | 'ws' | 'alive';
  rest: string;
}

// Rewrites /s/<id>/(api/…|ws|alive|) into the route kind to dispatch on;
// null for a bad id shape or a suffix none of the known routes own.
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

// Forwards a request to the session daemon on 127.0.0.1:port, stripping
// Origin (daemon 403s non-localhost origins) and Host; never follows redirects.
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
    // WHATWG fetch requires duplex on a streamed body; portability, not a fix.
    ...(hasBody ? { duplex: 'half' as const } : {}),
    redirect: 'manual',
  });
}
