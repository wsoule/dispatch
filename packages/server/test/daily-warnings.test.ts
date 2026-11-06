import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dailyWarningsDue,
  runWarnings,
  type WarningDeps,
  WarningStore,
} from '../src/planning/warningRuns.js';

// The daemon's daily digest over a real file-backed project: Storefront (lead
// Ana) has a milestone three days overdue, and Dev watches. The run tells both,
// posts each digest to the webhook, remembers what it said (so it does not
// repeat until something changes), and runs at most once a day from 8:00.

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let root: string;
let store: TaskStore;
let warnings: WarningStore;
let posts: {
  url: string;
  body: { event: string; digest: { recipientId: string } };
}[];

function deps(): WarningDeps {
  return {
    rootDir: root,
    store,
    actor: 'human:wyat',
    people: () => [
      { ref: 'human:ana', name: 'Ana' },
      { ref: 'human:dev', name: 'Dev' },
    ],
    warnings,
    fetch: ((url: string, init: { body: string }) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch,
  };
}

function writeConfig(lines: string[]): void {
  writeFileSync(join(root, '.dispatch', 'config.yml'), `${lines.join('\n')}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-daily-warn-'));
  store = TaskStore.init(root);
  warnings = new WarningStore(join(root, 'warnings.db'));
  posts = [];
  const project = store.create({
    title: 'Storefront',
    kind: 'project',
    status: 'working',
    assignee: 'human:ana',
  });
  const milestone = store.create({
    title: 'Beta',
    kind: 'milestone',
    parent: project.meta.id,
    dueDate: day(-3),
    description: 'Done means: a guest can pay.',
  });
  store.create({
    title: 'Take payments',
    parent: milestone.meta.id,
    status: 'ready',
    assignee: 'human:ana',
  });
});

afterEach(() => {
  warnings.close();
  rmSync(root, { recursive: true, force: true });
});

describe('runWarnings', () => {
  it('posts a digest to the lead and the watcher, then stays quiet until something changes', async () => {
    writeConfig([
      'notifications:',
      '  webhook: https://hooks.example.com/x',
      'planning:',
      '  warnings: notify',
      '  watchers: [human:dev]',
    ]);
    const logged = await runWarnings(deps());
    expect(logged.map((each) => each.digest.recipientId).sort()).toEqual([
      'human:ana',
      'human:dev',
    ]);
    expect(logged.every((each) => each.delivery === 'webhook')).toBe(true);
    expect(logged[0]?.digest.items[0]?.notice.kind).toBe('overdue');
    expect(posts.map((post) => post.body.event)).toEqual([
      'planning.digest',
      'planning.digest',
    ]);
    expect(posts[0]?.url).toBe('https://hooks.example.com/x');

    posts = [];
    expect(await runWarnings(deps())).toEqual([]);
    expect(posts).toEqual([]);
  });

  it('logs without a webhook', async () => {
    writeConfig(['planning:', '  warnings: notify']);
    const logged = await runWarnings(deps());
    expect(logged.map((each) => each.delivery)).toEqual(['logged']);
    expect(warnings.digests()).toHaveLength(1);
  });
});

describe('dailyWarningsDue', () => {
  const at = (hour: number) => {
    const d = new Date();
    d.setHours(hour, 5, 0, 0);
    return d;
  };

  it('is due from 8:00 when notify is on, once a day', async () => {
    writeConfig(['planning:', '  warnings: notify']);
    expect(dailyWarningsDue(deps(), at(7))).toBe(false);
    expect(dailyWarningsDue(deps(), at(9))).toBe(true);
    await runWarnings(deps());
    expect(dailyWarningsDue(deps(), at(9))).toBe(false);
  });

  it('is never due when warnings are off', () => {
    writeConfig(['planning:', '  allocation: daily']);
    expect(dailyWarningsDue(deps(), at(9))).toBe(false);
  });
});
