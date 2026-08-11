import type {
  WardenAction,
  WardenMessage,
  WardenRecord,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { buildWardenThread } from './wardenThread';

function makeAction(overrides: Partial<WardenAction> = {}): WardenAction {
  return {
    id: 'act-1',
    tool: 'cancel_run',
    input: { runId: 'r-1' },
    summary: 'Cancel run r-1',
    createdAt: '2026-08-10T00:00:02Z',
    status: 'pending',
    ...overrides,
  };
}

function makeRecord(
  messages: WardenMessage[],
  overrides: Partial<WardenRecord> = {}
): WardenRecord {
  return {
    id: 'w-1',
    prompt: 'what is going on?',
    backendName: 'claude',
    state: 'ready',
    messages,
    pendingActions: [],
    undeliveredDecisions: [],
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:05Z',
    ...overrides,
  };
}

const at = '2026-08-10T00:00:01Z';

describe('buildWardenThread', () => {
  test('an undefined record renders nothing', () => {
    expect(buildWardenThread(undefined)).toEqual([]);
  });

  test('user and assistant turns become message rows in order', () => {
    const items = buildWardenThread(
      makeRecord([
        { role: 'user', text: 'status?', at },
        { role: 'assistant', text: 'All quiet.', at },
      ])
    );
    expect(items).toEqual([
      { kind: 'message', key: 'w-1-msg-0', role: 'user', text: 'status?', at },
      {
        kind: 'message',
        key: 'w-1-msg-1',
        role: 'assistant',
        text: 'All quiet.',
        at,
      },
    ]);
  });

  test('read-only tool calls become muted tool rows', () => {
    const items = buildWardenThread(
      makeRecord([{ role: 'tool', tool: 'list_runs', text: '3 runs', at }])
    );
    expect(items).toEqual([
      { kind: 'tool', key: 'w-1-msg-0', tool: 'list_runs', text: '3 runs', at },
    ]);
  });

  test('a still-pending action renders as one confirm card, not a transcript row', () => {
    const action = makeAction();
    const items = buildWardenThread(
      makeRecord(
        [
          { role: 'user', text: 'cancel r-1', at },
          {
            role: 'action',
            tool: action.tool,
            actionId: action.id,
            outcome: 'pending',
            text: action.summary,
            at,
          },
        ],
        { pendingActions: [action] }
      )
    );
    expect(items).toEqual([
      {
        kind: 'message',
        key: 'w-1-msg-0',
        role: 'user',
        text: 'cancel r-1',
        at,
      },
      { kind: 'confirm', key: 'w-1-confirm-act-1', action, failure: null },
    ]);
  });

  test('a decided action keeps its outcome row and drops the stale queued row', () => {
    const items = buildWardenThread(
      makeRecord([
        {
          role: 'action',
          tool: 'cancel_run',
          actionId: 'act-1',
          outcome: 'pending',
          text: 'Cancel run r-1',
          at,
        },
        {
          role: 'action',
          tool: 'cancel_run',
          actionId: 'act-1',
          outcome: 'applied',
          text: 'Applied: Cancel run r-1',
          at,
        },
      ])
    );
    expect(items).toEqual([
      {
        kind: 'outcome',
        key: 'w-1-msg-1',
        outcome: 'applied',
        text: 'Applied: Cancel run r-1',
        at,
      },
    ]);
  });

  test('a denied action renders only its denial row', () => {
    const items = buildWardenThread(
      makeRecord([
        {
          role: 'action',
          tool: 'cancel_run',
          actionId: 'act-1',
          outcome: 'pending',
          text: 'Cancel run r-1',
          at,
        },
        {
          role: 'action',
          tool: 'cancel_run',
          actionId: 'act-1',
          outcome: 'denied',
          text: 'Denied: Cancel run r-1',
          at,
        },
      ])
    );
    expect(items).toEqual([
      {
        kind: 'outcome',
        key: 'w-1-msg-1',
        outcome: 'denied',
        text: 'Denied: Cancel run r-1',
        at,
      },
    ]);
  });

  test('a failed approval moves the confirm card to the failure row and carries its text', () => {
    // The server restores a failed-apply action to pending and appends a
    // `failed` lifecycle row — the card should sit at that newest row, once,
    // with the failure surfaced for the retry.
    const action = makeAction();
    const items = buildWardenThread(
      makeRecord(
        [
          {
            role: 'action',
            tool: action.tool,
            actionId: action.id,
            outcome: 'pending',
            text: action.summary,
            at,
          },
          { role: 'assistant', text: 'Queued the cancel.', at },
          {
            role: 'action',
            tool: action.tool,
            actionId: action.id,
            outcome: 'failed',
            text: 'Failed: Cancel run r-1 — run already terminal',
            at,
          },
        ],
        { pendingActions: [action] }
      )
    );
    expect(items).toEqual([
      {
        kind: 'message',
        key: 'w-1-msg-1',
        role: 'assistant',
        text: 'Queued the cancel.',
        at,
      },
      {
        kind: 'confirm',
        key: 'w-1-confirm-act-1',
        action,
        failure: 'Failed: Cancel run r-1 — run already terminal',
      },
    ]);
  });

  test('a pending action missing its transcript row still gets a card', () => {
    const action = makeAction();
    const items = buildWardenThread(
      makeRecord([{ role: 'user', text: 'cancel it', at }], {
        pendingActions: [action],
      })
    );
    expect(items).toEqual([
      {
        kind: 'message',
        key: 'w-1-msg-0',
        role: 'user',
        text: 'cancel it',
        at,
      },
      { kind: 'confirm', key: 'w-1-confirm-act-1', action, failure: null },
    ]);
  });

  test('a running record appends a trailing pending row', () => {
    const items = buildWardenThread(
      makeRecord([{ role: 'user', text: 'status?', at }], { state: 'running' })
    );
    expect(items[items.length - 1]).toEqual({
      kind: 'pending',
      key: 'w-1-pending',
    });
  });

  test('a failed record appends its error, with a fallback when the server sent none', () => {
    const withError = buildWardenThread(
      makeRecord([], { state: 'failed', error: 'model unavailable' })
    );
    expect(withError).toEqual([
      { kind: 'failed', key: 'w-1-failed', error: 'model unavailable' },
    ]);

    const withoutError = buildWardenThread(makeRecord([], { state: 'failed' }));
    expect(withoutError[0]?.kind).toBe('failed');
    expect(
      withoutError[0]?.kind === 'failed' ? withoutError[0].error : ''
    ).toContain('Send the message again');
  });

  test('two pending actions each get their own card', () => {
    const first = makeAction();
    const second = makeAction({ id: 'act-2', summary: 'Dequeue run r-2' });
    const items = buildWardenThread(
      makeRecord(
        [
          {
            role: 'action',
            tool: first.tool,
            actionId: first.id,
            outcome: 'pending',
            text: first.summary,
            at,
          },
          {
            role: 'action',
            tool: second.tool,
            actionId: second.id,
            outcome: 'pending',
            text: second.summary,
            at,
          },
        ],
        { pendingActions: [first, second] }
      )
    );
    expect(items).toEqual([
      {
        kind: 'confirm',
        key: 'w-1-confirm-act-1',
        action: first,
        failure: null,
      },
      {
        kind: 'confirm',
        key: 'w-1-confirm-act-2',
        action: second,
        failure: null,
      },
    ]);
  });
});
