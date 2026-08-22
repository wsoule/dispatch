import type { WardenAction, WardenRecord } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

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
    start: () => Promise.resolve(wardenRecord()),
    sendMessage: () => Promise.resolve(wardenRecord()),
    confirmAction: () => Promise.resolve(wardenRecord()),
    reset: () => {},
    ...over,
  };
}

// The full-page (non-compact) path — the branch WardenView renders after the
// extraction, previously covered by nothing.
test('full mode: the start card takes an opening question through warden.start', () => {
  const asked: string[] = [];
  const warden = wardenSession({
    start: (prompt: string) => {
      asked.push(prompt);
      return Promise.resolve(wardenRecord());
    },
  });
  render(<WardenChat warden={warden} />);

  // Full-page copy, and no compact-only reset control.
  expect(
    screen.getByText(/every mutation waits for your explicit approval/)
  ).toBeDefined();
  expect(screen.queryByLabelText('New warden conversation')).toBeNull();

  fireEvent.change(screen.getByLabelText('Warden opening question'), {
    target: { value: 'status?' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  expect(asked).toEqual(['status?']);
});

test('full mode: transcript renders bubbles and the confirm card decides through the session', () => {
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
  fireEvent.click(screen.getByRole('button', { name: 'Deny: Cancel run r-1' }));
  expect(decisions).toEqual([['act-1', false]]);
});

test('full mode: a follow-up goes through warden.sendMessage', () => {
  const sent: string[] = [];
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord(),
    sendMessage: (text: string) => {
      sent.push(text);
      return Promise.resolve(wardenRecord());
    },
  });
  render(<WardenChat warden={warden} />);

  fireEvent.change(screen.getByLabelText('Follow-up message'), {
    target: { value: 'and the queue?' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(sent).toEqual(['and the queue?']);
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
    name: 'New warden conversation',
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
    name: 'New warden conversation',
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

// The reset gate must not guard a ghost: a cached record whose refetch fails
// is usually a daemon restart that wiped the in-memory conversation, and a
// locked reset would leave no way to start over.
test('compact New is enabled again when the record refetch is failing', () => {
  let resets = 0;
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ pendingActions: [wardenAction()] }),
    recordError: 'warden conversation w-1 not found (404)',
    reset: () => {
      resets += 1;
    },
  });
  render(<WardenChat warden={warden} compact />);
  const reset = screen.getByRole<HTMLButtonElement>('button', {
    name: 'New warden conversation',
  });
  expect(reset.disabled).toBe(false);
  fireEvent.click(reset);
  expect(resets).toBe(1);
});

// The scroll pin skips while the chat is display:none (scrollHeight is 0
// there) and re-runs on the visible edge. scrollHeight/scrollTop are defined
// by hand because happy-dom has no layout.
test('the transcript re-pins when visible flips true', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({
      messages: [
        { role: 'user', text: 'status?', at: '2026-08-10T00:00:01Z' },
        { role: 'assistant', text: 'All quiet.', at: '2026-08-10T00:00:02Z' },
      ],
    }),
  });
  const { rerender } = render(
    <WardenChat warden={warden} compact visible={false} />
  );
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

  rerender(<WardenChat warden={warden} compact visible />);
  expect(log.scrollTop).toBe(480);
});
