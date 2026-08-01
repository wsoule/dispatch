import type { PlannerQuestion } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { composeAnswers, unansweredCount } from './planQuestions';

// Two scripted questions, one with option chips and one open-ended — enough variety to
// exercise the composed message without every test having to restate the fixture.
const QUESTIONS: PlannerQuestion[] = [
  {
    id: 'q1',
    question: 'Should this cover the mobile app too?',
    options: ['Desktop only', 'Both'],
  },
  {
    id: 'q2',
    question: 'Any existing code this should build on?',
    options: [],
  },
];

describe('composeAnswers', () => {
  test('composes one Q/A pair per question, in order', () => {
    const message = composeAnswers(QUESTIONS, {
      q1: 'Desktop only',
      q2: 'Reuse the run executor.',
    });
    expect(message).toBe(
      'Q: Should this cover the mobile app too?\nA: Desktop only\n\n' +
        'Q: Any existing code this should build on?\nA: Reuse the run executor.'
    );
  });

  test('answers with only whitespace are treated as unanswered', () => {
    const message = composeAnswers(QUESTIONS, { q1: '   ', q2: 'Yes' });
    expect(message).toContain(
      'Q: Should this cover the mobile app too?\nA: (no answer — use your best judgement)'
    );
    expect(message).toContain(
      'Q: Any existing code this should build on?\nA: Yes'
    );
  });

  test('partial answers fill unanswered questions with a best-judgement placeholder', () => {
    const message = composeAnswers(QUESTIONS, { q1: 'Both' });
    expect(message).toBe(
      'Q: Should this cover the mobile app too?\nA: Both\n\n' +
        'Q: Any existing code this should build on?\nA: (no answer — use your best judgement)'
    );
  });

  test('skip (no answers at all) tells the planner to use its own judgement throughout', () => {
    const message = composeAnswers(QUESTIONS, {});
    expect(message).toBe(
      'Q: Should this cover the mobile app too?\nA: (no answer — use your best judgement)\n\n' +
        'Q: Any existing code this should build on?\nA: (no answer — use your best judgement)'
    );
  });

  test('an empty question list composes an empty message', () => {
    expect(composeAnswers([], { q1: 'Both' })).toBe('');
  });
});

describe('unansweredCount', () => {
  test('counts every question with no answer at all', () => {
    expect(unansweredCount(QUESTIONS, {})).toBe(2);
  });

  test('counts down as answers are filled in', () => {
    expect(unansweredCount(QUESTIONS, { q1: 'Both' })).toBe(1);
    expect(
      unansweredCount(QUESTIONS, { q1: 'Both', q2: 'Reuse the executor.' })
    ).toBe(0);
  });

  test('a whitespace-only answer still counts as unanswered', () => {
    expect(unansweredCount(QUESTIONS, { q1: '   ', q2: 'Yes' })).toBe(1);
  });

  test('answers for unknown ids are ignored', () => {
    expect(unansweredCount(QUESTIONS, { bogus: 'x' })).toBe(2);
  });
});
