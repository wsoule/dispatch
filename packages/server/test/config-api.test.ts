import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

let root: string;
let handle: ServerHandle;
let baseUrl: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-config-api-'));
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

function patchConfig(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Both blocks previously had a ConfigPatch field with no caller in
// patchConfig's whitelist — these prove the route actually forwards them.
describe('PATCH /api/config — verify', () => {
  it('writes the verify block and it round-trips through GET', async () => {
    const res = await patchConfig({
      verify: { command: 'bun run dev', url: 'http://localhost:3000' },
    });
    expect(res.status).toBe(200);
    const config = await json<{ verify: { command: string; url: string } }>(
      res
    );
    expect(config.verify).toEqual({
      command: 'bun run dev',
      url: 'http://localhost:3000',
    });
    const file = readFileSync(join(root, '.dispatch', 'config.yml'), 'utf8');
    expect(file).toContain('bun run dev');
  });

  it('400s an unknown verify field without writing anything', async () => {
    const res = await patchConfig({ verify: { comand: 'bun run dev' } });
    expect(res.status).toBe(400);
    const file = readFileSync(join(root, '.dispatch', 'config.yml'), 'utf8');
    expect(file).not.toContain('bun run dev');
  });
});

describe('PATCH /api/config — fixLoop', () => {
  it('writes a cap change and it round-trips through GET', async () => {
    const res = await patchConfig({ fixLoop: { cap: 2 } });
    expect(res.status).toBe(200);
    const config = await json<{ fixLoop: { cap: number } }>(res);
    expect(config.fixLoop.cap).toBe(2);
  });

  it('400s a non-integer cap without writing anything', async () => {
    const res = await patchConfig({ fixLoop: { cap: 0 } });
    expect(res.status).toBe(400);
    const file = readFileSync(join(root, '.dispatch', 'config.yml'), 'utf8');
    expect(file).not.toContain('fixLoop');
  });
});
