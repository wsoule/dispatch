import type { WardenAction, WardenRecord } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { useState } from 'react';

import type { WardenSession } from '../../hooks/useWardenSession';
import { WardenChat } from './WardenChat';

// The same fixture shapes wardenThread.test.ts builds; the component's whole
// backend is the WardenSession seam, so a fake session with a canned record
// exercises the real render and decide paths.
function wardenRecord(over: Partial<WardenRecord> = {}): WardenRecord {
  return {
    id: 'w-1',
    prompt: 'what is going on?',
    backendName: 'fake',
    state: 'ready',
    messages: [],
    pendingActions: [],
    undeliveredDecisions: [],
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:05Z',
    ...over,
  };
}

function wardenAction(over: Partial<WardenAction> = {}): WardenAction {
  return {
    id: 'act-1',
    tool: 'cancel_run',
    input: { runId: 'r-1' },
    summary: 'Cancel run r-1',
    createdAt: '2026-08-10T00:00:02Z',
    status: 'pending',
    ...over,
  };
}

function wardenSession(over: Partial<WardenSession> = {}): WardenSession {
  return {
    conversationId: null,
    record: undefined,
    recordError: null,
    submit: () => Promise.resolve(),
    sending: false,
    sendError: null,
    confirmAction: () => Promise.resolve(wardenRecord()),
    decidingActionId: null,
    reset: () => {},
    draft: '',
    setDraft: () => {},
    ...over,
  };
}

// The composer's text lives on the session now (it has to outlive the rail's
// tab flips and its collapse), so any test that types needs real state behind
// the fake session — the shape App gives the component in production.
function ChatWithDraft({
  warden,
  compact = false,
}: {
  warden: WardenSession;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState('');
  return (
    <WardenChat warden={{ ...warden, draft, setDraft }} compact={compact} />
  );
}

/**
 * Clicks a control whose handler starts a session call that actually resolves.
 * `submitDraft` and `decide` both settle a promise a microtask after the
 * click, and the session updates its flags there. Outside `act` that
 * update arrives after the test body has finished — React logs an act warning,
 * and the setState can fire while a later test's tree is the mounted one.
 * Tests whose fake never resolves have no such tail and click directly.
 */
async function clickAndSettle(button: HTMLElement): Promise<void> {
  fireEvent.click(button);
  await act(async () => {
    await Promise.resolve();
  });
}

// The full-page (non-compact) path — the branch WardenView renders after the
// extraction, previously covered by nothing.
test('full mode: the start card takes an opening question through warden.submit', async () => {
  const asked: string[] = [];
  const warden = wardenSession({
    submit: (prompt: string) => {
      asked.push(prompt);
      return Promise.resolve();
    },
  });
  render(<ChatWithDraft warden={warden} />);

  // Full-page copy, and no compact-only reset control.
  expect(
    screen.getByText(/every mutation waits for your explicit approval/)
  ).toBeDefined();
  expect(screen.queryByLabelText('Start a new conversation')).toBeNull();

  fireEvent.change(screen.getByLabelText('Warden opening question'), {
    target: { value: 'status?' },
  });
  await clickAndSettle(screen.getByRole('button', { name: 'Ask' }));
  expect(asked).toEqual(['status?']);
});

test('full mode: transcript renders bubbles and the confirm card decides through the session', async () => {
  const decisions: unknown[] = [];
  const record = wardenRecord({
    messages: [
      { role: 'user', text: 'cancel r-1', at: '2026-08-10T00:00:01Z' },
      { role: 'assistant', text: 'Queuing that.', at: '2026-08-10T00:00:02Z' },
      {
        role: 'action',
        actionId: 'act-1',
        outcome: 'pending',
        text: 'Queued: Cancel run r-1',
        at: '2026-08-10T00:00:03Z',
      },
    ],
    pendingActions: [wardenAction()],
  });
  const warden = wardenSession({
    conversationId: 'w-1',
    record,
    confirmAction: (actionId: string, approve: boolean) => {
      decisions.push([actionId, approve]);
      return Promise.resolve(record);
    },
  });
  render(<WardenChat warden={warden} />);

  expect(screen.getByText('cancel r-1')).toBeDefined();
  expect(screen.getByText('Queuing that.')).toBeDefined();
  expect(screen.getByText('Needs your approval')).toBeDefined();
  await clickAndSettle(
    screen.getByRole('button', { name: 'Deny: Cancel run r-1' })
  );
  expect(decisions).toEqual([['act-1', false]]);
});

test('full mode: a follow-up goes through warden.submit', async () => {
  const sent: string[] = [];
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord(),
    submit: (text: string) => {
      sent.push(text);
      return Promise.resolve();
    },
  });
  render(<ChatWithDraft warden={warden} />);

  fireEvent.change(screen.getByLabelText('Follow-up message'), {
    target: { value: 'and the queue?' },
  });
  await clickAndSettle(screen.getByRole('button', { name: 'Send' }));
  expect(sent).toEqual(['and the queue?']);
});

