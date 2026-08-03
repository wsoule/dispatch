import { describe, expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InboxStore,
  inferKind,
  parseInbox,
  serializeInbox,
  splitCapture,
} from '../src/inbox';

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-inbox-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  return dir;
}

describe('splitCapture', () => {
  test('one item per non-empty line', () => {
    expect(splitCapture('a\n\nb\n  c  \n')).toEqual(['a', 'b', 'c']);
  });

  // Pasting a markdown list you copied from somewhere else must not double up its bullets.
  test('strips bullets and checkboxes a user might paste in', () => {
    expect(splitCapture('- one\n* two\n- [ ] three\n- [x] four')).toEqual([
      'one',
      'two',
      'three',
      'four',
    ]);
  });

  test('an empty capture yields nothing', () => {
    expect(splitCapture('   \n\n  ')).toEqual([]);
  });
});

describe('inferKind', () => {
  test.each([
    ['diffs go blank when the agent is running', 'bug'],
    ['worktrees are eating disk', 'bug'],
    ['need a way to see git history', 'task'],
    ['maybe we could cache the index', 'idea'],
    ['the sky is blue', 'note'],
  ] as [string, ReturnType<typeof inferKind>][])(
    '%s -> %s',
    (text, expected) => {
      expect(inferKind(text)).toBe(expected);
    }
  );

  // "fix the broken thing" is a bug report that happens to be phrased as an instruction.
  test('bug words win over task words', () => {
    expect(inferKind('need to fix the broken diff view')).toBe('bug');
  });
});

describe('parse and serialize', () => {
  test('round-trips an item without loss', () => {
    const items = parseInbox(
      '- [ ] (bug) diffs go blank ^in-abc123\n- [x] (task) done thing → t-4a8cce ^in-def456'
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'in-abc123',
      kind: 'bug',
      text: 'diffs go blank',
      done: false,
      linkedTaskId: null,
    });
    expect(items[1]).toMatchObject({
      id: 'in-def456',
      kind: 'task',
      done: true,
      linkedTaskId: 't-4a8cce',
    });
    // Serialize then reparse must be stable, or a save would slowly mangle the file.
    expect(parseInbox(serializeInbox(items))).toEqual(items);
  });

  test('carries the flagging run through a round trip', () => {
    const items = parseInbox(
      '- [ ] (bug) agent noticed this @r-abc123 ^in-aaa111'
    );
    expect(items[0]?.createdByRunId).toBe('r-abc123');
    expect(parseInbox(serializeInbox(items))[0]?.createdByRunId).toBe(
      'r-abc123'
    );
  });

  // The point of a markdown file is that a human can type into it.
  test('a hand-added bare line becomes a real item with a guessed kind and a new id', () => {
    const items = parseInbox('- [ ] the merge queue is stuck');
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('bug');
    expect(items[0]?.id).toMatch(/^in-[0-9a-f]+$/);
  });

  test('accepts * bullets and upper-case X', () => {
    const items = parseInbox('* [X] (note) shouted\n* [ ] (note) quiet');
    expect(items[0]?.done).toBe(true);
    expect(items[1]?.done).toBe(false);
  });

  // A broken hand-edit should cost you that line, not the whole inbox, and never the daemon.
  test('unparsable lines are skipped, not thrown on', () => {
    const items = parseInbox(
      '# Inbox\n\nsome prose\n- [ ] (bug) real one ^in-abc123\n- [ ]   \n<<<garbage'
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('real one');
  });

  test('an unknown kind marker is treated as prose rather than dropped', () => {
    const items = parseInbox('- [ ] (wat) still captured ^in-abc123');
    expect(items[0]?.text).toBe('(wat) still captured');
    expect(items[0]?.kind).toBe('note');
  });

  test('an empty file parses to nothing', () => {
    expect(parseInbox('')).toEqual([]);
  });
});

