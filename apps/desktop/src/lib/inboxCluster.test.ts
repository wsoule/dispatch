import type { InboxItem } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { describeCluster, findCluster } from './inboxCluster';

function item(id: string, text: string, done = false): InboxItem {
  return {
    id,
    kind: 'note',
    text,
    done,
    linkedTaskId: null,
    createdByRunId: null,
    created: '',
  };
}

describe('findCluster', () => {
  test('finds a real cluster and names its theme', () => {
    const cluster = findCluster([
      item('a', 'worktrees are eating disk space'),
      item('b', 'reuse one worktree pool across agents'),
      item('c', 'prune worktree directories older than a day'),
      item('d', 'the sidebar badge is the wrong colour'),
    ]);
    expect(cluster).not.toBeNull();
    expect(cluster?.ids.sort()).toEqual(['a', 'b', 'c']);
    expect(cluster?.theme.join(' ')).toContain('worktree');
  });

  // The whole point of the high bar: firing on every coincidence makes the hint unreadable.
  test('two related items are not a cluster', () => {
    expect(
      findCluster([
        item('a', 'worktrees are eating disk'),
        item('b', 'prune old worktrees'),
        item('c', 'unrelated thing entirely'),
      ])
    ).toBeNull();
  });

  test('unrelated items produce nothing', () => {
    expect(
      findCluster([
        item('a', 'the diff view goes blank'),
        item('b', 'keyboard shortcuts for the feed'),
        item('c', 'export a session log'),
        item('d', 'milestone dates are missing'),
      ])
    ).toBeNull();
  });

  test('too few items to cluster at all', () => {
    expect(
      findCluster([item('a', 'worktree'), item('b', 'worktree')])
    ).toBeNull();
  });

  test('an empty inbox is silent', () => {
    expect(findCluster([])).toBeNull();
  });

  // Already-sorted items are history; clustering them would suggest work that is done.
  test('done items are excluded', () => {
    expect(
      findCluster([
        item('a', 'worktree pool', true),
        item('b', 'worktree disk', true),
        item('c', 'worktree prune', true),
      ])
    ).toBeNull();
  });

  // Without stopwords, every item sharing "the" or "should" would cluster with every other.
  test('common and domain-filler words never form a cluster', () => {
    expect(
      findCluster([
        item('a', 'the agent should run the task'),
        item('b', 'the agent should add a task'),
        item('c', 'the agent should fix the task'),
      ])
    ).toBeNull();
  });

  test('picks the strongest cluster when more than one exists', () => {
    const cluster = findCluster([
      item('a', 'worktree pool locking'),
      item('b', 'worktree disk usage'),
      item('c', 'worktree pruning'),
      item('d', 'worktree reuse'),
      item('e', 'planner streaming'),
      item('f', 'planner threads'),
      item('g', 'planner history'),
    ]);
    expect(cluster?.ids).toHaveLength(4);
  });

  test('short words are ignored so noise cannot cluster', () => {
    expect(
      findCluster([
        item('a', 'a b c d'),
        item('b', 'a b c d'),
        item('c', 'a b c d'),
      ])
    ).toBeNull();
  });
});

describe('describeCluster', () => {
  test('names the theme and makes the epic argument', () => {
    const sentence = describeCluster({
      ids: ['a', 'b', 'c'],
      theme: ['worktree'],
    });
    expect(sentence).toContain('3 items');
    expect(sentence).toContain('worktree');
    expect(sentence).toContain('epic');
  });
});