// The draft's clear-then-restore cycle belongs to `warden.submit` now — see
// useWardenSession.test.tsx for both halves of it. What this component still
// owns is reporting the failure the session recorded, and it has to read it
// from there rather than from state of its own: the rail unmounts this whole
// panel on a tab flip, which is exactly when a slow send tends to fail. A
// component-local error would be set on an unmounted tree and shown to nobody.
test('a send failure recorded on the session is reported by a freshly mounted chat', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord(),
    sendError: 'daemon unreachable',
  });
  // Mounting fresh is the point: this is the chat the user gets back after
  // flipping to Runs while the send was in flight and returning to Warden.
  render(<ChatWithDraft warden={warden} compact />);

  expect(screen.getByText('daemon unreachable')).toBeDefined();
});

// The same for the opening composer, which is a different branch of the render
// and used to carry a second, separate error flag.
test('a start failure recorded on the session is reported by the opening composer', () => {
  const warden = wardenSession({ sendError: 'dispatchd refused it' });
  render(<ChatWithDraft warden={warden} />);

  expect(screen.getByText('dispatchd refused it')).toBeDefined();
});

// `sending` is likewise the session's: a chat remounted mid-flight must come
// back with Send still disabled, not briefly re-enabled against a turn the
// server would 409.
test('an in-flight send keeps Send disabled on a freshly mounted chat', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord(),
    sending: true,
    draft: 'and the queue?',
  });
  render(<WardenChat warden={warden} compact />);

  // Matched by its visible label rather than its accessible name: the button
  // swaps in a spinner alongside the text while it is in flight.
  const send = screen.getByText('Sending…').closest('button');
  expect(send?.disabled).toBe(true);
});

// A permanently failed record fetch (404 + retry: false) is a broken
// conversation, not a turn in flight — the error banner and the 'answering…'
// composer hint must never show together.
test('a failed record fetch does not read as the warden answering', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: undefined,
    recordError: 'warden conversation w-1 not found (404)',
  });
  render(<WardenChat warden={warden} />);

  expect(
    screen.getByText('warden conversation w-1 not found (404)')
  ).toBeDefined();
  expect(screen.queryByText('The warden is answering…')).toBeNull();
});

// The compact reset is the only control that can discard the UI's handle on a
// conversation; with a mutation still awaiting a decision it must not.
test('compact mode: New resets when idle but is disabled while an action awaits approval', () => {
  let resets = 0;
  const idle = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord(),
    reset: () => {
      resets += 1;
    },
  });
  const first = render(<WardenChat warden={idle} compact />);
  const newButton = screen.getByRole('button', {
    name: 'Start a new conversation',
  });
  fireEvent.click(newButton);
  expect(resets).toBe(1);
  first.unmount();

  const pending = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ pendingActions: [wardenAction()] }),
    reset: () => {
      resets += 1;
    },
  });
  render(<WardenChat warden={pending} compact />);
  const gated = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Start a new conversation',
  });
  expect(gated.disabled).toBe(true);
  fireEvent.click(gated);
  expect(resets).toBe(1);
});

// The busy veto only applies when no record ever loaded. With a running record
// cached, one failed background refetch must not flip the composer open
// against a turn dispatchd would still 409.
test('a transient refetch error mid-turn still reads as the warden answering', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ state: 'running' }),
    recordError: 'daemon busy (500)',
  });
  render(<WardenChat warden={warden} />);
  expect(screen.getByText('The warden is answering…')).toBeDefined();
});

// The reset gate must not guard a ghost. A conversation the daemon has lost
// arrives here as `record: undefined` — useWardenSession does that veto on the
// 404 (see its own tests) — so nothing is pending and the reset is the escape.
test('compact New is enabled again once the conversation is gone', () => {
  let resets = 0;
  const warden = wardenSession({
    conversationId: 'w-1',
    record: undefined,
    recordError: 'warden conversation w-1 not found (404)',
    reset: () => {
      resets += 1;
    },
  });
  render(<WardenChat warden={warden} compact />);
  const reset = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Start a new conversation',
  });
  expect(reset.disabled).toBe(false);
  fireEvent.click(reset);
  expect(resets).toBe(1);
});

// The direction the ghost guard used to break: a transient refetch failure
// leaves the queued mutation alive server-side, and the confirm card on screen.
// Unlocking the reset there would let one click strand it undecidable.
test('a transient refetch error keeps the reset locked behind the pending action', () => {
  let resets = 0;
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ pendingActions: [wardenAction()] }),
    recordError: 'daemon busy (500)',
    reset: () => {
      resets += 1;
    },
  });
  render(<WardenChat warden={warden} compact />);
  expect(screen.getByText('Needs your approval')).toBeDefined();
  const reset = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Start a new conversation',
  });
  expect(reset.disabled).toBe(true);
  fireEvent.click(reset);
  expect(resets).toBe(0);
});

