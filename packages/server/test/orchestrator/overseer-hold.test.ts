import { describe, expect, test } from 'bun:test';

import { overseerHoldFor } from '../../src/orchestrator/overseerHold.js';

const ROOT = '/work/shop';
const bash = (command: string) => overseerHoldFor('Bash', { command }, ROOT);

describe('the Dispatch CLI', () => {
  test.each([
    'dispatch task create "x"',
    'dispatch',
    'cd app && dispatch run t-1',
    'echo hi; dispatch task list',
    'FOO=1 dispatch task save',
    './node_modules/.bin/dispatch task create',
    '/usr/local/bin/dispatch status',
    'bunx dispatch task create',
    'pnpm exec dispatch task create',
    'npx dispatch task create',
    'echo $(dispatch task list)',
    'true || dispatch task drop t-1',
  ])('%p is held', (command) => {
    expect(bash(command)).toBe('dispatch-cli');
  });

  test.each([
    'echo dispatch',
    'grep -rn dispatch src',
    'git log --grep dispatch',
    'cat README.md',
    'ls packages/dispatch-ui',
  ])('%p runs', (command) => {
    expect(bash(command)).toBeNull();
  });
});

describe('the daemon API', () => {
  test.each([
    'curl -s http://127.0.0.1:4321/api/tasks',
    'curl -X POST localhost:57999/api/runs -d {}',
    'wget -qO- http://[::1]:4321/api/decisions',
    'http POST 0.0.0.0:4321/api/messages',
  ])('%p is held', (command) => {
    expect(bash(command)).toBe('daemon-api');
  });

  test('reading the daemon token file is held', () => {
    expect(bash('cat ~/.dispatch/daemons/abc123.json')).toBe('daemon-api');
  });

  test('another site is not the daemon', () => {
    expect(bash('curl -s https://example.com/api/x')).toBeNull();
  });
});

describe('.dispatch/ files', () => {
  test.each([
    ['Write', { file_path: '/work/shop/.dispatch/tasks/t-1.md', content: '' }],
    [
      'Edit',
      { file_path: '.dispatch/config.yml', old_string: 'a', new_string: 'b' },
    ],
    ['MultiEdit', { file_path: '/work/shop/.dispatch/inbox.md', edits: [] }],
    ['NotebookEdit', { notebook_path: '/work/shop/.dispatch/x.ipynb' }],
  ])('%s into .dispatch/ is held', (tool, input) => {
    expect(overseerHoldFor(tool, input, ROOT)).toBe('dispatch-files');
  });

  test.each([
    'rm .dispatch/tasks/t-1.md',
    'sed -i s/a/b/ .dispatch/config.yml',
    'echo x > .dispatch/tasks/t-9.md',
    'mv /work/shop/.dispatch/tasks/a.md b.md',
    'tee -a .dispatch/inbox.md',
  ])('shell writes into .dispatch/ are held: %p', (command) => {
    expect(bash(command)).toBe('dispatch-files');
  });

  test('reading .dispatch/ runs', () => {
    expect(bash('cat .dispatch/tasks/t-1.md')).toBeNull();
    expect(
      overseerHoldFor(
        'Read',
        { file_path: '/work/shop/.dispatch/tasks/t-1.md' },
        ROOT
      )
    ).toBeNull();
  });

  test('editing ordinary files runs', () => {
    expect(
      overseerHoldFor('Edit', { file_path: '/work/shop/src/app.ts' }, ROOT)
    ).toBeNull();
    expect(
      overseerHoldFor(
        'Write',
        { file_path: '/work/shop/docs/dispatch.md' },
        ROOT
      )
    ).toBeNull();
  });
});
