import { describe, it, expect, beforeAll } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve(import.meta.dirname, '../dist/cli.js');
let repo: string;

async function dispatch(...args: string[]) {
  return execa('node', [BIN, ...args], { cwd: repo });
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'dispatch-e2e-'));
  await execa('git', ['init', '-q'], { cwd: repo });
}, 20_000);

describe('dispatch e2e', () => {
  it('init → create → block → status → next → doctor', async () => {
    await dispatch('init');
    const a = JSON.parse((await dispatch('task', 'create', 'Build parser', '--json')).stdout);
    const b = JSON.parse(
      (await dispatch('task', 'create', 'Use parser', '--blocked-by', a.meta.id, '--json')).stdout,
    );
    let next = JSON.parse((await dispatch('task', 'next', '--json')).stdout);
    expect(next.map((t: { meta: { id: string } }) => t.meta.id)).toEqual([a.meta.id]);

    await dispatch('task', 'status', a.meta.id, 'done');
    next = JSON.parse((await dispatch('task', 'next', '--json')).stdout);
    expect(next.map((t: { meta: { id: string } }) => t.meta.id)).toEqual([b.meta.id]);

    const doctor = await dispatch('doctor');
    expect(doctor.stdout).toContain('ok — 2 tasks checked');

    const status = await execa('git', ['status', '--porcelain'], { cwd: repo });
    expect(status.stdout).toContain('.dispatch/');
  }, 30_000);
});