// One model turn can queue two mutations, and decide() takes a single lock.
// The second card's buttons must go with it: enabled, they would look live and
// silently swallow the click.
test('a decision in flight disables every confirm card, not just its own', () => {
  const decisions: unknown[] = [];
  const record = wardenRecord({
    messages: [
      {
        role: 'action',
        actionId: 'act-1',
        outcome: 'pending',
        text: 'Queued: Cancel run r-1',
        at: '2026-08-10T00:00:02Z',
      },
      {
        role: 'action',
        actionId: 'act-2',
        outcome: 'pending',
        text: 'Queued: Cancel run r-2',
        at: '2026-08-10T00:00:03Z',
      },
    ],
    pendingActions: [
      wardenAction(),
      wardenAction({
        id: 'act-2',
        summary: 'Cancel run r-2',
        input: { runId: 'r-2' },
      }),
    ],
  });
  // The lock lives on the session now, so the fake has to raise it the way
  // useWardenSession does — otherwise the state under test is never entered.
  // The call never resolves: the point is what the UI looks like *during* a
  // decision.
  function ChatWithDecision() {
    const [decidingActionId, setDecidingActionId] = useState<string | null>(
      null
    );
    return (
      <WardenChat
        warden={wardenSession({
          conversationId: 'w-1',
          record,
          decidingActionId,
          confirmAction: (actionId: string, approve: boolean) => {
            decisions.push([actionId, approve]);
            setDecidingActionId(actionId);
            return new Promise<WardenRecord>(() => {});
          },
        })}
      />
    );
  }
  render(<ChatWithDecision />);

  fireEvent.click(
    screen.getByRole('button', { name: 'Approve: Cancel run r-1' })
  );
  expect(decisions).toEqual([['act-1', true]]);

  const otherDeny = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Deny: Cancel run r-2',
  });
  expect(otherDeny.disabled).toBe(true);
  fireEvent.click(otherDeny);
  expect(decisions).toEqual([['act-1', true]]);
});

// Every surface mounts this chat with a real layout box, so the pin has no
// hidden case to skip — it just has to follow the newest row.
// scrollHeight/scrollTop are defined by hand because happy-dom has no layout.
test('a new transcript row re-pins to the bottom', () => {
  const messages = [
    { role: 'user' as const, text: 'status?', at: '2026-08-10T00:00:01Z' },
  ];
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ messages }),
  });
  const { rerender } = render(<WardenChat warden={warden} compact />);

  const log = screen.getByRole('log');
  Object.defineProperty(log, 'scrollHeight', {
    value: 480,
    configurable: true,
  });
  Object.defineProperty(log, 'scrollTop', {
    value: 0,
    writable: true,
    configurable: true,
  });
  expect(log.scrollTop).toBe(0);

  rerender(
    <WardenChat
      warden={wardenSession({
        conversationId: 'w-1',
        record: wardenRecord({
          messages: [
            ...messages,
            {
              role: 'assistant',
              text: 'All quiet.',
              at: '2026-08-10T00:00:02Z',
            },
          ],
        }),
      })}
      compact
    />
  );
  expect(log.scrollTop).toBe(480);
});

// The case `lastKey` is in the scroll effect's deps for, and the one the
// row-count test above cannot reach: a turn settling in place. While the
// record is `running` the thread is [user message, pending spinner]; when it
// settles it is [user message, assistant reply] — the same two rows, with a
// different one at the bottom. Keyed on `thread.length` alone the effect would
// not re-run and the reply the user was waiting for would land below the fold.
test('a turn settling in place re-pins to the bottom', () => {
  const messages = [
    { role: 'user' as const, text: 'status?', at: '2026-08-10T00:00:01Z' },
  ];
  const { rerender } = render(
    <WardenChat
      warden={wardenSession({
        conversationId: 'w-1',
        record: wardenRecord({ messages, state: 'running' }),
      })}
      compact
    />
  );

  const log = screen.getByRole('log');
  // The running turn contributes its own row, so the count is already 2.
  expect(log.children).toHaveLength(2);
  Object.defineProperty(log, 'scrollHeight', {
    value: 512,
    configurable: true,
  });
  Object.defineProperty(log, 'scrollTop', {
    value: 0,
    writable: true,
    configurable: true,
  });

  rerender(
    <WardenChat
      warden={wardenSession({
        conversationId: 'w-1',
        record: wardenRecord({
          state: 'ready',
          messages: [
            ...messages,
            {
              role: 'assistant',
              text: 'All quiet.',
              at: '2026-08-10T00:00:02Z',
            },
          ],
        }),
      })}
      compact
    />
  );

  // Still two rows — only the identity of the last one changed.
  expect(log.children).toHaveLength(2);
  expect(log.scrollTop).toBe(512);
});
