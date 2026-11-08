// What crosses the preview proxy: where a request goes, and which headers
// travel in each direction.
//
// A preview is a dev server running out of a run's worktree — code an agent
// just wrote. The proxy sits between it and a browser that holds the daemon's
// credentials, so it must pass through what a page needs to render and
// nothing that would let that code act as, or unseat, the person viewing it.

// Hop-by-hop headers, which belong to one connection and must not be
// forwarded to or from an upstream (RFC 9110 7.6.1). Forwarding
// `connection`/`upgrade` in particular makes Bun's fetch reject the request.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Every cookie the daemon sets is named with this prefix — the session, and
// each preview's own capability. Cookies are scoped to a host, not a port, so
// all of them reach the preview's port too, and a Set-Cookie from a preview
// lands in the daemon's jar.
const DAEMON_COOKIE_PREFIX = 'dispatch_';

/** A Cookie header with the daemon's own cookies taken out, or null when
 *  nothing is left. The app being previewed keeps its own: one that logs its
 *  users in with a cookie must still work inside a preview. */
function withoutDaemonCookies(header: string): string | null {
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith(DAEMON_COOKIE_PREFIX));
  return kept.length === 0 ? null : kept.join('; ');
}

/** A browser's request headers, as the dev server may see them: never the
 *  bearer header, and never a cookie the daemon set. */
export function previewRequestHeaders(headers: Headers): Headers {
  const copy = new Headers();
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name) || name === 'authorization') return;
    if (name === 'cookie') {
      const kept = withoutDaemonCookies(value);
      if (kept !== null) copy.append(key, kept);
      return;
    }
    copy.append(key, value);
  });
  return copy;
}

/** The dev server's response headers, as the browser may see them. A
 *  Set-Cookie naming one of the daemon's cookies is dropped — otherwise the
 *  preview could replace the viewer's session with one of its choosing. */
export function previewResponseHeaders(headers: Headers): Headers {
  const copy = new Headers();
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name)) return;
    if (
      name === 'set-cookie' &&
      value.trimStart().startsWith(DAEMON_COOKIE_PREFIX)
    ) {
      return;
    }
    copy.append(key, value);
  });
  return copy;
}

// The preview tab's iframe flags. Flags intersect with a frame's own, so this
// only takes away what a frame would otherwise keep: its origin.
const PREVIEW_CSP = 'sandbox allow-scripts allow-forms allow-popups';

/** Pins a `/preview/` response to an opaque origin, even in a frame that kept
 *  its own (the browser pane's) and navigated here: on the daemon's origin,
 *  agent code could fetch `/` and read the agent token. */
export function sandboxPreview(response: Response): Response {
  response.headers.append('content-security-policy', PREVIEW_CSP);
  return response;
}

/** The dev server URL a proxied request goes to, or null when it would leave
 *  the preview's port. The path is set on a URL whose host is already fixed:
 *  resolving it against a base instead reads `//host/…` (or `/\\host/…`) as
 *  protocol-relative and sends the daemon's fetch to whatever host it names. */
export function previewUpstreamUrl(
  port: number,
  pathname: string,
  search: string
): URL | null {
  const origin = `127.0.0.1:${port}`;
  const target = new URL(`http://${origin}`);
  target.pathname = pathname;
  target.search = search;
  return target.host === origin ? target : null;
}
