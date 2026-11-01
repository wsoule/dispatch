import { describe, expect, test } from 'bun:test';

import type { InboxItem } from '../../src/inbox';
import type { JudgmentClient } from '../../src/judgments/client';
import type { InboxTriageSnapshot } from '../../src/judgments/inboxTriage';
import {
  InboxTriageScheduler,
  interpretSplit,
  judgedKindChanges,
  splitCapture,
  splitQuestions,
} from '../../src/judgments/inboxTriage';

function stub(
  answers: Record<string, unknown>,
  calls: number[] = []
): JudgmentClient {
  return {
    model: 'jev-test',
    judge: () => {
      calls.push(1);
      return Promise.resolve({
        model: 'jev-test',
        answers,
        usage: { input_tokens: 1, output_tokens: 0 },
      } as never);
    },
  };
}

const starts = (confidence: number) => ({
  type: 'choice' as const,
  choice: 'starts',
  confidence,
  probabilities: {},
});
const continues = {
  type: 'choice' as const,
  choice: 'continues',
  confidence: 0.9,
  probabilities: {},
};

describe('splitQuestions', () => {
  test('asks one boundary choice per non-blank line after the first', () => {
    const q = splitQuestions(['first', '', 'third', 'fourth']);
    expect(Object.keys(q)).toEqual(['boundary_2', 'boundary_3']);
    expect(Object.keys(q.boundary_2.criteria)).toEqual(['continues', 'starts']);
  });

  test('asks nothing for a single-line capture', () => {
    expect(Object.keys(splitQuestions(['only']))).toEqual([]);
  });
});

describe('interpretSplit', () => {
  const lines = [
    'fix the board',
    'it drops cards',
    'new idea: dark mode',
    'for the site',
  ];

  test('splits only at confident starts, keeping blank lines with what follows', () => {
    const segments = interpretSplit(lines, {
      boundary_1: continues,
      boundary_2: starts(0.9),
      boundary_3: continues,
    });
    expect(segments).toEqual([
      'fix the board\nit drops cards',
      'new idea: dark mode\nfor the site',
    ]);
  });

  test('keeps an unconfident boundary together', () => {
    expect(interpretSplit(lines, { boundary_2: starts(0.6) })).toEqual([
      lines.join('\n'),
    ]);
  });
});

describe('splitCapture', () => {
  test('returns the capture whole without a client or for one line', async () => {
    expect(await splitCapture(null, 'a\nb')).toEqual(['a\nb']);
    const calls: number[] = [];
    expect(await splitCapture(stub({}, calls), 'one line')).toEqual([
      'one line',
    ]);
    expect(calls).toHaveLength(0);
  });

  test('splits a multi-thought paste into raw segments for the store to normalize', async () => {
    const client = stub({ boundary_1: starts(0.95) });
    expect(
      await splitCapture(client, '- fix the board\n- add dark mode')
    ).toEqual(['- fix the board', '- add dark mode']);
  });

  test('a failing client keeps the paste whole', async () => {
    const failing: JudgmentClient = {
      model: 'jev-test',
      judge: () => Promise.reject(new Error('down')),
    };
    expect(await splitCapture(failing, 'a\nb')).toEqual(['a\nb']);
  });
});

describe('judgedKindChanges', () => {
  function item(id: string, kind: InboxItem['kind']): InboxItem {
    return {
      id,
      kind,
      text: id,
      done: false,
      linkedTaskId: null,
      createdByRunId: null,
      created: '',
    };
  }
  const triage = (id: string, kind: string, kindConfidence = 0.9) => ({
    itemId: id,
    hash: 'h',
    kind: kind as never,
    kindConfidence,
    milestoneId: null,
    milestoneTitle: null,
    milestoneConfidence: 0,
    duplicates: [],
  });

  test('changes a first-judged item whose confident kind differs, never noise, never a re-judged item', () => {
    const items = [
      item('a', 'note'),
      item('b', 'note'),
      item('c', 'note'),
      item('d', 'note'),
    ];
    const previous: InboxTriageSnapshot = {
      items: { d: triage('d', 'note') },
      updatedAt: 't',
    };
    const next: InboxTriageSnapshot = {
      items: {
        a: triage('a', 'bug'),
        b: triage('b', 'bug', 0.5),
        c: triage('c', 'noise'),
        d: triage('d', 'bug'),
      },
      updatedAt: 'now',
    };
    expect(judgedKindChanges(items, previous, next)).toEqual([
      { id: 'a', kind: 'bug' },
    ]);
  });
});

describe('InboxTriageScheduler', () => {
  test('coalesces pings into one run at a time and reruns once when pinged mid-run', async () => {
    let running = 0;
    let runs = 0;
    const releases: (() => void)[] = [];
    const scheduler = new InboxTriageScheduler(async () => {
      runs += 1;
      running += 1;
      expect(running).toBe(1);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      running -= 1;
    });
    scheduler.request();
    scheduler.request();
    scheduler.request();
    await Promise.resolve();
    expect(runs).toBe(1);
    scheduler.request(); // arrives while the first run is in flight
    releases[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2); // exactly one rerun for the mid-run ping
    releases[1]();
    await scheduler.idle();
    expect(runs).toBe(2);
  });

  test('a throwing pass does not wedge the scheduler', async () => {
    let runs = 0;
    const scheduler = new InboxTriageScheduler(() => {
      runs += 1;
      return Promise.reject(new Error('boom'));
    });
    scheduler.request();
    await scheduler.idle();
    scheduler.request();
    await scheduler.idle();
    expect(runs).toBe(2);
  });
});
