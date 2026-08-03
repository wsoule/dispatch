import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { rawFetch } from './testAuth.js';

// How a browser client gets a token at all (it has no filesystem, so it cannot
// read the daemon file the CLI and MCP read), and how it is allowed to send
// one back from a cross-origin page.

let fakeHome: string;
let root: string;
let webDist: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-static-token-'));
  TaskStore.init(root);
  webDist = mkdtempSync(join(tmpdir(), 'dispatch-web-dist-'));
  writeFileSync(
    join(webDist, 'index.html'),
    '<html><head><title>dispatch</title></head><body><div id="root"></div></body></html>'
  );
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'assets', 'index.js'), 'console.log(1)\n');
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: webDist,
    writeDaemonFile: false,
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(webDist, { recursive: true, force: true });
});

describe('the token dispatchd inlines into the page it serves', () => {
  it('is the agent token, on the index route', async () => {
    const html = await (await rawFetch(`${baseUrl}/`)).text();
    expect(html).toContain(
      `window.__DISPATCH_DAEMON_TOKEN__="${handle.tokens.agentToken}"`
    );
  });

  it('is the agent token on the SPA fallback too, so a deep link works', async () => {
    const html = await (await rawFetch(`${baseUrl}/runs/r-1`)).text();
    expect(html).toContain(
      `window.__DISPATCH_DAEMON_TOKEN__="${handle.tokens.agentToken}"`
    );
  });

  it('is never the app token', async () => {
    for (const path of ['/', '/runs/r-1']) {
      const html = await (await rawFetch(`${baseUrl}${path}`)).text();
      expect(html).not.toContain(handle.tokens.appToken);
    }
  });

  it('does not leak into other static assets', async () => {
    const res = await rawFetch(`${baseUrl}/assets/index.js`);
    const body = await res.text();
    expect(body).toBe('console.log(1)\n');
    expect(body).not.toContain(handle.tokens.agentToken);
  });

  it('rides on a response no shared cache may keep', async () => {
    const res = await rawFetch(`${baseUrl}/`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('does not make the page itself readable to an untrusted origin', async () => {
    const res = await rawFetch(`${baseUrl}/`, {
      headers: { origin: 'http://evil.example' },
    });
    // No CORS header means a browser blocks the page's own JS from reading
    // this body, which is what keeps the inlined token same-origin.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// The desktop webview and the browser dev harness are both cross-origin to
// this daemon, so an `Authorization` header on their requests is preflighted.
// A preflight that does not allow that header makes the browser drop the real
// request before the daemon sees it — every guarded route, for every browser
// client, silently.
describe('the CORS preflight a browser sends before a bearer request', () => {
  it('allows the authorization header for a trusted origin', async () => {
    const res = await rawFetch(`${baseUrl}/api/tasks`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173'
    );
    expect(
      res.headers
        .get('access-control-allow-headers')
        ?.toLowerCase()
        .split(/,\s*/)
    ).toContain('authorization');
  });

  it('allows nothing at all for an untrusted origin', async () => {
    const res = await rawFetch(`${baseUrl}/api/tasks`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-headers')).toBeNull();
  });
});
