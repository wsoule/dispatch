import type { OverseerAction, OverseerRecord } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { useState } from 'react';

import type { OverseerSession } from '../../hooks/useOverseerSession';
import { OverseerChat } from './OverseerChat';

// The same fixture shapes overseerThread.test.ts builds; the component's whole
// backend is the OverseerSession seam, so a fake session with a canned record
// exercises the real render and decide paths.
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

// The composer's text lives on the session now (it has to outlive the rail's
// tab flips and its collapse), so any test that types needs real state behind
// the fake session — the shape App gives the component in production.
function ChatWithDraft({
  overseer,
  compact = false,
}: {
  overseer: OverseerSession;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState('');
  return (
    <OverseerChat
      overseer={{ ...overseer, draft, setDraft }}
      compact={compact}
    />
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

// The full-page (non-compact) path — the branch OverseerView renders after the
// extraction, previously covered by nothing.
test('full mode: the start card takes an opening question through overseer.submit', async () => {
  const asked: string[] = [];
  const overseer = overseerSession({
    submit: (prompt: string) => {
      asked.push(prompt);
      return Promise.resolve();
    },
  });
  render(<ChatWithDraft overseer={overseer} />);

  // Full-page copy, and no compact-only reset control.
  expect(
    screen.getByText(/every mutation waits for your explicit approval/)
  ).toBeDefined();
  expect(screen.queryByLabelText('Start a new conversation')).toBeNull();

  fireEvent.change(screen.getByLabelText('Overseer opening question'), {
    target: { value: 'status?' },
  });
  await clickAndSettle(screen.getByRole('button', { name: 'Send' }));
  expect(asked).toEqual(['status?']);
});

test('full mode: transcript renders bubbles and the confirm card decides through the session', async () => {
  const decisions: unknown[] = [];
  const record = overseerRecord({
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
    pendingActions: [overseerAction()],
  });
  const overseer = overseerSession({
    conversationId: 'w-1',
    record,
    confirmAction: (actionId: string, approve: boolean) => {
      decisions.push([actionId, approve]);
      return Promise.resolve();
    },
  });
  render(<OverseerChat overseer={overseer} />);

  expect(screen.getByText('cancel r-1')).toBeDefined();
  expect(screen.getByText('Queuing that.')).toBeDefined();
  expect(screen.getByText('Needs your approval')).toBeDefined();
  await clickAndSettle(
    screen.getByRole('button', { name: 'Deny: Cancel run r-1' })
  );
  expect(decisions).toEqual([['act-1', false]]);
});

test('full mode: a follow-up goes through overseer.submit', async () => {
  const sent: string[] = [];
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord(),
    submit: (text: string) => {
      sent.push(text);
      return Promise.resolve();
    },
  });
  render(<ChatWithDraft overseer={overseer} />);

  fireEvent.change(screen.getByLabelText('Follow-up message'), {
    target: { value: 'and the queue?' },
  });
  await clickAndSettle(screen.getByRole('button', { name: 'Send' }));
  expect(sent).toEqual(['and the queue?']);
});

// The draft's clear-then-restore cycle belongs to `overseer.submit` now — see
// useOverseerSession.test.tsx for both halves of it. What this component still
// owns is reporting the failure the session recorded, and it has to read it
// from there rather than from state of its own: the rail unmounts this whole
// panel on a tab flip, which is exactly when a slow send tends to fail. A
// component-local error would be set on an unmounted tree and shown to nobody.
test('a send failure recorded on the session is reported by a freshly mounted chat', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord(),
    sendError: 'daemon unreachable',
  });
  // Mounting fresh is the point: this is the chat the user gets back after
  // flipping to Runs while the send was in flight and returning to Overseer.
  render(<ChatWithDraft overseer={overseer} compact />);

  expect(screen.getByText('daemon unreachable')).toBeDefined();
});

// The same for the opening composer, which is a different branch of the render
// and used to carry a second, separate error flag.
test('a start failure recorded on the session is reported by the opening composer', () => {
  const overseer = overseerSession({ sendError: 'dispatchd refused it' });
  render(<ChatWithDraft overseer={overseer} />);

  expect(screen.getByText('dispatchd refused it')).toBeDefined();
});

// `sending` is likewise the session's: a chat remounted mid-flight must come
// back with Send still disabled, not briefly re-enabled against a turn the
// server would 409.
test('an in-flight send keeps Send disabled on a freshly mounted chat', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord(),
    sending: true,
    draft: 'and the queue?',
  });
  render(<OverseerChat overseer={overseer} compact />);

  const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
  expect(send.disabled).toBe(true);
});

// A permanently failed record fetch (404 + retry: false) is a broken
// conversation, not a turn in flight — the error banner and the 'answering…'
// composer hint must never show together.
test('a failed record fetch does not read as the overseer answering', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: undefined,
    recordError: 'overseer conversation w-1 not found (404)',
  });
  render(<OverseerChat overseer={overseer} />);

  expect(
    screen.getByText('overseer conversation w-1 not found (404)')
  ).toBeDefined();
  expect(screen.queryByText('The overseer is answering…')).toBeNull();
});

// The compact reset is the only control that can discard the UI's handle on a
// conversation; with a mutation still awaiting a decision it must not.
test('compact mode: New resets when idle but is disabled while an action awaits approval', () => {
  let resets = 0;
  const idle = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord(),
    reset: () => {
      resets += 1;
    },
  });
  const first = render(<OverseerChat overseer={idle} compact />);
  const newButton = screen.getByRole('button', {
    name: 'Start a new conversation',
  });
  fireEvent.click(newButton);
  expect(resets).toBe(1);
  first.unmount();

  const pending = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ pendingActions: [overseerAction()] }),
    reset: () => {
      resets += 1;
    },
  });
  render(<OverseerChat overseer={pending} compact />);
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
test('a transient refetch error mid-turn still reads as the overseer answering', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ state: 'running' }),
    recordError: 'daemon busy (500)',
  });
  render(<OverseerChat overseer={overseer} />);
  expect(screen.getByText('The overseer is answering…')).toBeDefined();
});

