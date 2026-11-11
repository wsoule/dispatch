import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readPendingCode, startDeviceLogin } from '../src/login.js';

// dispatch_login says "call again to check". A new MCP process (the client
// restarted) used to start a new device code, replacing the one the person
// was confirming (#237, item 7). The pending code now lives on disk.

const saved = process.env.DISPATCH_HOME;
let home: string;
let server: ReturnType<typeof Bun.serve>;
let issued: number;
let approved: boolean;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-login-'));
  process.env.DISPATCH_HOME = home;
  issued = 0;
  approved = false;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/api/device/code') {
        issued++;
        return Response.json({
          device_code: `dev-${issued}`,
          user_code: `CODE-${issued}`,
          verification_uri: 'http://127.0.0.1/device',
          verification_uri_complete: `http://127.0.0.1/device?code=${issued}`,
          expires_in: 600,
          interval: 0.05,
        });
      }
      if (path === '/api/device/token') {
        const body = (await req.json()) as { device_code: string };
        if (!approved) return Response.json({ error: 'authorization_pending' });
        return Response.json({
          token: `tok-${body.device_code}`,
          handle: 'ana',
          device: 'd1',
          team: { id: 't1', name: 'Acme' },
        });
      }
      return new Response('no', { status: 404 });
    },
  });
});

afterEach(() => {
  void server.stop(true);
  if (saved === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('a pending sign-in', () => {
  it('is picked up by the next start instead of a new code', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const first = await startDeviceLogin(url, 'test');
    const second = await startDeviceLogin(url, 'test');
    if ('error' in first || 'error' in second) throw new Error('no start');
    expect(issued).toBe(1);
    expect(second.userCode).toBe(first.userCode);
    expect(readPendingCode(url)?.device_code).toBe('dev-1');

    approved = true;
    const [a, b] = await Promise.all([first.done, second.done]);
    expect(a.ok && a.team.team.name).toBe('Acme');
    expect(b.ok && b.team.handle).toBe('ana');
    expect(
      existsSync(join(home, '.dispatch', 'hub', 'login-pending.json'))
    ).toBe(false);
  });

  it('is not reused for a different team server', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    await startDeviceLogin(url, 'test');
    expect(readPendingCode('https://elsewhere.example')).toBeNull();
  });
});
