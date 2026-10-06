import type { ModelConfig, TaskDoc } from '@dispatch-foo/core';
import { defaultTaskFields } from '@dispatch-foo/core';
import { describe, expect, test } from 'bun:test';

import type { JudgmentClient } from '../../src/judgments/client';
import {
  chooseRunModel,
  judgeRunModel,
  modelTierQuestions,
  modelTierState,
} from '../../src/judgments/modelTier';

const models: ModelConfig = {
  execute: 'opus',
  overseer: 'opus',
  plan: 'sonnet',
  draft: 'haiku',
  enrich: 'haiku',
  cluster: 'haiku',
  summarize: 'haiku',
  judge: 'jev',
};

function task(
  over: Partial<TaskDoc['meta']> = {},
  body = 'Rename the flag.'
): TaskDoc {
  return {
    meta: {
      id: 't-000001',
      title: 'Rename a flag',
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
      writes: ['src/flags.ts'],
      external: null,
      exercised: false,
      ...defaultTaskFields(),
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-01T00:00:00.000Z',
      ...over,
    },
    body,
  };
}

function stub(choice: string, confidence: number): JudgmentClient {
  return {
    model: 'jev-test',
    judge: () =>
      Promise.resolve({
        model: 'jev-test',
        answers: {
          complexity: { type: 'choice', choice, confidence, probabilities: {} },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      } as never),
  };
}

describe('modelTierQuestions / modelTierState', () => {
  test('asks one three-way complexity choice over title, body, writes and risk', () => {
    const q = modelTierQuestions();
    expect(Object.keys(q.complexity.criteria)).toEqual([
      'trivial',
      'small',
      'substantial',
    ]);
    expect(modelTierState(task())).toEqual({
      title: 'Rename a flag',
      body: 'Rename the flag.',
      writes: ['src/flags.ts'],
      risk: 'routine',
    });
  });
});

describe('chooseRunModel', () => {
  test('drops routine trivial or small work to the planning tier when confident', () => {
    expect(
      chooseRunModel('routine', { choice: 'small', confidence: 0.8 }, models)
    ).toEqual({
      model: 'sonnet',
      reason: 'judged small (0.80) on routine risk',
    });
    expect(
      chooseRunModel('routine', { choice: 'trivial', confidence: 0.95 }, models)
        .model
    ).toBe('sonnet');
  });

  test('keeps the coding tier below the confidence floor, on substantial work, or off routine risk', () => {
    expect(
      chooseRunModel('routine', { choice: 'small', confidence: 0.6 }, models)
    ).toEqual({
      model: 'opus',
      reason: null,
    });
    expect(
      chooseRunModel(
        'routine',
        { choice: 'substantial', confidence: 0.99 },
        models
      ).model
    ).toBe('opus');
    expect(
      chooseRunModel(
        'elevated',
        { choice: 'trivial', confidence: 0.99 },
        models
      ).model
    ).toBe('opus');
    expect(chooseRunModel('routine', null, models)).toEqual({
      model: 'opus',
      reason: null,
    });
  });
});

describe('judgeRunModel', () => {
  test('returns the coding tier with no client, on a task override, or when the API fails', async () => {
    expect(await judgeRunModel(null, task(), models)).toEqual({
      model: 'opus',
      reason: null,
    });
    expect(
      await judgeRunModel(stub('small', 0.9), task({ model: 'custom' }), models)
    ).toEqual({
      model: 'opus',
      reason: null,
    });
    const failing: JudgmentClient = {
      model: 'jev-test',
      judge: () => Promise.reject(new Error('down')),
    };
    expect(await judgeRunModel(failing, task(), models)).toEqual({
      model: 'opus',
      reason: null,
    });
  });

  test('applies the rule to a judged answer', async () => {
    expect(
      (await judgeRunModel(stub('small', 0.9), task(), models)).model
    ).toBe('sonnet');
    expect(
      (await judgeRunModel(stub('substantial', 0.9), task(), models)).model
    ).toBe('opus');
  });
});