// The reset gate must not guard a ghost. A conversation the daemon has lost
// arrives here as `record: undefined` — useOverseerSession does that veto on the
// 404 (see its own tests) — so nothing is pending and the reset is the escape.
test('compact New is enabled again once the conversation is gone', () => {
  let resets = 0;
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: undefined,
    recordError: 'overseer conversation w-1 not found (404)',
    reset: () => {
      resets += 1;
    },
  });
  render(<OverseerChat overseer={overseer} compact />);
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
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ pendingActions: [overseerAction()] }),
    recordError: 'daemon busy (500)',
    reset: () => {
      resets += 1;
    },
  });
  render(<OverseerChat overseer={overseer} compact />);
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
  const record = overseerRecord({
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
      overseerAction(),
      overseerAction({
        id: 'act-2',
        summary: 'Cancel run r-2',
        input: { runId: 'r-2' },
      }),
    ],
  });
  // The lock lives on the session now, so the fake has to raise it the way
  // useOverseerSession does — otherwise the state under test is never entered.
  // The call never resolves: the point is what the UI looks like *during* a
  // decision.
  function ChatWithDecision() {
    const [decidingActionId, setDecidingActionId] = useState<string | null>(
      null
    );
    return (
      <OverseerChat
        overseer={overseerSession({
          conversationId: 'w-1',
          record,
          decidingActionId,
          confirmAction: (actionId: string, approve: boolean) => {
            decisions.push([actionId, approve]);
            setDecidingActionId(actionId);
            return new Promise<void>(() => {});
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
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ messages }),
  });
  const { rerender } = render(<OverseerChat overseer={overseer} compact />);

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
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
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
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({ messages, state: 'running' }),
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
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
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

// A parked built-in call is the one row where the session is blocked right
// now: the card offers the three answers a run's approval does, and each one
// reaches the session's decideApproval with the matching decision.
test('a parked tool call renders an allow/deny card wired to decideApproval', async () => {
  const decisions: unknown[] = [];
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({
      state: 'running',
      messages: [
        {
          role: 'user',
          text: 'is the tree clean?',
          at: '2026-08-10T00:00:00Z',
        },
        {
          role: 'approval',
          tool: 'Bash',
          requestId: 'req-1',
          outcome: 'pending',
          text: 'Bash: git status',
          at: '2026-08-10T00:00:01Z',
        },
      ],
      pendingApprovals: [
        {
          requestId: 'req-1',
          toolName: 'Bash',
          input: { command: 'git status' },
          summary: 'Bash: git status',
          requestedAt: '2026-08-10T00:00:01Z',
        },
      ],
    }),
    decideApproval: (requestId, decision) => {
      decisions.push([requestId, decision]);
      return Promise.resolve();
    },
  });
  render(<ChatWithDraft overseer={overseer} />);

  expect(screen.getByText('Wants to run')).toBeDefined();
  expect(screen.getByText('Bash: git status')).toBeDefined();
  // Blocked on the human, so no "working" spinner row under the card.
  expect(screen.queryByText('The overseer is working…')).toBeNull();

  await clickAndSettle(
    screen.getByRole('button', { name: 'Allow: Bash: git status' })
  );
  await clickAndSettle(
    screen.getByRole('button', { name: 'Allow Bash for this conversation' })
  );
  await clickAndSettle(
    screen.getByRole('button', { name: 'Deny: Bash: git status' })
  );
  expect(decisions).toEqual([
    ['req-1', { allow: true }],
    ['req-1', { allow: true, scope: 'session' }],
    ['req-1', { allow: false }],
  ]);
});

// The opening composer picks the model the conversation opens on (the
// `PromptBar`'s own model select); an open conversation names the model it
// started on and offers no picker.
test('the opening composer offers the model picker and an open conversation names its model', () => {
  const picks: string[] = [];
  const fresh = overseerSession({
    model: 'claude-opus-5-5',
    setModel: (id) => {
      picks.push(id);
    },
  });
  const first = render(<ChatWithDraft overseer={fresh} />);
  const picker = screen.getByRole('combobox', { name: 'Choose model' });
  expect(picker.textContent).toContain('Opus 5.5');
  expect(
    screen.getByRole('combobox', { name: 'Choose effort' }).textContent
  ).toContain('Default');
  first.unmount();

  render(
    <ChatWithDraft
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({ model: 'claude-fable-5-1' }),
      })}
    />
  );
  expect(screen.queryByRole('combobox', { name: 'Choose model' })).toBeNull();
  expect(screen.getByText(/Fable 5\.1/)).toBeDefined();
});

// Card headings are 12px/500 sentence case, never uppercase tracked labels, and the
// tool id beside them is book-weight sans.
test('the confirm card heading is 12px sentence case and its tool id is sans', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ pendingActions: [overseerAction()] }),
  });
  render(<OverseerChat overseer={overseer} />);
  const heading = screen.getByText('Needs your approval');
  expect(heading.className).toContain('text-[12px]');
  expect(heading.className).toContain('font-medium');
  expect(heading.className).not.toContain('uppercase');
  const toolId = screen.getByText('cancel_run');
  expect(toolId.className).toContain('font-book');
  expect(toolId.className).not.toContain('font-mono');
});
