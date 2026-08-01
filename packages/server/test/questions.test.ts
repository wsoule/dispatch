import { describe, expect, it } from 'bun:test';

import { QuestionRegistry } from '../src/orchestrator/questions.js';
import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../src/orchestrator/types.js';

describe('QuestionRegistry', () => {
  it('lists a freshly asked question as open, with its options', () => {
    const registry = new QuestionRegistry();
    const asked = registry.ask('r-1', 'Which database?', [
      'sqlite',
      'postgres',
    ]);

    expect(asked.id).toMatch(/^q-[0-9a-f]{6}$/);
    expect(asked.answer).toBeNull();
    expect(asked.answeredAt).toBeNull();
    expect(registry.listOpen()).toEqual([asked]);
    expect(registry.get(asked.id)).toEqual(asked);
    expect(asked.options).toEqual(['sqlite', 'postgres']);
  });

  it('resolves a parked waitForAnswer with the answer once one is recorded', async () => {
    const registry = new QuestionRegistry();
    const asked = registry.ask('r-1', 'Which database?');

    const waiting = registry.waitForAnswer(asked.id, 5000);
    registry.answer(asked.id, 'postgres');

    const resolved = await waiting;
    expect(resolved.answer).toBe('postgres');
    expect(resolved.answeredAt).not.toBeNull();
    expect(registry.listOpen()).toEqual([]);
  });

  it('resolves immediately when the question was already answered', async () => {
    const registry = new QuestionRegistry();
    const asked = registry.ask('r-1', 'Which database?');
    registry.answer(asked.id, 'sqlite');

    expect((await registry.waitForAnswer(asked.id, 5000)).answer).toBe(
      'sqlite'
    );
  });

  it('rejects a second answer to the same question', () => {
    const registry = new QuestionRegistry();
    const asked = registry.ask('r-1', 'Which database?');
    registry.answer(asked.id, 'postgres');

    expect(() => registry.answer(asked.id, 'sqlite')).toThrow(
      OrchestratorConflictError
    );
    expect(registry.get(asked.id)?.answer).toBe('postgres');
  });

  it('rejects answering or waiting on an unknown id', async () => {
    const registry = new QuestionRegistry();

    expect(() => registry.answer('q-nope1', 'x')).toThrow(
      OrchestratorNotFoundError
    );
    expect(registry.waitForAnswer('q-nope1', 5000)).rejects.toThrow(
      OrchestratorNotFoundError
    );
  });

  it('resolves with the still-unanswered record at the timeout', async () => {
    const registry = new QuestionRegistry();
    const asked = registry.ask('r-1', 'Which database?');

    const timedOut = await registry.waitForAnswer(asked.id, 20);
    expect(timedOut.id).toBe(asked.id);
    expect(timedOut.answer).toBeNull();
    // Timing out is not closing: the question is still open for the next poll.
    expect(registry.listOpen()).toEqual([asked]);
  });

  it('still answers a question whose earlier poll timed out', async () => {
    const registry = new QuestionRegistry();
    const asked = registry.ask('r-1', 'Which database?');

    expect((await registry.waitForAnswer(asked.id, 20)).answer).toBeNull();
    const waiting = registry.waitForAnswer(asked.id, 5000);
    registry.answer(asked.id, 'postgres');
    expect((await waiting).answer).toBe('postgres');
  });

  it('scopes questions per run', () => {
    const registry = new QuestionRegistry();
    const first = registry.ask('r-1', 'Which database?');
    const second = registry.ask('r-2', 'Which cache?');

    expect(registry.listOpen('r-1')).toEqual([first]);
    expect(registry.listOpen('r-2')).toEqual([second]);
    expect(registry.listOpen()).toHaveLength(2);
    expect(registry.get(second.id)?.runId).toBe('r-2');

    registry.answer(first.id, 'postgres');
    expect(registry.listOpen()).toEqual([second]);
  });

  it('drops a run’s questions and wakes its waiters when the run closes', async () => {
    const registry = new QuestionRegistry();
    const mine = registry.ask('r-1', 'Which database?');
    const other = registry.ask('r-2', 'Which cache?');

    const waiting = registry.waitForAnswer(mine.id, 5000);
    registry.closeRun('r-1');

    expect((await waiting).answer).toBeNull();
    expect(registry.get(mine.id)).toBeUndefined();
    expect(registry.listOpen()).toEqual([other]);
  });
});
