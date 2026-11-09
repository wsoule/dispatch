import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostedDemo } from '../../src/hosting/demo.js';
import { WorkspaceHost } from '../../src/hosting/host.js';

// The public demo on a real daemon: the showcase board, read-only, re-laid
// once it is a few hours old.

const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'web-demo-')));
const host = new WorkspaceHost({
  dataDir,
  entry: join(import.meta.dir, '../../src/hosting/daemonEntry.ts'),
});
afterAll(async () => {
  await host.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const get = (path: string) => new Request(`https://app.test/w/demo${path}`);

describe('HostedDemo', () => {
  let clock = Date.parse('2026-11-08T12:00:00Z');
  const demo = new HostedDemo(host, () => clock);

  it('serves the showcase board, its people and statuses', async () => {
    const tasks = (await (
      await demo.request('/api/tasks?archived=1&fields=meta', get('/api/tasks'))
    ).json()) as { meta: { kind: string; title: string } }[];
    expect(tasks.length).toBeGreaterThan(10);
    expect(tasks.some((t) => t.meta.kind === 'milestone')).toBe(true);
    const people = (await (
      await demo.request('/api/people', get('/api/people'))
    ).json()) as { people: unknown[] };
    expect(people.people.length).toBeGreaterThan(2);
    const config = (await (
      await demo.request('/api/config', get('/api/config'))
    ).json()) as { statuses: string[] };
    expect(config.statuses.length).toBeGreaterThan(2);
  }, 60_000);

  it('is read-only', async () => {
    const res = await demo.request(
      '/api/tasks',
      new Request('https://app.test/w/demo/api/tasks', {
        method: 'POST',
        body: '{"title":"spam"}',
      })
    );
    expect(res.status).toBe(403);
  });

  it('lays the board down again after six hours', async () => {
    const before = await host.ensure('demo');
    clock += 7 * 3_600_000;
    expect((await demo.request('/api/whoami', get('/api/whoami'))).status).toBe(
      200
    );
    const after = await host.ensure('demo');
    expect(after.port).not.toBe(before.port);
  }, 60_000);
});
