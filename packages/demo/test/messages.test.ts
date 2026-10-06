import {
  createUlidFactory,
  openMessagesDb,
  SqliteMessageStore,
} from '@dispatch-foo/protocol';
import type { Message } from '@dispatch-foo/protocol';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TASKS } from '../src/board.js';
import { writeMessages } from '../src/messages.js';
import { runsDir } from '../src/paths.js';
import { writeRuns } from '../src/runs.js';

function seeded(): { root: string; home: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'demo-msg-root-'));
  const home = mkdtempSync(join(tmpdir(), 'demo-msg-home-'));
  writeMessages(root, home, 'demo');
  return { root, home, path: join(runsDir(root, home), 'messages.db') };
}

// Opens the seeded database, hands its store to `read`, and closes it again.
function withStore<T>(path: string, read: (store: SqliteMessageStore) => T): T {
  const db = openMessagesDb(path);
  try {
    return read(new SqliteMessageStore(db));
  } finally {
    db.close();
  }
}

function allMessages(store: SqliteMessageStore): Message[] {
  return store.recentThreads(10).flatMap((t) => store.thread(t.thread));
}

describe('writeMessages', () => {
  test('seeds a granted scope gate, two open questions, an accepted handoff and an epic notice', () => {
    withStore(seeded().path, (store) => {
      expect(
        store
          .recentThreads(10)
          .map((t) => t.root.kind)
          .sort()
      ).toEqual(['handoff', 'notice', 'question', 'question', 'question']);
      expect(store.openBlocking().map((m) => m.from)).toEqual([
        'run:r-88bf02',
        'run:r-88bf02',
      ]);
      expect(store.unappliedAnsweredGates()).toEqual([]);
      expect(
        store.deliveries({ recipient: 'human:demo', states: ['notified'] })
      ).toHaveLength(2);
    });
  });

  test('re-seeding replaces the file instead of failing on its fixed ids', () => {
    const { root, home, path } = seeded();
    writeMessages(root, home, 'demo');
    withStore(path, (store) => {
      expect(store.recentThreads(10)).toHaveLength(5);
    });
  });

  test('leaves nothing a daemon would push to a later run', () => {
    withStore(seeded().path, (store) => {
      expect(store.deliveries({ states: ['held', 'sending'] })).toEqual([]);
      const notice = allMessages(store).find((m) => m.kind === 'notice');
      const reached = store
        .deliveries({ messageId: notice?.id ?? 'missing' })
        .map((d) => `${d.recipient} ${d.via} ${d.state}`);
      // Everyone on the epic's channel but the sender's own task.
      const members = TASKS.filter(
        (t) => t.parent === 'e-4a19c2' && t.id !== 't-3f8a21'
      ).map((t) => `task:${t.id} channel read`);
      const byText = (a: string, b: string): number => a.localeCompare(b);
      expect(reached.sort(byText)).toEqual(members.sort(byText));
    });
  });

  test('ids take the daemon shape, so a live message sorts after the seed', () => {
    withStore(seeded().path, (store) => {
      const messages = allMessages(store).sort((a, b) =>
        a.id < b.id ? -1 : 1
      );
      const ids = [
        ...messages.map((m) => m.id),
        ...store.deliveries({}).map((d) => d.id),
      ];
      for (const id of ids) expect(id).toMatch(/^[md]-[0-9a-z]{26}$/);
      const times = messages.map((m) => m.createdAt);
      expect(times).toEqual([...times].sort());
      const live = `m-${createUlidFactory()(Date.now()).toLowerCase()}`;
      expect(messages.every((m) => m.id < live)).toBe(true);
    });
  });

  test('every reseed writes the same message and delivery ids', () => {
    const ids = (path: string): string[] =>
      withStore(path, (store) => [
        ...allMessages(store).map((m) => m.id),
        ...store.deliveries({}).map((d) => d.id),
      ]).sort();
    const first = ids(seeded().path);
    expect(first).toHaveLength(7 + 6 + epicSiblings().length);
    expect(ids(seeded().path)).toEqual(first);
  });

  test("each run's transcript logs what it sent a human and what reached it, by the seeded ids", () => {
    const { root, home, path } = seeded();
    writeRuns(root, home, 'demo');
    withStore(path, (store) => {
      const messages = allMessages(store).sort((a, b) =>
        a.id < b.id ? -1 : 1
      );
      for (const runId of ['r-1e6a4f', 'r-88bf02', 'r-f30c76']) {
        const logged = transcript(root, home, runId).filter(
          (e) => e.kind === 'message' && e.messageId !== undefined
        );
        const sent = messages.filter(
          (m) =>
            m.from === `run:${runId}` &&
            m.to.some((a) => a.startsWith('human:'))
        );
        expect(
          logged
            .filter((e) => e.toUser === true)
            .map((e) => [e.messageId, e.text])
        ).toEqual(sent.map((m) => [m.id, m.body]));
        const pushed = store
          .deliveries({ states: ['pushed'] })
          .filter((d) => d.runId === runId)
          .map((d) => d.messageId);
        expect(
          logged.filter((e) => e.toUser !== true).map((e) => e.messageId)
        ).toEqual(pushed);
        for (const entry of logged.filter((e) => e.toUser !== true)) {
          const m = messages.find((x) => x.id === entry.messageId);
          expect(entry.from).toBe('user');
          expect(entry.fromLabel).toBe(m?.from ?? 'missing');
          expect(entry.text).toStartWith(
            `[message from ${m?.from ?? 'missing'} · ${m?.kind ?? ''} · ${m?.id ?? ''}]`
          );
        }
      }
    });
  });
});

function epicSiblings(): string[] {
  return TASKS.filter(
    (t) => t.parent === 'e-4a19c2' && t.id !== 't-3f8a21'
  ).map((t) => t.id);
}

interface LoggedEntry {
  kind?: string;
  from?: string;
  fromLabel?: string;
  toUser?: boolean;
  text?: string;
  messageId?: string;
}

// A seeded run's transcript entries, in order.
function transcript(root: string, home: string, runId: string): LoggedEntry[] {
  return readFileSync(join(runsDir(root, home), `${runId}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { entry?: LoggedEntry })
    .flatMap((line) => (line.entry === undefined ? [] : [line.entry]));
}
