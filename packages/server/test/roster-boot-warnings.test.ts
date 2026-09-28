import { MAX_HANDLE_BYTES, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';

// dispatchd names each team.yml entry it skipped at boot, in a form a
// hand-edited email cannot turn into extra log lines.

let fakeHome: string;
let root: string;
let handle: ServerHandle | null = null;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-roster-warnings-'));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'wyat@example.com']);
  runGitSync(root, ['config', 'user.name', 'Wyat']);
  writeFileSync(join(root, 'README.md'), '# test\n');
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'initial']);
  TaskStore.init(root);
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('skipped roster entries at boot', () => {
  it('names each one, quoted, and says team.yml stays unwritten until it is fixed', async () => {
    writeFileSync(
      join(root, '.dispatch', 'team.yml'),
      [
        'members:',
        `  - handle: ${'a'.repeat(MAX_HANDLE_BYTES + 1)}`,
        '    email: long@x.com',
        '  - handle: no-email',
        '  - handle: Bad',
        '    email: "evil@x.com\\ndispatchd: forged"',
        '',
      ].join('\n')
    );
    const warned: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((...args) => {
      warned.push(args.map(String).join(' '));
    });
    try {
      handle = await startServer({ rootDir: root, port: 0, webDistDir: null });
    } finally {
      warn.mockRestore();
    }

    const lines = warned.filter((line) => line.startsWith('team.yml:'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('skipped the entry for "long@x.com"');
    expect(lines[1]).toContain('skipped an entry with no email');
    expect(lines[2]).toContain(
      'skipped the entry for "evil@x.com\\ndispatchd: forged"'
    );
    // Only a handle whose length is all that is wrong is told to shorten it.
    expect(lines[0]).toContain('its handle is too long: shorten it');
    for (const line of lines.slice(1)) {
      expect(line).toContain('it is malformed: fix it');
      expect(line).not.toContain('shorten');
    }
    for (const line of lines) {
      expect(line).not.toContain('\n');
      expect(line).toContain(`at most ${MAX_HANDLE_BYTES} bytes`);
      expect(line).toContain(
        'until it is fixed, dispatchd will not write team.yml'
      );
    }
  });
});
