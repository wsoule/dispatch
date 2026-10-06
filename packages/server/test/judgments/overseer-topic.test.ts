import { describe, expect, test } from 'bun:test';

import type { JudgmentClient } from '../../src/judgments/client';
import { judgeTopic } from '../../src/judgments/overseerTopic';
import type { OverseerMessage } from '../../src/orchestrator/overseer';

function stub(choice: string, confidence: number): JudgmentClient {
  return {
    model: 'jev-test',
    judge: () =>
      Promise.resolve({
        model: 'jev-test',
        answers: {
          topic: { type: 'choice', choice, confidence, probabilities: {} },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      } as never),
  };
}

const talk: OverseerMessage[] = [
  { role: 'user', text: 'why did r-41 fail?', at: 'a' },
  { role: 'tool', tool: 'list_runs', text: '{}', at: 'b' },
  { role: 'assistant', text: 'its tests timed out', at: 'c' },
];

describe('judgeTopic', () => {
  test('a confident "new" opens a new conversation', async () => {
    expect(await judgeTopic(stub('new', 0.9), talk, 'plan auth v2')).toEqual({
      newTopic: true,
      confidence: 0.9,
    });
  });

  test('a weak "new" or a "continues" stays put', async () => {
    expect((await judgeTopic(stub('new', 0.6), talk, 'hm')).newTopic).toBe(
      false
    );
    expect(
      (await judgeTopic(stub('continues', 0.95), talk, 'rerun it')).newTopic
    ).toBe(false);
  });

  test('fail-open: no client, no conversation yet, or a failed call', async () => {
    const broken: JudgmentClient = {
      model: 'jev-test',
      judge: () => Promise.reject(new Error('down')),
    };
    for (const reading of [
      await judgeTopic(null, talk, 'x'),
      await judgeTopic(stub('new', 0.99), [], 'x'),
      await judgeTopic(broken, talk, 'x'),
    ]) {
      expect(reading).toEqual({ newTopic: false, confidence: null });
    }
  });

  test('sends only the human and agent lines, newest last', async () => {
    let state: unknown;
    const spy: JudgmentClient = {
      model: 'jev-test',
      judge: (s) => {
        state = s;
        return stub('continues', 0.9).judge(s, {} as never);
      },
    };
    await judgeTopic(spy, talk, 'rerun it');
    expect(state).toEqual({
      recent: [
        { who: 'user', text: 'why did r-41 fail?' },
        { who: 'assistant', text: 'its tests timed out' },
      ],
      next: 'rerun it',
    });
  });
});
