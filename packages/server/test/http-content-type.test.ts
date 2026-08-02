import { describe, expect, it } from 'bun:test';

import {
  readJsonBody,
  readJsonBodyOptional,
  requireJsonContentType,
} from '../src/api/http.js';

// A CORS-simple request: no preflight, so the browser never consults the
// daemon's origin allowlist and the handler runs whatever the origin was.
function simpleRequest(init: RequestInit = {}): Request {
  return new Request('http://127.0.0.1:1234/api/git/stash', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    ...init,
  });
}

describe('readJsonBodyOptional guards content-type before the empty-body shortcut', () => {
  it('415s a body-less POST rather than treating it as {}', async () => {
    const parsed = await readJsonBodyOptional(simpleRequest());

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected a rejection');
    expect(parsed.response.status).toBe(415);
  });

  it('415s a whitespace-only body', async () => {
    const parsed = await readJsonBodyOptional(simpleRequest({ body: '   \n' }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected a rejection');
    expect(parsed.response.status).toBe(415);
  });

  it('415s a CORS-simple content-type', async () => {
    const parsed = await readJsonBodyOptional(
      simpleRequest({
        headers: { 'content-type': 'text/plain' },
        body: '{"remote":"https://attacker.example/x.git"}',
      })
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected a rejection');
    expect(parsed.response.status).toBe(415);
  });

  it('still treats an empty body as {} once the content-type is declared', async () => {
    const parsed = await readJsonBodyOptional(
      simpleRequest({ headers: { 'content-type': 'application/json' } })
    );

    expect(parsed).toEqual({ ok: true, value: {} });
  });

  it('still parses a real JSON body', async () => {
    const parsed = await readJsonBodyOptional(
      simpleRequest({
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: '{"message":"wip"}',
      })
    );

    expect(parsed).toEqual({ ok: true, value: { message: 'wip' } });
  });
});

describe('requireJsonContentType', () => {
  it('415s a request with no content-type at all', () => {
    const rejected = requireJsonContentType(simpleRequest());

    expect(rejected).not.toBeNull();
    expect(rejected?.status).toBe(415);
  });

  it('passes a request declaring application/json', () => {
    expect(
      requireJsonContentType(
        simpleRequest({ headers: { 'content-type': 'application/json' } })
      )
    ).toBeNull();
  });
});

describe('readJsonBody keeps its strict content-type check', () => {
  it('415s a body-less POST', async () => {
    const parsed = await readJsonBody(simpleRequest());

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected a rejection');
    expect(parsed.response.status).toBe(415);
  });
});
