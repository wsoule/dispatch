import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore, isSubjectRef } from '../src/conversations';

let fakeHome: string;
const original = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});
afterEach(() => {
  if (original === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = original;
  rmSync(fakeHome, { recursive: true, force: true });
});

function root(): string {
  return mkdtempSync(join(tmpdir(), 'dispatch-conv-'));
}

describe('isSubjectRef', () => {
  test('accepts the three subject kinds', () => {
    expect(isSubjectRef('run:r-abc123')).toBe(true);
    expect(isSubjectRef('worktree:/Users/x/proj')).toBe(true);
    expect(isSubjectRef('pr:42')).toBe(true);
  });

  test('rejects anything else, including a bare id', () => {
    expect(isSubjectRef('r-abc123')).toBe(false);
    expect(isSubjectRef('session:1')).toBe(false);
    expect(isSubjectRef('run:')).toBe(false);
    expect(isSubjectRef(42)).toBe(false);
  });
});

describe('ConversationStore', () => {
  test('adds and reads back across instances', () => {
    const dir = root();
    new ConversationStore(dir).add('run:r-1', {
      role: 'human',
      body: 'why this?',
      snippets: [
        { file: 'a.ts', startLine: 2, endLine: 3, text: 'const a = 1;' },
      ],
      target: 'run-agent',
    });
    const all = new ConversationStore(dir).list('run:r-1');
    expect(all).toHaveLength(1);
    expect(all[0]?.body).toBe('why this?');
    expect(all[0]?.snippets[0]?.file).toBe('a.ts');
  });

  // The whole reason subjects exist rather than run ids: the Git page and a PR have no run,
  // and their conversations must not bleed into each other.
  test('subjects are isolated from one another', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    store.add('run:r-1', { role: 'human', body: 'run one', snippets: [] });
    expect(store.list('worktree:/tmp/p')).toEqual([]);
    expect(store.list('pr:42')).toEqual([]);
    expect(store.list('run:r-2')).toEqual([]);
  });

  // A worktree subject contains slashes; the filename must not try to be a path.
  test('a worktree subject with slashes round-trips', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    store.add('worktree:/Users/x/deep/nested', {
      role: 'human',
      body: 'hi',
      snippets: [],
    });
    expect(store.list('worktree:/Users/x/deep/nested')).toHaveLength(1);
  });

  test('remove drops just that message', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    const a = store.add('run:r-1', { role: 'human', body: 'a', snippets: [] });
    store.add('run:r-1', { role: 'human', body: 'b', snippets: [] });
    store.remove('run:r-1', a.id);
    expect(store.list('run:r-1').map((m) => m.body)).toEqual(['b']);
  });

  test('a subject with no conversation reads as empty, not an error', () => {
    expect(new ConversationStore(root()).list('run:r-never')).toEqual([]);
  });
});
