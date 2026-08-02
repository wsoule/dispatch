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

export async function readJsonBody(
  req: Request
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!hasJsonContentType(req)) {
    return {
      ok: false,
      response: errorResponse(415, 'expected content-type: application/json'),
    };
  }
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

// Same contract as readJsonBody, but an empty body is `{}` rather than a 400
// — the content-type check only applies once there's a real body to guard.
export async function readJsonBodyOptional(
  req: Request
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const text = await req.text();
  if (text.trim() === '') return { ok: true, value: {} };
  if (!hasJsonContentType(req)) {
    return {
      ok: false,
      response: errorResponse(415, 'expected content-type: application/json'),
    };
  }
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