describe('InboxStore', () => {
  test('add splits a blob and persists across instances', () => {
    const dir = root();
    const created = new InboxStore(dir, 'wyat').add({
      text: 'one thing\ntwo thing',
    });
    expect(created).toHaveLength(2);
    expect(new InboxStore(dir, 'wyat').list()).toHaveLength(2);
  });

  test('newest capture lands first', () => {
    const dir = root();
    const store = new InboxStore(dir, 'wyat');
    store.add({ text: 'older' });
    store.add({ text: 'newer' });
    expect(store.list()[0]?.text).toBe('newer');
  });

  test('an explicit kind overrides the guess', () => {
    const dir = root();
    const created = new InboxStore(dir, 'wyat').add({
      text: 'the diff is broken',
      kind: 'idea',
    });
    expect(created[0]?.kind).toBe('idea');
  });

  test('an agent-flagged item records its run', () => {
    const dir = root();
    const created = new InboxStore(dir, 'wyat').add({
      text: 'this file is huge',
      createdByRunId: 'r-abc123',
    });
    expect(created[0]?.createdByRunId).toBe('r-abc123');
    expect(new InboxStore(dir, 'wyat').list()[0]?.createdByRunId).toBe(
      'r-abc123'
    );
  });

  test('update patches only what it is given', () => {
    const dir = root();
    const store = new InboxStore(dir, 'wyat');
    const id = store.add({ text: 'a thing' })[0]?.id ?? '';
    store.update(id, { kind: 'idea' });
    const item = store.list().find((i) => i.id === id);
    expect(item?.kind).toBe('idea');
    expect(item?.text).toBe('a thing');
  });

  test('update on a missing id throws rather than silently doing nothing', () => {
    expect(() =>
      new InboxStore(root(), 'wyat').update('in-nope', { done: true })
    ).toThrow(/not found/);
  });

  test('remove drops items', () => {
    const dir = root();
    const store = new InboxStore(dir, 'wyat');
    const ids = store.add({ text: 'a\nb' }).map((i) => i.id);
    store.remove([ids[0] ?? '']);
    expect(store.list()).toHaveLength(1);
  });

  test('markConverted records the task and archives the item', () => {
    const dir = root();
    const store = new InboxStore(dir, 'wyat');
    const id = store.add({ text: 'becomes a task' })[0]?.id ?? '';
    store.markConverted([{ id, taskId: 't-abc123' }]);
    const item = store.list().find((i) => i.id === id);
    expect(item?.done).toBe(true);
    expect(item?.linkedTaskId).toBe('t-abc123');
  });

  // A retried convert must not fan one captured thought out into several tasks.
  test('markConverted is idempotent and will not relink', () => {
    const dir = root();
    const store = new InboxStore(dir, 'wyat');
    const id = store.add({ text: 'becomes a task' })[0]?.id ?? '';
    store.markConverted([{ id, taskId: 't-first0' }]);
    const second = store.markConverted([{ id, taskId: 't-second' }]);
    expect(second).toHaveLength(0);
    expect(store.list().find((i) => i.id === id)?.linkedTaskId).toBe(
      't-first0'
    );
  });

  test('a corrupt file degrades to an empty inbox rather than throwing', () => {
    const dir = root();
    mkdirSync(join(dir, '.dispatch', 'inbox'), { recursive: true });
    writeFileSync(
      join(dir, '.dispatch', 'inbox', 'wyat.md'),
      '   not markdown'
    );
    expect(new InboxStore(dir, 'wyat').list()).toEqual([]);
  });

  test('the written file is readable markdown with both bands', () => {
    const dir = root();
    const store = new InboxStore(dir, 'wyat');
    store.add({ text: 'open one' });
    const text = readFileSync(
      join(dir, '.dispatch', 'inbox', 'wyat.md'),
      'utf8'
    );
    expect(text).toContain('# Inbox');
    expect(text).toContain('## Open');
    expect(text).toContain('## Sorted');
    expect(text).toContain('- [ ] (note) open one');
  });
});

describe('per-actor inbox files', () => {
  test('writes to a per-actor file', () => {
    const dir = root();
    const store = new InboxStore(dir, 'wyat');
    store.add({ text: 'a thought' });
    expect(existsSync(join(dir, '.dispatch', 'inbox', 'wyat.md'))).toBe(true);
    // A different actor's file is untouched.
    expect(existsSync(join(dir, '.dispatch', 'inbox', 'alice.md'))).toBe(false);
  });

  test('an actor only ever sees their own file through list()', () => {
    const dir = root();
    new InboxStore(dir, 'wyat').add({ text: 'mine' });
    new InboxStore(dir, 'alice').add({ text: 'theirs' });
    expect(new InboxStore(dir, 'wyat').list().map((i) => i.text)).toEqual([
      'mine',
    ]);
    expect(new InboxStore(dir, 'alice').list().map((i) => i.text)).toEqual([
      'theirs',
    ]);
  });

  test('listAll reads items from every actor for clustering', () => {
    const dir = root();
    new InboxStore(dir, 'wyat').add({ text: 'mine' });
    new InboxStore(dir, 'alice').add({ text: 'theirs' });
    const all = new InboxStore(dir, 'wyat').listAll();
    expect(all.map((i) => i.actor).sort()).toEqual(['alice', 'wyat']);
    expect(all.find((i) => i.actor === 'wyat')?.text).toBe('mine');
    expect(all.find((i) => i.actor === 'alice')?.text).toBe('theirs');
  });

  test('listAll returns nothing before any actor has captured anything', () => {
    const dir = root();
    expect(new InboxStore(dir, 'wyat').listAll()).toEqual([]);
  });

  // A handle becomes a filename; it must not be able to escape the inbox directory.
  test('rejects a handle that could not safely become a filename', () => {
    const dir = root();
    expect(() => new InboxStore(dir, '../evil')).toThrow(/invalid/i);
    expect(() => new InboxStore(dir, 'a/b')).toThrow(/invalid/i);
    expect(() => new InboxStore(dir, '')).toThrow(/invalid/i);
  });
});

