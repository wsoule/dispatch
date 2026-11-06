import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { browserRefusal, normalizeBrowserUrl } from './browserPane';

describe('normalizeBrowserUrl', () => {
  test('a bare port or loopback host opens over http', () => {
    expect(normalizeBrowserUrl('5173')).toBe('http://localhost:5173/');
    expect(normalizeBrowserUrl(':3000/app')).toBe('http://localhost:3000/app');
    expect(normalizeBrowserUrl('localhost:5173')).toBe(
      'http://localhost:5173/'
    );
    expect(normalizeBrowserUrl('127.0.0.1:8080/x?y=1')).toBe(
      'http://127.0.0.1:8080/x?y=1'
    );
  });

  test('any other bare host opens over https, and a full URL is kept', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe(
      'https://example.com/docs'
    );
    expect(normalizeBrowserUrl('  http://example.com ')).toBe(
      'http://example.com/'
    );
  });

  test('refuses what is not an http(s) address', () => {
    for (const text of [
      '',
      'hello world',
      'intranet',
      'file:///etc/passwd',
      'javascript://alert(1)',
    ]) {
      expect([text, normalizeBrowserUrl(text)]).toEqual([text, null]);
    }
  });
});

describe('browserRefusal', () => {
  const origins = {
    app: 'http://localhost:1420',
    daemon: 'http://127.0.0.1:4100',
  };

  test('refuses the app itself and the daemon, and nothing else', () => {
    expect(browserRefusal('http://localhost:1420/x', origins)).toContain(
      'Dispatch itself'
    );
    expect(browserRefusal('http://127.0.0.1:4100/', origins)).toContain(
      'daemon'
    );
    expect(browserRefusal('http://localhost:5173/', origins)).toBeNull();
    expect(
      browserRefusal('http://localhost:5173/', { ...origins, daemon: null })
    ).toBeNull();
  });
});

// `browserRefusal` only sees the address the pane sets; a framed page that
// navigates itself onto the packaged app is stopped by this policy instead.
// The dev server's matching header is proven in e2e/browser-pane-frames.spec.ts.
test("the packaged app's CSP refuses every frame", () => {
  const conf = JSON.parse(
    readFileSync(
      resolve(import.meta.dir, '../../src-tauri/tauri.conf.json'),
      'utf8'
    )
  ) as { app: { security: { csp: Record<string, string> } } };
  expect(conf.app.security.csp['frame-ancestors']).toBe("'none'");
});
