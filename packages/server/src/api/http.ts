// Shared request/response plumbing for every route module, so a new route
// family (see findings.ts) never needs to redefine JSON body parsing.

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

function hasJsonContentType(req: Request): boolean {
  const contentType = req.headers.get('content-type');
  return (
    contentType !== null &&
    contentType.toLowerCase().startsWith('application/json')
  );
}

// The daemon's only CSRF defence: a cross-origin page can send a preflight-free
// `text/plain`/form/multipart body, but never `application/json`.
export function requireJsonContentType(req: Request): Response | null {
  return hasJsonContentType(req)
    ? null
    : errorResponse(415, 'expected content-type: application/json');
}

export async function readJsonBody(
  req: Request
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const rejected = requireJsonContentType(req);
  if (rejected !== null) return { ok: false, response: rejected };
  try {
    const value = await req.json();
    if (typeof value !== 'object' || value === null) {
      return {
        ok: false,
        response: errorResponse(400, 'invalid body: expected a JSON object'),
      };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid JSON body') };
  }
}

// Same contract as readJsonBody, but an empty body is `{}` rather than a 400.
// The guard runs first: a body-less POST is the very request it exists to stop.
export async function readJsonBodyOptional(
  req: Request
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const rejected = requireJsonContentType(req);
  if (rejected !== null) return { ok: false, response: rejected };
  const text = await req.text();
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (typeof value !== 'object' || value === null) {
      return {
        ok: false,
        response: errorResponse(400, 'invalid body: expected a JSON object'),
      };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid JSON body') };
  }
}

/**
 * Parses an optional non-negative-integer query param (`?limit=`, `?count=`).
 *
 * Rejected rather than clamped when it is not one, so a client bug surfaces as
 * a 400 instead of a silently different-sized result. The blank check runs
 * before Number(), which reads '' and '  ' as 0 — a caller that meant to send
 * a count and sent nothing would otherwise get an empty result and a 200, with
 * no sign anything went wrong.
 */
export function parseCountParam(
  url: URL,
  name: string
): { ok: true; value?: number } | { ok: false; response: Response } {
  const raw = url.searchParams.get(name);
  if (raw === null) return { ok: true };
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      response: errorResponse(
        400,
        `invalid ${name}: ${raw} (expected a non-negative integer)`
      ),
    };
  }
  return { ok: true, value };
}
