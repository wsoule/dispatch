import type { TaskDoc } from '@dispatch/core';
import { defaultTaskFields } from '@dispatch/core';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JudgmentClient } from '../../src/judgments/client';
import {
  interpretReadiness,
  READINESS_LEVELS,
  readinessFor,
  readinessHash,
  readinessQuestions,
  readinessState,
  ReadinessStore,
} from '../../src/judgments/readiness';

function task(
  id: string,
  title: string,
  body = '',
  writes: string[] = []
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: 'none',
      risk: 'routine',
      model: null,
      selfReview: true,
      writes,
      external: null,
      exercised: false,
      ...defaultTaskFields(),
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-01T00:00:00.000Z',
    },
    body,
  };
}

function answers(probabilities: Record<string, number>, split = 0.1) {
  return {
    readiness: {
      type: 'score' as const,
      score: 0,
      confidence: 0.8,
      legend: {},
      probabilities,
    },
    split: { type: 'noul' as const, noul: split },
  };
}

describe('readinessQuestions', () => {
  test('asks a four-level score and a split noul', () => {
    const q = readinessQuestions();
    expect(q.readiness.type).toBe('score');
    expect(q.readiness.criteria).toHaveLength(4);
    expect(q.split.type).toBe('noul');
    expect(READINESS_LEVELS).toHaveLength(4);
  });
});

describe('readinessState', () => {
  test('carries title, body and declared writes', () => {
    const state = readinessState(task('t1', 'Fix it', 'Body', ['src/a.ts']));
    expect(state).toEqual({
      title: 'Fix it',
      body: 'Body',
      declaredWrites: ['src/a.ts'],
    });
  });
});

describe('interpretReadiness', () => {
  test('takes the most probable level and copies confidence and split', () => {
    const got = interpretReadiness(
      answers({ '0': 0.1, '1': 0.2, '2': 0.6, '3': 0.1 }, 0.75)
    );
    expect(got).toEqual({
      level: 2,
      label: READINESS_LEVELS[2],
      confidence: 0.8,
      splitProbability: 0.75,
    });
  });

  test('ignores a level outside the rubric', () => {
    expect(interpretReadiness(answers({ '9': 1, '1': 0.5 })).level).toBe(1);
  });
});

describe('readinessFor', () => {
  const t1 = task('t1', 'One');
  const t2 = task('t2', 'Two');

  function stub(level: number): { client: JudgmentClient; calls: number } {
    const holder = { calls: 0 };
    const client: JudgmentClient = {
      model: 'jev-test',
      judge: () => {
        holder.calls += 1;
        const probabilities: Record<string, number> = {
          '0': 0,
          '1': 0,
          '2': 0,
          '3': 0,
        };
        probabilities[String(level)] = 1;
        return Promise.resolve({
          model: 'jev-test',
          answers: answers(probabilities),
          usage: { input_tokens: 1, output_tokens: 0 },
        } as never);
      },
    };
    return {
      client,
      get calls() {
        return holder.calls;
      },
    };
  }

  test('returns an empty map and touches nothing without a client', async () => {
    const store = new ReadinessStore(
      mkdtempSync(join(tmpdir(), 'dispatch-ready-'))
    );
    expect(await readinessFor(null, [t1], store)).toEqual({});
    expect(store.load()).toEqual({});
  });

  test('judges only tasks whose hash changed and persists the rest', async () => {
    const store = new ReadinessStore(
      mkdtempSync(join(tmpdir(), 'dispatch-ready-'))
    );
    const first = stub(3);
    const one = await readinessFor(first.client, [t1, t2], store);
    expect(first.calls).toBe(2);
    expect(one.t1.level).toBe(3);

    const second = stub(0);
    const edited = task('t2', 'Two', 'now with a body');
    const two = await readinessFor(second.client, [t1, edited], store);
    expect(second.calls).toBe(1);
    expect(two.t1.level).toBe(3);
    expect(two.t2.level).toBe(0);
    expect(store.load().t2.hash).toBe(readinessHash(edited));
  });

  test('a failing client returns whatever was cached', async () => {
    const store = new ReadinessStore(
      mkdtempSync(join(tmpdir(), 'dispatch-ready-'))
    );
    await readinessFor(stub(1).client, [t1], store);
    const failing: JudgmentClient = {
      model: 'jev-test',
      judge: () => Promise.reject(new Error('down')),
    };
    const got = await readinessFor(failing, [t1, t2], store);
    expect(Object.keys(got)).toEqual(['t1']);
  });
});
