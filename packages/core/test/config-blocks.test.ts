import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, updateConfig } from '../src/config';

// The settings Settings writes whole or field by field — statuses, verify
// steps, remotes, receipts, sync, previews, CLI agents and the rest — each
// round-trips through config.yml, and a patch the loader would refuse throws
// before anything is written.

function root(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-cfg-blocks-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(dir, '.dispatch', 'config.yml'), contents);
  }
  return dir;
}

function read(dir: string): string {
  return readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8');
}

describe('updateConfig blocks', () => {
  test('statuses are replaced in the order given, a custom one included', () => {
    const dir = root();
    const cfg = updateConfig(dir, {
      statuses: ['draft', ' ready ', 'working', 'qa', 'review', 'landed'],
    });
    expect(cfg.statuses).toEqual([
      'draft',
      'ready',
      'working',
      'qa',
      'review',
      'landed',
    ]);
  });

  test('verify steps are set as a list and removed by an empty one', () => {
    const dir = root();
    expect(
      updateConfig(dir, {
        verifySteps: [
          { name: 'types', command: 'pnpm typecheck' },
          { name: 'tests', command: ' pnpm test ' },
        ],
      }).verifySteps
    ).toEqual([
      { name: 'types', command: 'pnpm typecheck' },
      { name: 'tests', command: 'pnpm test' },
    ]);
    expect(updateConfig(dir, { verifySteps: [] }).verifySteps).toBeUndefined();
  });

  test('a remote is added, changed, and removed by name', () => {
    const dir = root();
    updateConfig(dir, {
      remotes: { box: { host: 'build-box', path: '/srv/repo' } },
    });
    const cfg = updateConfig(dir, {
      remotes: { gpu: { host: 'gpu.internal', user: 'ci', port: 2222 } },
    });
    expect(Object.keys(cfg.remotes ?? {})).toEqual(['box', 'gpu']);
    expect(
      Object.keys(updateConfig(dir, { remotes: { box: null } }).remotes ?? {})
    ).toEqual(['gpu']);
  });

  test('receipts move from a remote to a repo of their own', () => {
    const dir = root('receipts:\n  remote: origin\n');
    const cfg = updateConfig(dir, {
      receipts: { remote: null, repo: 'git@example.com:acme/audit.git' },
    });
    expect(cfg.receipts).toMatchObject({
      repo: 'git@example.com:acme/audit.git',
    });
    expect(cfg.receipts?.remote).toBeUndefined();
  });

  test('sync is switched on and pointed at a repo of its own', () => {
    const dir = root();
    const cfg = updateConfig(dir, {
      sync: { enabled: true, repo: '../board.git', intervalSec: 60 },
    });
    expect(cfg.sync).toMatchObject({
      enabled: true,
      repo: '../board.git',
      intervalSec: 60,
      branch: 'dispatch-sync',
    });
    // Cleared fields fall back to their defaults.
    expect(
      updateConfig(dir, { sync: { intervalSec: null } }).sync?.intervalSec
    ).toBe(30);
  });

  test('previews, the digest, carto and the PR worktree folder', () => {
    const dir = root();
    const cfg = updateConfig(dir, {
      preview: {
        command: 'pnpm dev --port $PORT',
        installCommand: 'pnpm install',
        readyTimeoutSec: 120,
      },
      repoDigest: { enabled: false },
      carto: { enabled: 'off' },
      prWorktreeDir: '../pr-worktrees',
    });
    expect(cfg.preview).toMatchObject({
      enabled: true,
      command: 'pnpm dev --port $PORT',
      installCommand: 'pnpm install',
      readyTimeoutSec: 120,
    });
    expect(cfg.repoDigest.enabled).toBe(false);
    expect(cfg.carto.enabled).toBe('off');
    expect(cfg.prWorktreeDir).toBe('../pr-worktrees');
    // An emptied text field removes the key rather than writing "".
    expect(
      updateConfig(dir, { preview: { command: '' }, prWorktreeDir: '' })
        .prWorktreeDir
    ).toBeUndefined();
    expect(loadConfig(dir).preview?.command).toBeUndefined();
  });

  test('a CLI agent is declared, changed, and removed', () => {
    const dir = root();
    updateConfig(dir, {
      executors: {
        gemini: {
          command: { run: ['gemini', '-p', '{prompt}'] },
          models: { execute: 'gemini-2.5-pro' },
        },
      },
    });
    expect(loadConfig(dir).executors?.gemini?.command?.run).toEqual([
      'gemini',
      '-p',
      '{prompt}',
    ]);
    updateConfig(dir, { executors: { gemini: null } });
    expect(loadConfig(dir).executors?.gemini).toBeUndefined();
  });

  // A block whose keys are all commented out holds null, which the loader
  // reads as absent; a save into it used to be refused by the YAML library.
  test('writes into a block left with no value, keeping its comments', () => {
    const dir = root(
      'carto:\n  # enabled: detect\norchestrator: # tuned later\npolicy:\n  gates:\n'
    );
    const cfg = updateConfig(dir, {
      carto: { enabled: 'off' },
      epicConcurrency: 2,
      policy: { gates: { merge: 'auto' } },
    });
    expect(cfg.carto.enabled).toBe('off');
    expect(cfg.orchestrator.epicConcurrency).toBe(2);
    expect(cfg.policy?.gates.merge).toBe('auto');
    const text = read(dir);
    expect(text).toContain('# enabled: detect');
    expect(text).toContain('# tuned later');
  });

  test('a patch the loader would refuse throws, and the file stays as it was', () => {
    const before = 'sync:\n  enabled: true\n  remote: origin\n';
    for (const bad of [
      // Two places at once.
      { sync: { repo: 'git@example.com:acme/b.git' } },
      // Below the minimum interval.
      { sync: { intervalSec: 1 } },
      // A URL where a remote's name goes.
      { receipts: { remote: 'https://example.com/audit.git' } },
      // Not a mode carto knows.
      { carto: { enabled: 'sometimes' as never } },
      // A verify step with no command.
      { verifySteps: [{ name: 'tests', command: '' }] },
    ]) {
      const dir = root(before);
      expect(() => updateConfig(dir, bad)).toThrow();
      expect(read(dir)).toBe(before);
    }
  });
});
