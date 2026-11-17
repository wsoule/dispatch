import type { Message } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { askerOf, decisionCard, preview } from '../src/decisions';

function message(over: Partial<Message>): Message {
  return {
    id: 'm-1',
    thread: 'th-1',
    replyTo: null,
    from: 'run:r-7',
    to: ['human:ada'],
    kind: 'question',
    body: 'Which library should we use?',
    refs: [],
    urgent: false,
    blocking: true,
    wake: 'none',
    createdAt: '2026-11-14T10:00:00.000Z',
    ...over,
  } as Message;
}

const approval = (over: Partial<Message> = {}) =>
  message({
    from: 'agent:dispatch',
    body: 'Allow Bash?',
    data: {
      type: 'tool-approval',
      requestId: 'q-1',
      runId: 'r-7',
      tool: 'Bash',
      input: { command: 'pnpm --filter server test' },
      floor: false,
    },
    choices: ['approve', 'approve-session', 'deny'],
    ...over,
  });

describe('a tool approval card', () => {
  test('shows the command and sends approve, approve-session or deny', () => {
    const card = decisionCard(approval());
    expect(card.kind).toBe('approval');
    expect(card.title).toBe('Allow Bash?');
    expect(card.code).toBe('pnpm --filter server test');
    expect(card.runId).toBe('r-7');
    expect(card.freeText).toBe(false);
    expect(card.actions.map((a) => [a.label, a.reply.choice])).toEqual([
      ['Allow', 'approve'],
      ['Allow for run', 'approve-session'],
      ['Deny', 'deny'],
    ]);
  });

  test('offers no "for run" when the floor holds the call', () => {
    const card = decisionCard(approval({ choices: ['approve', 'deny'] }));
    expect(card.actions.map((a) => a.label)).toEqual(['Allow', 'Deny']);
  });

  test('says when the input was cut short', () => {
    const base = approval();
    const card = decisionCard({
      ...base,
      data: { ...(base.data as object), truncated: true },
    } as Message);
    expect(card.truncated).toBe(true);
  });
});

describe('a scope request card', () => {
  test('lists the paths and sends grant or deny', () => {
    const card = decisionCard(
      message({
        data: {
          type: 'scope',
          paths: ['packages/ui/a.ts', 'packages/ui/b.ts'],
          reason: 'The fix touches the shared button',
        },
      })
    );
    expect(card.kind).toBe('scope');
    expect(card.body).toBe('The fix touches the shared button');
    expect(card.code).toBe('packages/ui/a.ts\npackages/ui/b.ts');
    expect(card.actions.map((a) => a.reply)).toEqual([
      { body: '', choice: 'grant' },
      { body: '', choice: 'deny' },
    ]);
  });
});

describe('a question card', () => {
  test("offers the run's choices and an answer in words", () => {
    const card = decisionCard(message({ choices: ['date-fns', 'moment'] }));
    expect(card.kind).toBe('question');
    expect(card.title).toBe('A run asks');
    expect(card.body).toBe('Which library should we use?');
    expect(card.freeText).toBe(true);
    expect(card.actions.map((a) => a.reply)).toEqual([
      { body: 'date-fns', choice: 'date-fns' },
      { body: 'moment', choice: 'moment' },
    ]);
  });

  test('names who asks', () => {
    expect(askerOf(message({ from: 'agent:ada/overseer' }))).toBe(
      'The Overseer'
    );
    // Only the exact address is the Overseer; other agents say they are one.
    expect(askerOf(message({ from: 'agent:overseer-bot' }))).toBe(
      'Agent overseer-bot'
    );
    expect(askerOf(message({ from: 'agent:ada/overseer/x' }))).toBe(
      'Agent ada/overseer/x'
    );
    expect(askerOf(message({ from: 'human:wyat' }))).toBe('wyat');
    expect(decisionCard(message({ from: 'human:wyat' })).runId).toBeNull();
  });
});

describe('a tool input preview', () => {
  test('prefers the command or path, else short JSON', () => {
    expect(preview({ file_path: 'src/a.ts', content: 'x' })).toBe('src/a.ts');
    expect(preview({ a: 1 })).toBe('{"a":1}');
    expect(preview({ blob: 'x'.repeat(500) }).endsWith('…')).toBe(true);
  });
});