describe('migrateLegacy', () => {
  function writeLegacy(dir: string, markdown: string): void {
    writeFileSync(join(dir, '.dispatch', 'inbox.md'), markdown);
  }

  test('migrates a legacy single-file inbox to the local actor', () => {
    const dir = root();
    writeLegacy(dir, '- [ ] legacy item\n');
    const store = new InboxStore(dir, 'wyat');
    expect(store.migrateLegacy()).toBe(1);
    expect(store.list().map((i) => i.text)).toContain('legacy item');
    expect(existsSync(join(dir, '.dispatch', 'inbox.md'))).toBe(false);
  });

  test('no legacy file is a no-op', () => {
    const dir = root();
    expect(new InboxStore(dir, 'wyat').migrateLegacy()).toBe(0);
  });

  test('running twice does not duplicate or error', () => {
    const dir = root();
    writeLegacy(dir, '- [ ] legacy item\n');
    const store = new InboxStore(dir, 'wyat');
    expect(store.migrateLegacy()).toBe(1);
    expect(store.migrateLegacy()).toBe(0);
    expect(store.list().filter((i) => i.text === 'legacy item')).toHaveLength(
      1
    );
  });

  // The property that matters most: an actor who already has captures of their own must not
  // have them clobbered by an old shared file landing on top.
  test('does not clobber an existing actor file — merges instead', () => {
    const dir = root();
    const store = new InboxStore(dir, 'wyat');
    store.add({ text: 'already mine' });
    writeLegacy(dir, '- [ ] legacy item\n');
    expect(store.migrateLegacy()).toBe(1);
    const texts = store.list().map((i) => i.text);
    expect(texts).toContain('already mine');
    expect(texts).toContain('legacy item');
    expect(texts).toHaveLength(2);
  });

  test('an item present in both the legacy file and the actor file is not duplicated', () => {
    const dir = root();
    const store = new InboxStore(dir, 'wyat');
    store.add({ text: 'same thought' });
    writeLegacy(dir, '- [ ] same thought\n- [ ] a new one\n');
    expect(store.migrateLegacy()).toBe(1);
    const texts = store.list().map((i) => i.text);
    expect(texts.filter((t) => t === 'same thought')).toHaveLength(1);
    expect(texts).toContain('a new one');
  });

  test('a teammate migrating separately is unaffected by another actor migrating first', () => {
    const dir = root();
    writeLegacy(dir, '- [ ] shared legacy item\n');
    const wyat = new InboxStore(dir, 'wyat');
    expect(wyat.migrateLegacy()).toBe(1);
    // The legacy file is gone now, so alice's own migration is a no-op — the
    // item already landed with whoever's daemon ran first, not lost.
    const alice = new InboxStore(dir, 'alice');
    expect(alice.migrateLegacy()).toBe(0);
    expect(alice.list()).toEqual([]);
    expect(wyat.list().map((i) => i.text)).toContain('shared legacy item');
  });

  // The sequential test above never opens the real race window: by the time the second store
  // calls migrateLegacy(), existsSync already sees the file gone and returns early, before ever
  // reaching unlinkSync. A true startup race is a TOCTOU: this store's own existsSync passes, it
  // reads and folds in the content, and only then — when it tries to remove the file — finds
  // another daemon already deleted it first. Reproduced directly by making unlinkSync throw
  // ENOENT on its first call, which is exactly what a real second unlink of an already-removed
  // file does.
  test('losing the unlink race to another daemon does not throw, and still keeps the content', () => {
    const dir = root();
    writeLegacy(dir, '- [ ] legacy item\n');
    const store = new InboxStore(dir, 'wyat');
    const legacyPath = join(dir, '.dispatch', 'inbox.md');

    const spy = spyOn(fs, 'unlinkSync').mockImplementation(((
      path: Parameters<typeof fs.unlinkSync>[0]
    ) => {
      if (path === legacyPath) {
        const err = new Error(
          'ENOENT: no such file or directory'
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    }) as typeof fs.unlinkSync);

    try {
      let brought = -1;
      expect(() => {
        brought = store.migrateLegacy();
      }).not.toThrow();
      expect(brought).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(store.list().map((i) => i.text)).toContain('legacy item');
  });

  test('a real, non-ENOENT unlink failure still propagates', () => {
    const dir = root();
    writeLegacy(dir, '- [ ] legacy item\n');
    const store = new InboxStore(dir, 'wyat');
    const legacyPath = join(dir, '.dispatch', 'inbox.md');

    const spy = spyOn(fs, 'unlinkSync').mockImplementation(((
      path: Parameters<typeof fs.unlinkSync>[0]
    ) => {
      if (path === legacyPath) {
        const err = new Error(
          'EACCES: permission denied'
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
    }) as typeof fs.unlinkSync);

    try {
      expect(() => store.migrateLegacy()).toThrow(/EACCES/);
    } finally {
      spy.mockRestore();
    }
  });

  test('an unreadable legacy file is a no-op rather than a crash, and is left in place', () => {
    const dir = root();
    mkdirSync(join(dir, '.dispatch', 'inbox.md'), { recursive: true });
    const store = new InboxStore(dir, 'wyat');
    expect(store.migrateLegacy()).toBe(0);
    expect(existsSync(join(dir, '.dispatch', 'inbox.md'))).toBe(true);
  });
});

describe('migrateNotes', () => {
  function writeNotes(dir: string, notes: unknown): void {
    writeFileSync(
      join(dir, '.dispatch', 'notes.json'),
      JSON.stringify(notes, null, 2)
    );
  }

  test('folds the four note kinds onto inbox kinds', () => {
    const dir = root();
    writeNotes(dir, [
      { title: 'a note', kind: 'note', done: false },
      { title: 'a triage', kind: 'triage', done: false },
      { title: 'a followup', kind: 'followup', done: false },
      { title: 'a todo', kind: 'todo', done: false },
    ]);
    const store = new InboxStore(dir, 'wyat');
    expect(store.migrateNotes(dir)).toBe(4);
    const byText = new Map(store.list().map((i) => [i.text, i.kind]));
    expect(byText.get('a note')).toBe('note');
    expect(byText.get('a triage')).toBe('task');
    expect(byText.get('a followup')).toBe('task');
    expect(byText.get('a todo')).toBe('task');
  });

  // Losing a captured thought is worse than mis-filing it.
  test('an unrecognised kind is kept as a note rather than dropped', () => {
    const dir = root();
    writeNotes(dir, [{ title: 'strange', kind: 'wat', done: false }]);
    const store = new InboxStore(dir, 'wyat');
    expect(store.migrateNotes(dir)).toBe(1);
    expect(store.list()[0]?.kind).toBe('note');
  });

  test('preserves done state and the linked task', () => {
    const dir = root();
    writeNotes(dir, [
      {
        title: 'already a task',
        kind: 'triage',
        done: true,
        linkedTaskId: 't-abc123',
      },
    ]);
    const store = new InboxStore(dir, 'wyat');
    store.migrateNotes(dir);
    expect(store.list()[0]).toMatchObject({
      done: true,
      linkedTaskId: 't-abc123',
    });
  });

  test('preserves which agent flagged it', () => {
    const dir = root();
    writeNotes(dir, [
      { title: 'agent found this', kind: 'triage', createdByRunId: 'r-abc123' },
    ]);
    const store = new InboxStore(dir, 'wyat');
    store.migrateNotes(dir);
    expect(store.list()[0]?.createdByRunId).toBe('r-abc123');
  });

  test('running twice does not duplicate', () => {
    const dir = root();
    writeNotes(dir, [{ title: 'once only', kind: 'note' }]);
    const store = new InboxStore(dir, 'wyat');
    expect(store.migrateNotes(dir)).toBe(1);
    expect(store.migrateNotes(dir)).toBe(0);
    expect(store.list()).toHaveLength(1);
  });

  test('no notes file is a no-op, not an error', () => {
    expect(new InboxStore(root(), 'wyat').migrateNotes(root())).toBe(0);
  });

  test('a corrupt notes file is a no-op rather than a crash', () => {
    const dir = root();
    writeFileSync(join(dir, '.dispatch', 'notes.json'), '{ broken');
    expect(new InboxStore(dir, 'wyat').migrateNotes(dir)).toBe(0);
  });

  test('notes with no title are skipped', () => {
    const dir = root();
    writeNotes(dir, [{ title: '   ', kind: 'note' }, { kind: 'note' }]);
    expect(new InboxStore(dir, 'wyat').migrateNotes(dir)).toBe(0);
  });
});
