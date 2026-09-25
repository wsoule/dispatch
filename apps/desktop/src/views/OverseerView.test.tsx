import type { OverseerAction, OverseerRecord } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { OverseerSession } from '../hooks/useOverseerSession';
import { OverseerView } from './OverseerView';

// The view only reads the daemon-gate fields off the project data; everything
// conversational goes through the OverseerSession seam, same as the chat tests.
const DAEMON_UP = {
  portLoading: false,
  portError: false,
  portErrorDetail: null,
  client: {},
  retryEnsureDispatchd: () => {},
} as unknown as DispatchProjectData;

function overseerRecord(over: Partial<OverseerRecord> = {}): OverseerRecord {
  return {
    id: 'w-1',
    prompt: 'what is going on?',
    backendName: 'fake',
    state: 'ready',
    messages: [],
    pendingActions: [],
    pendingApprovals: [],
    undeliveredDecisions: [],
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:05Z',
    ...over,
  };
}

function overseerAction(over: Partial<OverseerAction> = {}): OverseerAction {
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

function overseerSession(over: Partial<OverseerSession> = {}): OverseerSession {
  return {
    conversationId: null,
    record: undefined,
    recordError: null,
    submit: () => Promise.resolve(),
    sending: false,
    sendError: null,
    confirmAction: () => Promise.resolve(),
    decidingActionId: null,
    decideApproval: () => Promise.resolve(),
    decidingRequestId: null,
    decideError: null,
    model: 'claude-opus-5',
    setModel: () => {},
    effortId: 'default',
    setEffortId: () => {},
    configuredEffort: undefined,
    reset: () => {},
    draft: '',
    setDraft: () => {},
    ...over,
  };
}

// The header reset must obey the same invariant as OverseerChat's compact one:
// reset() drops the only UI handle on the conversation, so it stays disabled
// while a queued mutation still needs a decision.
test('New conversation resets when idle but is disabled while an action awaits approval', () => {
  let resets = 0;
  const idle = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord(),
    reset: () => {
      resets += 1;
    },
  });
  const first = render(<OverseerView data={DAEMON_UP} overseer={idle} />);
  fireEvent.click(screen.getByRole('button', { name: /New conversation/ }));
  expect(resets).toBe(1);
  first.unmount();

  const pending = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ pendingActions: [overseerAction()] }),
    reset: () => {
      resets += 1;
    },
  });
  render(<OverseerView data={DAEMON_UP} overseer={pending} />);
  const gated = screen.getByRole<HTMLButtonElement>('button', {
    name: /New conversation/,
  });
  expect(gated.disabled).toBe(true);
  fireEvent.click(gated);
  expect(resets).toBe(1);
});

// The gate must not guard a ghost. A conversation dispatchd has lost arrives
// here as `record: undefined` (useOverseerSession vetoes it on the 404), so
// nothing is pending and the page's reset is the way out.
test('New conversation is enabled again once the conversation is gone', () => {
  let resets = 0;
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: undefined,
    recordError: 'overseer conversation w-1 not found (404)',
    reset: () => {
      resets += 1;
    },
  });
  render(<OverseerView data={DAEMON_UP} overseer={overseer} />);
  const reset = screen.getByRole<HTMLButtonElement>('button', {
    name: /New conversation/,
  });
  expect(reset.disabled).toBe(false);
  fireEvent.click(reset);
  expect(resets).toBe(1);
});

// And the direction the old blanket veto broke: a refetch blip leaves the
// queued mutation alive server-side and its confirm card on screen, so the
// header reset must stay locked rather than offer a one-click way to strand it.
test('New conversation stays locked through a transient refetch error', () => {
  let resets = 0;
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ pendingActions: [overseerAction()] }),
    recordError: 'daemon busy (500)',
    reset: () => {
      resets += 1;
    },
  });
  render(<OverseerView data={DAEMON_UP} overseer={overseer} />);
  const reset = screen.getByRole<HTMLButtonElement>('button', {
    name: /New conversation/,
  });
  expect(reset.disabled).toBe(true);
  fireEvent.click(reset);
  expect(resets).toBe(0);
});

// The page header: the `Overseer` crumb, with the reset as a ghost action beside it.
test('the header carries the crumb and the reset as a ghost action', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord(),
  });
  render(<OverseerView data={DAEMON_UP} overseer={overseer} />);
  const header = screen
    .getByText('Assistant')
    .closest('[data-slot=page-header]');
  expect(header).not.toBeNull();
  const reset = screen.getByRole('button', { name: /New conversation/ });
  expect(reset.getAttribute('data-variant')).toBe('ghost');
  expect(header?.contains(reset)).toBe(true);
});
