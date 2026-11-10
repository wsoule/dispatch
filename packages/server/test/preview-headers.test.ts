import { describe, expect, test } from 'bun:test';

import {
  previewRequestHeaders,
  previewResponseHeaders,
  previewUpstreamUrl,
  sandboxPreview,
} from '../src/previewHeaders.js';

describe('previewRequestHeaders', () => {
  test('never hands the dev server the viewer’s credentials', () => {
    const out = previewRequestHeaders(
      new Headers({
        cookie: 'dispatch_session=tok; dispatch_preview_5173=cap',
        authorization: 'Bearer tok',
        accept: 'text/html',
      })
    );
    expect(out.get('cookie')).toBeNull();
    expect(out.get('authorization')).toBeNull();
    expect(out.get('accept')).toBe('text/html');
  });

  test('the app being previewed keeps its own cookies', () => {
    const out = previewRequestHeaders(
      new Headers({ cookie: 'sid=app-login; dispatch_session=tok; theme=dark' })
    );
    expect(out.get('cookie')).toBe('sid=app-login; theme=dark');
  });

  test('still drops hop-by-hop headers', () => {
    const out = previewRequestHeaders(
      new Headers({ connection: 'keep-alive', upgrade: 'websocket' })
    );
    expect(out.get('connection')).toBeNull();
    expect(out.get('upgrade')).toBeNull();
  });
});

describe('previewResponseHeaders', () => {
  test('a dev server cannot set the daemon’s cookies, but can set its own', () => {
    const upstream = new Headers({ 'content-type': 'text/html' });
    upstream.append('set-cookie', 'dispatch_session=theirs; Path=/');
    upstream.append('set-cookie', 'sid=app; Path=/; HttpOnly');
    upstream.append('set-cookie', ' dispatch_preview_1=x; Path=/');

    const out = previewResponseHeaders(upstream);

    // Several Set-Cookie headers stay separate through the filter rather than
    // being folded into one comma-joined value it could not tell apart.
    expect(out.getSetCookie()).toEqual(['sid=app; Path=/; HttpOnly']);
    expect(out.get('content-type')).toBe('text/html');
  });
});

describe('previewUpstreamUrl', () => {
  test('keeps the path and query, on the preview’s own port', () => {
    expect(previewUpstreamUrl(5173, '/src/main.ts', '?t=1')?.href).toBe(
      'http://127.0.0.1:5173/src/main.ts?t=1'
    );
  });

  test('a path that looks protocol-relative cannot change the host', () => {
    for (const path of [
      '//evil.example/x',
      '/\\evil.example/x',
      '\\\\evil.example/x',
      '///evil.example',
      '//127.0.0.1:1/x',
    ]) {
      const target = previewUpstreamUrl(5173, path, '?y=1');
      expect(target?.host).toBe('127.0.0.1:5173');
      expect(target?.search).toBe('?y=1');
    }
  });
});

describe('sandboxPreview', () => {
  test('adds an opaque-origin sandbox and keeps the dev server’s own policy', () => {
    const res = sandboxPreview(
      new Response('', {
        headers: { 'content-security-policy': "default-src 'self'" },
      })
    );
    const policies = res.headers.get('content-security-policy')?.split(/,\s*/);
    expect(policies).toEqual([
      "default-src 'self'",
      'sandbox allow-scripts allow-forms allow-popups',
    ]);
    expect(policies?.some((p) => p.includes('allow-same-origin'))).toBe(false);
  });
});
