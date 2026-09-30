import type { TaskDoc } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';

import {
  FanoutError,
  fanoutLabel,
  MAX_FANOUT_VARIANTS,
  parseVariants,
  validateVariants,
  variantTaskInput,
  variantTitle,
} from '../src/fanout.js';

function sourceTask(overrides: Partial<TaskDoc['meta']> = {}): TaskDoc {
  return {
    meta: {
      id: 't-1',
      title: 'Fix the login bug',
      status: 'todo',
      kind: 'task',
      parent: null,
      milestone: 'auth',
      blockedBy: ['t-0'],
      labels: ['bug'],
      priority: 'high',
      assignee: 'agent',
      selfReview: true,
      writes: ['src/auth/**'],
      risk: 'elevated',
      exercised: false,
      ...overrides,
    },
    body: 'The login form rejects valid passwords.',
  } as unknown as TaskDoc;
}

describe('variantTitle', () => {
  it('names the agent, since that is what a comparison is asking', () => {
    expect(variantTitle('Fix login', { executor: 'claude' })).toBe(
      'Fix login [claude]'
    );
  });

  it('includes the model when one is pinned', () => {
    expect(
      variantTitle('Fix login', { executor: 'codex', model: 'gpt-5.5' })
    ).toBe('Fix login [codex · gpt-5.5]');
  });
});

describe('fanoutLabel', () => {
  it('keys the group to the source task', () => {
    expect(fanoutLabel('t-1')).toBe('fanout:t-1');
  });
});

describe('parseVariants', () => {
  it('accepts a plain list of executor names', () => {
    expect(parseVariants(['claude', 'codex'])).toEqual([
      { executor: 'claude' },
      { executor: 'codex' },
    ]);
  });

  it('accepts the object form for pinning a model', () => {
    expect(parseVariants([{ executor: 'codex', model: 'gpt-5.5' }])).toEqual([
      { executor: 'codex', model: 'gpt-5.5' },
    ]);
  });

  it('rejects anything that is not a list', () => {
    expect(() => parseVariants('claude')).toThrow(FanoutError);
    expect(() => parseVariants(undefined)).toThrow(FanoutError);
  });

  it('rejects a variant with no executor', () => {
    expect(() => parseVariants([{ model: 'x' }])).toThrow(FanoutError);
    expect(() => parseVariants([42])).toThrow(FanoutError);
  });
});

describe('validateVariants', () => {
  const registered = ['claude', 'codex', 'gemini'];

  it('accepts distinct registered executors', () => {
    expect(() =>
      validateVariants(
        [{ executor: 'claude' }, { executor: 'codex' }],
        registered
      )
    ).not.toThrow();
  });

  it('refuses an empty list', () => {
    expect(() => validateVariants([], registered)).toThrow(FanoutError);
  });

  it('refuses an unregistered executor and says what is available', () => {
    try {
      validateVariants([{ executor: 'nope' }], registered);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('claude, codex, gemini');
    }
  });

  it('refuses duplicates rather than silently collapsing them', () => {
    // Collapsing would hand back fewer results than were asked for, with no
    // indication why.
    expect(() =>
      validateVariants(
        [{ executor: 'claude' }, { executor: 'claude' }],
        registered
      )
    ).toThrow(FanoutError);
  });

  it('treats the same executor on different models as distinct', () => {
    expect(() =>
      validateVariants(
        [
          { executor: 'codex', model: 'a' },
          { executor: 'codex', model: 'b' },
        ],
        registered
      )
    ).not.toThrow();
  });

  it('caps how many can be started at once', () => {
    // A typo must not start fifty runs.
    const many = Array.from({ length: MAX_FANOUT_VARIANTS + 1 }, (_, i) => ({
      executor: 'claude',
      model: `m${i}`,
    }));
    expect(() => validateVariants(many, registered)).toThrow(FanoutError);
  });
});

describe('variantTaskInput', () => {
  it('gives every variant the same problem statement', () => {
    // The comparison is only meaningful if each agent was asked the same thing.
    const input = variantTaskInput(sourceTask(), { executor: 'claude' });
    expect(input.description).toBe('The login form rejects valid passwords.');
  });

  it('copies everything that scopes or gates the work', () => {
    const input = variantTaskInput(sourceTask(), { executor: 'claude' });
    expect(input.writes).toEqual(['src/auth/**']);
    expect(input.risk).toBe('elevated');
    expect(input.selfReview).toBe(true);
    expect(input.priority).toBe('high');
  });

  it('files the clone by parent, never the legacy milestone string', () => {
    const input = variantTaskInput(sourceTask({ parent: 'e-1' }), {
      executor: 'claude',
    });
    expect(input.parent).toBe('e-1');
    expect('milestone' in input).toBe(false);
  });

  it('labels the clone so the group stays findable', () => {
    const input = variantTaskInput(sourceTask(), { executor: 'claude' });
    expect(input.labels).toEqual(['bug', 'fanout:t-1']);
  });

  it('never sets derivedFrom, which would stop the clone being dispatched', () => {
    // `derivedFrom` marks a body as text from outside the repo, and the
    // orchestrator refuses to execute anything carrying it. A clone's body is
    // the user's own task; the label is what ties it back to the source.
    const input = variantTaskInput(sourceTask(), { executor: 'claude' });
    expect(input.derivedFrom).toBeUndefined();
    expect(input.labels).toContain('fanout:t-1');
  });

  it('does not re-inherit the original’s blockers', () => {
    // The clones are cut when the original is ready to run; re-inheriting
    // would park every one of them behind work that is already done.
    expect(
      variantTaskInput(sourceTask(), { executor: 'claude' }).blockedBy
    ).toBeUndefined();
  });

  it('pins the model when the variant names one', () => {
    expect(
      variantTaskInput(sourceTask(), { executor: 'codex', model: 'gpt-5.5' })
        .model
    ).toBe('gpt-5.5');
  });

  it('omits a parent the source does not have', () => {
    expect(
      variantTaskInput(sourceTask(), { executor: 'claude' }).parent
    ).toBeUndefined();
    expect(
      variantTaskInput(sourceTask({ parent: 'epic-1' }), { executor: 'claude' })
        .parent
    ).toBe('epic-1');
  });
});
