import { describe, expect, test } from 'bun:test';

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

  test('refuses every loopback alias of the app and the daemon', () => {
    const aliases = [
      'localhost',
      'LOCALHOST',
      'localhost.',
      '127.0.0.1',
      '127.0.0.1.',
      '127.1',
      '127.42.0.9',
      '2130706433',
      '0x7f.0.0.1',
      '0.0.0.0',
      '[::1]',
      '[0:0:0:0:0:0:0:1]',
      '[::]',
      '[::ffff:127.0.0.1]',
      'foo.localhost',
      'foo.localhost.',
      'tauri.localhost',
    ];
    for (const host of aliases) {
      expect([host, browserRefusal(`http://${host}:1420/`, origins)]).toEqual([
        host,
        expect.stringContaining('Dispatch itself'),
      ]);
      expect([host, browserRefusal(`https://${host}:4100/`, origins)]).toEqual([
        host,
        expect.stringContaining('daemon'),
      ]);
    }
  });

  test('matches on the effective port, defaults included', () => {
    const tauri = { app: 'http://tauri.localhost', daemon: null };
    expect(browserRefusal('http://localhost/', tauri)).toContain('Dispatch');
    expect(browserRefusal('http://127.0.0.1:80/x', tauri)).toContain(
      'Dispatch'
    );
    expect(browserRefusal('https://localhost/', tauri)).toBeNull();
  });

  test('allows a loopback alias on a different port', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'foo.localhost']) {
      expect([host, browserRefusal(`http://${host}:5173/`, origins)]).toEqual([
        host,
        null,
      ]);
    }
  });

  test('leaves non-loopback hosts alone, even on the same port', () => {
    for (const host of [
      'example.com',
      'localhost.example.com',
      '127.0.0.1.nip.io',
      '10.0.0.1',
      '[::2]',
    ]) {
      expect([host, browserRefusal(`http://${host}:1420/`, origins)]).toEqual([
        host,
        null,
      ]);
    }
    const remote = { app: 'https://app.example.com', daemon: null };
    expect(browserRefusal('https://app.example.com./', remote)).toContain(
      'Dispatch'
    );
    expect(browserRefusal('https://localhost/', remote)).toBeNull();
  });

  test("Tauri's tauri:// app origin never matches an http page", () => {
    const app = { app: 'tauri://localhost', daemon: null };
    expect(browserRefusal('http://localhost/', app)).toBeNull();
    expect(browserRefusal('tauri://localhost/', app)).toContain(
      'not a web address'
    );
  });
});
