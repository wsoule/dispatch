import type {
  OverseerAction,
  OverseerRecord,
  OverseerRecordView,
  RunMeta,
} from '@dispatch/client';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { useState } from 'react';

import type { OverseerSession } from '../../hooks/useOverseerSession';
import { askAgentToFix } from '../failure/FailureNotice';
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
    live: null,
    submit: () => Promise.resolve(),
    reply: () => Promise.resolve(),
    sending: false,
    sendError: null,
    revoked: false,
    confirmAction: () => Promise.resolve(true),
    decidingActionId: null,
    decideApproval: () => Promise.resolve(true),
    decidingRequestId: null,
    decideError: null,
    model: 'claude-opus-5',
    setModel: () => {},
    effortId: 'default',
    setEffortId: () => {},
    configuredEffort: undefined,
    reset: () => {},
    stop: () => Promise.resolve(),
    editQueued: () => Promise.resolve(true),
    removeQueued: () => Promise.resolve(true),
    setConversationOptions: () => Promise.resolve(),
    submitNew: () => Promise.resolve(),
    open: () => {},
    draft: '',
    setDraft: () => {},
    attachments: [],
    attachFiles: () => Promise.resolve(),
    upload: () => Promise.resolve([]),
    removeAttachment: () => {},
    attaching: false,
    fetchAttachment: () => Promise.resolve(new Blob()),
    ...over,
  };
}

// The composer's text lives on the session (it has to outlive the chat), so
// any test that types needs real state behind the fake session — the shape
// App gives the component in production.
function ChatWithDraft({ overseer }: { overseer: OverseerSession }) {
  const [draft, setDraft] = useState('');
  return <OverseerChat overseer={{ ...overseer, draft, setDraft }} />;
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

test('the start card takes an opening question through overseer.submit', async () => {
  const asked: string[] = [];
  const overseer = overseerSession({
    submit: (prompt: string) => {
      asked.push(prompt);
      return Promise.resolve();
    },
  });
  render(<ChatWithDraft overseer={overseer} />);

  expect(screen.getByText('What should we work on?')).toBeDefined();
  expect(
    screen.getByText(/changes the project waits for your approval/)
  ).toBeDefined();

  // A starter fills the composer rather than sending on its own.
  fireEvent.click(screen.getByRole('button', { name: 'What needs me?' }));
  expect(asked).toEqual([]);
  expect(
    screen
      .getByDisplayValue('What needs me right now?')
      .getAttribute('aria-label')
  ).toBe('Overseer opening question');

  fireEvent.change(screen.getByLabelText('Overseer opening question'), {
    target: { value: 'status?' },
  });
  await clickAndSettle(screen.getByRole('button', { name: 'Send' }));
  expect(asked).toEqual(['status?']);
});

test('the transcript renders its lines and the confirm card decides through the session', async () => {
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
      return Promise.resolve(true);
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

test('a follow-up goes through overseer.submit', async () => {
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
// from there rather than from state of its own: leaving the Overseer page
// unmounts this chat, which is exactly when a slow send tends to fail. A
// component-local error would be set on an unmounted tree and shown to nobody.
test('a send failure recorded on the session is reported by a freshly mounted chat', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord(),
    sendError: 'daemon unreachable',
  });
  // Mounting fresh is the point: this is the chat the user gets back after
  // leaving while the send was in flight and returning to Overseer.
  render(<ChatWithDraft overseer={overseer} />);

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
  render(<OverseerChat overseer={overseer} />);

  const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
  expect(send.disabled).toBe(true);
});

// A permanently failed record fetch (404 + retry: false) is a broken
// conversation, not a turn in flight — the error banner and the working
// status (with its Stop) must never show together.
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
  expect(screen.queryByText(/^Working ·/)).toBeNull();
  expect(screen.queryByTestId('overseer-stop')).toBeNull();
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
  expect(
    screen.getByText('Working · what you send now goes when it finishes')
  ).toBeDefined();
  expect(screen.getByTestId('overseer-stop')).toBeDefined();
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
            return new Promise<boolean>(() => {});
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
  const { rerender } = render(<OverseerChat overseer={overseer} />);

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
    />
  );
  expect(log.scrollTop).toBe(480);
});

// The pin follows only a reader already at the bottom: one who scrolled up to
// read (a tool run's details, an earlier reply) keeps their place while the
// turn keeps adding rows below them.
test('a reader scrolled up stays put when a new row arrives', () => {
  const messages = [
    { role: 'user' as const, text: 'status?', at: '2026-08-10T00:00:01Z' },
  ];
  const { rerender } = render(
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({ messages }),
      })}
    />
  );

  const log = screen.getByRole('log');
  Object.defineProperty(log, 'scrollHeight', {
    value: 900,
    configurable: true,
  });
  Object.defineProperty(log, 'clientHeight', {
    value: 300,
    configurable: true,
  });
  Object.defineProperty(log, 'scrollTop', {
    value: 100,
    writable: true,
    configurable: true,
  });
  fireEvent.scroll(log);

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
    />
  );
  expect(log.scrollTop).toBe(100);
});

// Sending is an explicit "show me the answer": it re-attaches a reader who had
// scrolled up, so their own message and the reply land in view.
test('sending a message re-pins a reader who had scrolled up', async () => {
  const messages = [
    { role: 'user' as const, text: 'status?', at: '2026-08-10T00:00:01Z' },
  ];
  const session = (msgs: typeof messages) =>
    overseerSession({
      conversationId: 'w-1',
      record: overseerRecord({ messages: msgs }),
    });
  const { rerender } = render(<ChatWithDraft overseer={session(messages)} />);

  const log = screen.getByRole('log');
  Object.defineProperty(log, 'scrollHeight', {
    value: 900,
    configurable: true,
  });
  Object.defineProperty(log, 'clientHeight', {
    value: 300,
    configurable: true,
  });
  Object.defineProperty(log, 'scrollTop', {
    value: 100,
    writable: true,
    configurable: true,
  });
  fireEvent.scroll(log);

  fireEvent.change(screen.getByLabelText('Follow-up message'), {
    target: { value: 'and the queue?' },
  });
  await clickAndSettle(screen.getByRole('button', { name: 'Send' }));
  rerender(
    <ChatWithDraft
      overseer={session([
        ...messages,
        { role: 'user', text: 'and the queue?', at: '2026-08-10T00:00:02Z' },
      ])}
    />
  );
  expect(log.scrollTop).toBe(900);
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
    />
  );

  // Still two rows — only the identity of the last one changed.
  expect(log.children).toHaveLength(2);
  expect(log.scrollTop).toBe(512);
});

// A running turn with the user's question asked and `live` written so far.
function writingSession(
  segments: { id: string; text: string }[] | null,
  over: Partial<OverseerRecord> = {}
): OverseerSession {
  return overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({
      state: 'running',
      messages: [{ role: 'user', text: 'status?', at: '2026-08-10T00:00:01Z' }],
      ...over,
    }),
    live: segments === null ? null : { turnId: 't1', segments },
  });
}

// The words the turn is writing say it is working; the spinner row is only
// for the wait before the first of them.
test('live text takes the working row’s place while the turn writes', () => {
  const { rerender } = render(<OverseerChat overseer={writingSession(null)} />);
  expect(screen.getByText('The overseer is working…')).toBeDefined();

  rerender(
    <OverseerChat
      overseer={writingSession([
        { id: 's1', text: 'Two runs are **blocked**' },
      ])}
    />
  );
  expect(screen.queryByText('The overseer is working…')).toBeNull();
  const live = screen.getByTestId('overseer-live');
  // Markdown while it streams, not raw asterisks that turn bold at the end.
  expect(live.querySelector('strong')?.textContent).toBe('blocked');
});

// Once the record holds the text as rows, the session's `live` no longer has
// it: the narration and the reply each show exactly once.
test('a settled turn shows its narration and its reply once each', () => {
  const { rerender } = render(
    <OverseerChat
      overseer={writingSession([
        { id: 's1', text: 'Checking the queue.' },
        { id: 's2', text: 'Both wait on review.' },
      ])}
    />
  );
  expect(screen.getAllByTestId('overseer-live')).toHaveLength(2);

  rerender(
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
          messages: [
            { role: 'user', text: 'status?', at: '2026-08-10T00:00:01Z' },
            {
              role: 'narration',
              text: 'Checking the queue.',
              at: '2026-08-10T00:00:02Z',
              streamId: 's1',
            },
            {
              role: 'assistant',
              text: 'Both wait on review.',
              at: '2026-08-10T00:00:03Z',
              streamId: 's2',
            },
          ],
        }),
      })}
    />
  );
  expect(screen.queryByTestId('overseer-live')).toBeNull();
  expect(screen.getAllByText('Checking the queue.')).toHaveLength(1);
  expect(screen.getAllByText('Both wait on review.')).toHaveLength(1);
});

// Narration is the agent's own voice, so it sits in the reply's column as
// Markdown, but in its own quieter row: the answer stays what the eye lands on.
// The hooks are the rows' data-speaker (narration beside the reply's
// assistant), the Markdown inside each, and the module's quieter ink, which
// only the narration class takes.
test('narration reads as the agent’s quieter voice beside its reply', () => {
  render(
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
          messages: [
            {
              role: 'narration',
              text: 'Checking the queue.',
              at: '2026-08-10T00:00:02Z',
            },
            {
              role: 'assistant',
              text: 'Both wait on review.',
              at: '2026-08-10T00:00:03Z',
            },
          ],
        }),
      })}
    />
  );
  const narration = screen.getByTestId('overseer-narration');
  const narrationMd = narration.querySelector('[data-slot="markdown"]');
  expect(narrationMd?.textContent).toBe('Checking the queue.');
  const reply = screen.getByText('Both wait on review.');
  expect(narration.contains(reply)).toBe(false);
  const replyMd = reply.closest('[data-slot="markdown"]');
  expect(replyMd).not.toBeNull();
  expect(replyMd).not.toBe(narrationMd);
  expect(narration.getAttribute('data-speaker')).toBe('narration');
  expect(reply.closest('[data-speaker]')?.getAttribute('data-speaker')).toBe(
    'assistant'
  );
  // CSS-module classes render as '' under bun test, so the quieter voice is
  // read from the module: narration takes the secondary ink, the reply none.
  const css = readFileSync(
    new URL('./OverseerChat.module.css', import.meta.url),
    'utf8'
  );
  expect(css).toMatch(/\.narration\s*\{[^}]*color:\s*var\(--text-2\)/);
  expect(css).not.toMatch(/\.reply\s*\{[^}]*color:/);
});

// Live text grows inside one row, which moves neither the row count nor the
// last key the pin effect follows; the log follows its own DOM for that.
// scrollHeight is a getter so the test can grow the content by hand.
test('live text growing in place keeps a reader at the bottom following', async () => {
  const { rerender } = render(
    <OverseerChat overseer={writingSession([{ id: 's1', text: 'Checking' }])} />
  );
  const log = screen.getByRole('log');
  let height = 480;
  Object.defineProperty(log, 'scrollHeight', {
    get: () => height,
    configurable: true,
  });
  Object.defineProperty(log, 'clientHeight', {
    value: 480,
    configurable: true,
  });
  Object.defineProperty(log, 'scrollTop', {
    value: 0,
    writable: true,
    configurable: true,
  });
  fireEvent.scroll(log);

  height = 900;
  rerender(
    <OverseerChat
      overseer={writingSession([
        {
          id: 's1',
          text: 'Checking the merge queue: two runs wait on review.',
        },
      ])}
    />
  );
  await waitFor(() => {
    expect(log.scrollTop).toBe(900);
  });
});

test('a reader scrolled up stays put while live text grows', async () => {
  const { rerender } = render(
    <OverseerChat overseer={writingSession([{ id: 's1', text: 'Checking' }])} />
  );
  const log = screen.getByRole('log');
  Object.defineProperty(log, 'scrollHeight', {
    value: 900,
    configurable: true,
  });
  Object.defineProperty(log, 'clientHeight', {
    value: 300,
    configurable: true,
  });
  Object.defineProperty(log, 'scrollTop', {
    value: 100,
    writable: true,
    configurable: true,
  });
  fireEvent.scroll(log);

  rerender(
    <OverseerChat
      overseer={writingSession([
        { id: 's1', text: 'Checking the merge queue: two runs wait.' },
      ])}
    />
  );
  await waitFor(() => {
    expect(screen.getByText(/two runs wait/)).toBeDefined();
  });
  expect(log.scrollTop).toBe(100);
});

// A running turn parked on `git status`, recording every decision it gets.
function parkedSession(decisions: unknown[], held = false): OverseerSession {
  return overseerSession({
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
          ...(held ? { held: true } : {}),
        },
      ],
    }),
    decideApproval: (requestId, decision) => {
      decisions.push([requestId, decision]);
      return Promise.resolve(true);
    },
  });
}

// A parked built-in call is the one row where the session is blocked right
// now: the card is the one a run's parked call gets, with its three answers,
// and each reaches the session's decideApproval with the matching decision.
test('a parked tool call renders the shared approval card wired to decideApproval', async () => {
  const decisions: unknown[] = [];
  render(<ChatWithDraft overseer={parkedSession(decisions)} />);

  expect(
    screen.getByRole('radiogroup', {
      name: /^Wants to run\s+Bash: git status$/,
    })
  ).toBeDefined();
  expect(
    screen.getByText('Bash: git status', { selector: 'pre' })
  ).toBeDefined();
  // Blocked on the human, so no "working" spinner row under the card.
  expect(screen.queryByText('The overseer is working…')).toBeNull();

  await clickAndSettle(screen.getByRole('radio', { name: /^Approve once/ }));
  await clickAndSettle(
    screen.getByRole('radio', { name: /^Allow Bash for this conversation/ })
  );
  expect(decisions).toEqual([
    ['req-1', { allow: true, scope: 'once' }],
    ['req-1', { allow: true, scope: 'session' }],
  ]);
});

// Deny asks why first; the reason is optional and reaches the model as its
// refusal, so a bare "no" does not leave it guessing.
test('denying a parked call collects an optional reason', async () => {
  const decisions: unknown[] = [];
  render(<ChatWithDraft overseer={parkedSession(decisions)} />);

  fireEvent.click(screen.getByRole('radio', { name: /^Deny and tell it why/ }));
  // Nothing is decided until the reason box is sent.
  expect(decisions).toEqual([]);
  const reason = screen.getByLabelText('Reason for denying');
  expect(document.activeElement).toBe(reason);
  // The other answers wait while the reason is written.
  expect(
    screen
      .getByRole('radio', { name: /^Approve once/ })
      .hasAttribute('disabled')
  ).toBe(true);
  fireEvent.change(reason, {
    target: { value: '  Use git diff --stat, not status.  ' },
  });
  await clickAndSettle(
    screen.getByRole('button', { name: 'Deny and tell it why' })
  );

  fireEvent.click(screen.getByRole('radio', { name: /^Deny and tell it why/ }));
  await clickAndSettle(screen.getByRole('button', { name: 'Deny' }));
  expect(decisions).toEqual([
    ['req-1', { allow: false, reason: 'Use git diff --stat, not status.' }],
    ['req-1', { allow: false }],
  ]);
});

// The session reports a failed decision on decideError and resolves false;
// the card must not take that as done and throw away the typed reason.
test('a deny that did not go through keeps the reason box and the reason', async () => {
  const decisions: unknown[] = [];
  render(
    <ChatWithDraft
      overseer={{
        ...parkedSession(decisions),
        decideApproval: (requestId, decision) => {
          decisions.push([requestId, decision]);
          return Promise.resolve(false);
        },
      }}
    />
  );
  fireEvent.click(screen.getByRole('radio', { name: /^Deny and tell it why/ }));
  fireEvent.change(screen.getByLabelText('Reason for denying'), {
    target: { value: 'use make clean' },
  });
  await clickAndSettle(
    screen.getByRole('button', { name: 'Deny and tell it why' })
  );
  expect(decisions).toEqual([
    ['req-1', { allow: false, reason: 'use make clean' }],
  ]);
  expect(screen.getByLabelText('Reason for denying')).toHaveProperty(
    'value',
    'use make clean'
  );
});

// Two parked calls give two cards with the same answers: each card's group
// is named after its own call, so a screen reader can tell them apart.
test('each parked call names its own approval card', () => {
  const session = parkedSession([]);
  const record = session.record;
  if (record === null) throw new Error('no record');
  const second = {
    requestId: 'req-2',
    toolName: 'Bash',
    input: { command: 'rm -rf dist' },
    summary: 'Bash: rm -rf dist',
    requestedAt: '2026-08-10T00:00:02Z',
  };
  render(
    <ChatWithDraft
      overseer={{
        ...session,
        record: {
          ...record,
          messages: [
            ...record.messages,
            {
              role: 'approval',
              tool: 'Bash',
              requestId: 'req-2',
              outcome: 'pending',
              text: 'Bash: rm -rf dist',
              at: '2026-08-10T00:00:02Z',
            },
          ],
          pendingApprovals: [...record.pendingApprovals, second],
        },
      }}
    />
  );
  expect(
    screen.getByRole('radiogroup', {
      name: /^Wants to run\s+Bash: git status$/,
    })
  ).toBeDefined();
  expect(
    screen.getByRole('radiogroup', {
      name: /^Wants to run\s+Bash: rm -rf dist$/,
    })
  ).toBeDefined();
});

// A held call (the floor, or Dispatch's own surfaces) is allowed once only.
test('a held call offers no grant for the conversation', () => {
  render(<ChatWithDraft overseer={parkedSession([], true)} />);
  expect(screen.getByRole('radio', { name: /^Approve once/ })).toBeDefined();
  expect(
    screen.queryByRole('radio', { name: /for this conversation/ })
  ).toBeNull();
});

// One decision at a time across every approval card: the session holds a
// single lock, so a card must not take a click while another decides.
test('approval cards lock while any approval is being decided', () => {
  const decisions: unknown[] = [];
  render(
    <ChatWithDraft
      overseer={{ ...parkedSession(decisions), decidingRequestId: 'req-0' }}
    />
  );
  const once = screen.getByRole('radio', { name: /^Approve once/ });
  expect(once.hasAttribute('disabled')).toBe(true);
  fireEvent.click(once);
  expect(decisions).toEqual([]);
});

// The opening composer picks the model the conversation opens on (the
// `PromptBar`'s own model select); an open conversation's picker shows its own model.
test('the opening composer offers the model picker and an open conversation names its model', () => {
  const picks: string[] = [];
  const fresh = overseerSession({
    model: 'claude-opus-5-5',
    setModel: (id) => {
      picks.push(id);
    },
  });
  const first = render(<ChatWithDraft overseer={fresh} />);
  // A native select's textContent holds every option, so the shown choice is
  // read from its value and its selected option.
  const picker = screen.getByRole<HTMLSelectElement>('combobox', {
    name: 'Choose model',
  });
  expect(picker.value).toBe('claude-opus-5-5');
  expect(picker.selectedOptions[0]?.textContent).toContain('Opus 5.5');
  const effort = screen.getByRole<HTMLSelectElement>('combobox', {
    name: 'Choose effort',
  });
  expect(effort.value).toBe('default');
  expect(effort.selectedOptions[0]?.textContent).toContain('Default');
  first.unmount();

  render(
    <ChatWithDraft
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({ model: 'claude-fable-5-1' }),
      })}
    />
  );
  // An open conversation's picker shows its own model; a change applies from its next turn.
  const open = screen.getByRole<HTMLSelectElement>('combobox', {
    name: 'Choose model',
  });
  expect(open.value).toBe('claude-fable-5-1');
  expect(open.selectedOptions[0]?.textContent).toContain('Fable 5.1');
});

// The confirm card is a warning-toned DecisionCard: its heading is the card's
// question in sentence case (never uppercase tracked capitals), and the tool id
// beside it is shown in the mono face, being a machine-read name (Q5).
test('the confirm card heading is sentence case and its tool id is shown', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ pendingActions: [overseerAction()] }),
  });
  render(<OverseerChat overseer={overseer} />);
  const heading = screen.getByText('Needs your approval');
  expect(heading.closest('[data-tone="warning"]')).not.toBeNull();
  // Sentence case lives in the words themselves: neither the card's module
  // nor this chat's turns them to capitals.
  for (const file of [
    '../gates/DecisionCard.module.css',
    './OverseerChat.module.css',
  ]) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
  }
  const toolId = screen.getByText('cancel_run');
  expect(toolId.classList.contains('mono')).toBe(true);
  expect(heading.closest('[data-slot="overseer-confirm"]')).toBe(
    toolId.closest('[data-slot="overseer-confirm"]')
  );
});

// The approve and deny pair are plain buttons in the card's actions, named
// after the action ("Approve: …", "Deny: …", which e2e clicks), not radio
// answers.
test('Approve and Deny are buttons inside the confirm card', async () => {
  const decisions: unknown[] = [];
  render(
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({ pendingActions: [overseerAction()] }),
        confirmAction: (actionId: string, approve: boolean) => {
          decisions.push([actionId, approve]);
          return Promise.resolve(true);
        },
      })}
    />
  );
  const approve = screen.getByRole('button', {
    name: 'Approve: Cancel run r-1',
  });
  const deny = screen.getByRole('button', { name: 'Deny: Cancel run r-1' });
  const card = approve.closest<HTMLElement>('[data-slot="overseer-confirm"]');
  expect(card).not.toBeNull();
  expect(card?.contains(deny)).toBe(true);
  expect(card?.textContent).toContain('Needs your approval');
  expect(card?.textContent).toContain('Cancel run r-1');
  expect(card?.querySelector('[role="radio"]')).toBeNull();
  await clickAndSettle(approve);
  expect(decisions).toEqual([['act-1', true]]);
});

test('a conversation takes a message mid-turn and offers Stop', () => {
  let submitted = '';
  let stopped = false;
  render(
    <ChatWithDraft
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({ state: 'running', spendUsd: 0.5 }),
        submit: (text) => {
          submitted = text;
          return Promise.resolve();
        },
        stop: () => {
          stopped = true;
          return Promise.resolve();
        },
      })}
    />
  );
  const box = screen.getByRole('textbox', { name: 'Follow-up message' });
  expect(box.hasAttribute('disabled')).toBe(false);
  fireEvent.change(box, { target: { value: 'also this' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(submitted).toBe('also this');
  fireEvent.click(screen.getByTestId('overseer-stop'));
  expect(stopped).toBe(true);
  expect(screen.getByTestId('overseer-spend').textContent).toContain('$0.50');
});

test('an open conversation shows its own model and effort in the pickers', () => {
  render(
    <ChatWithDraft
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({ model: 'claude-opus-5-5', effort: 'high' }),
      })}
    />
  );
  const model = screen.getByRole<HTMLSelectElement>('combobox', {
    name: 'Choose model',
  });
  expect(model.value).toBe('claude-opus-5-5');
  expect(model.selectedOptions[0]?.textContent).toContain('Opus 5.5');
  const effort = screen.getByRole<HTMLSelectElement>('combobox', {
    name: 'Choose effort',
  });
  expect(effort.value).toBe('high');
  expect(effort.selectedOptions[0]?.textContent).toContain('High');
});

test('typing a slash suggests the session’s commands and a pick fills the draft', () => {
  render(
    <ChatWithDraft
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
          commands: [
            {
              name: 'compact',
              description: 'Compact the context',
              argumentHint: '',
            },
            {
              name: 'review',
              description: 'Review a PR',
              argumentHint: '<pr>',
            },
          ],
        }),
      })}
    />
  );
  const box = screen.getByRole('textbox', { name: 'Follow-up message' });
  fireEvent.change(box, { target: { value: '/co' } });
  // The '/' list is an inline listbox of options; the caret stays in the box.
  expect(screen.queryByRole('option', { name: /^review/ })).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: /^compact/ }));
  expect((box as HTMLTextAreaElement).value).toBe('/compact ');
  expect(screen.queryByRole('option', { name: /^compact/ })).toBeNull();
});

test('actions queued together share one card, and Approve both decides each in turn', async () => {
  const decided: [string, boolean][] = [];
  const a = overseerAction({
    id: 'act-a',
    tool: 'dispatch_task',
    summary: 'Dispatch t-1',
  });
  const b = overseerAction({
    id: 'act-b',
    tool: 'dispatch_task',
    summary: 'Dispatch t-2',
  });
  render(
    <ChatWithDraft
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
          pendingActions: [a, b],
          messages: [
            {
              role: 'action',
              actionId: 'act-a',
              outcome: 'pending',
              text: 'q',
              at: 't1',
            },
            {
              role: 'action',
              actionId: 'act-b',
              outcome: 'pending',
              text: 'q',
              at: 't2',
            },
          ],
        }),
        confirmAction: (id, approve) => {
          decided.push([id, approve]);
          return Promise.resolve(true);
        },
      })}
    />
  );
  const card = screen.getByTestId('overseer-confirm-batch');
  expect(card.textContent).toContain('dispatch_task ×2');
  await clickAndSettle(screen.getByRole('button', { name: 'Approve both' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(decided).toEqual([
    ['act-a', true],
    ['act-b', true],
  ]);
});

test('Approve both stops at the first action that fails', async () => {
  const decided: string[] = [];
  const actions = ['act-a', 'act-b'].map((id, i) =>
    overseerAction({ id, tool: 'discard_run', summary: `Discard r-${i}` })
  );
  render(
    <ChatWithDraft
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
          pendingActions: actions,
          messages: actions.map((a) => ({
            role: 'action' as const,
            actionId: a.id,
            outcome: 'pending' as const,
            text: a.summary,
            at: 't1',
          })),
        }),
        confirmAction: (id) => {
          decided.push(id);
          return Promise.resolve(false);
        },
      })}
    />
  );
  await clickAndSettle(screen.getByRole('button', { name: 'Approve both' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(decided).toEqual(['act-a']);
});

// A running turn with two lines queued behind it, for the edit/remove tests.
function queuedSession(over: Partial<OverseerSession> = {}): OverseerSession {
  return overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({
      state: 'running',
      queued: [
        { id: 'q-1', text: 'teh typo', at: '2026-08-10T00:00:03Z' },
        { id: 'q-2', text: 'second line', at: '2026-08-10T00:00:04Z' },
      ],
    }),
    ...over,
  });
}

test('a queued line edits in place: Save sends the new text for that entry', async () => {
  const edits: [string, string][] = [];
  render(
    <ChatWithDraft
      overseer={queuedSession({
        editQueued: (id, text) => {
          edits.push([id, text]);
          return Promise.resolve(true);
        },
      })}
    />
  );
  const [first] = screen.getAllByRole('button', {
    name: 'Edit queued message',
  });
  fireEvent.click(first);
  const box = screen.getByRole('textbox', { name: 'Queued message' });
  expect((box as HTMLTextAreaElement).value).toBe('teh typo');
  fireEvent.change(box, { target: { value: 'the fix' } });
  await clickAndSettle(screen.getByRole('button', { name: 'Save' }));
  expect(edits).toEqual([['q-1', 'the fix']]);
  // Saved: the editor closes back to the queued line.
  expect(screen.queryByRole('textbox', { name: 'Queued message' })).toBeNull();
});

test('Enter commits a queued edit and Esc cancels one without a call', async () => {
  const edits: [string, string][] = [];
  render(
    <ChatWithDraft
      overseer={queuedSession({
        editQueued: (id, text) => {
          edits.push([id, text]);
          return Promise.resolve(true);
        },
      })}
    />
  );
  const second = screen.getAllByRole('button', {
    name: 'Edit queued message',
  })[1];
  fireEvent.click(second);
  const box = screen.getByRole('textbox', { name: 'Queued message' });
  fireEvent.change(box, { target: { value: 'never mind' } });
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(screen.queryByRole('textbox', { name: 'Queued message' })).toBeNull();
  expect(screen.getByText('second line')).toBeDefined();
  expect(edits).toEqual([]);

  fireEvent.click(second);
  const again = screen.getByRole('textbox', { name: 'Queued message' });
  fireEvent.change(again, { target: { value: 'second, fixed' } });
  fireEvent.keyDown(again, { key: 'Enter' });
  await act(async () => {
    await Promise.resolve();
  });
  expect(edits).toEqual([['q-2', 'second, fixed']]);
});

test('a refused queued edit keeps the editor open', async () => {
  render(
    <ChatWithDraft
      overseer={queuedSession({ editQueued: () => Promise.resolve(false) })}
    />
  );
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Edit queued message' })[0]
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Queued message' }), {
    target: { value: 'the fix' },
  });
  await clickAndSettle(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('textbox', { name: 'Queued message' })).toBeDefined();
});

test('Remove drops that queued entry through the session', async () => {
  const removed: string[] = [];
  render(
    <ChatWithDraft
      overseer={queuedSession({
        removeQueued: (id) => {
          removed.push(id);
          return Promise.resolve(true);
        },
      })}
    />
  );
  await clickAndSettle(
    screen.getAllByRole('button', { name: 'Remove queued message' })[1]
  );
  expect(removed).toEqual(['q-2']);
});

test('an edit the turn beat says so on the error line', () => {
  render(
    <ChatWithDraft
      overseer={queuedSession({
        sendError:
          'already sent: the turn ended and this message went out with it',
      })}
    />
  );
  expect(screen.getByText(/already sent/)).toBeDefined();
});

test('a failed Overseer turn explains a sign-in problem', () => {
  render(
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
          state: 'failed',
          backendName: 'claude',
          error: 'Invalid API key · Please run /login',
        }),
      })}
    />
  );
  expect(
    screen.getByText('Claude Code needs you to sign in again.')
  ).toBeTruthy();
});

test('a failed Overseer turn can be retried or handed back to the agent', async () => {
  const replies: string[] = [];
  render(
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        reply: (text) => {
          replies.push(text);
          return Promise.resolve();
        },
        record: overseerRecord({
          state: 'failed',
          error: 'TypeError: boom',
          messages: [
            {
              role: 'user',
              text: 'what needs me?',
              at: '2026-08-10T00:00:01Z',
            },
          ],
        }),
      })}
    />
  );
  await clickAndSettle(screen.getByRole('button', { name: 'Try again' }));
  await clickAndSettle(
    screen.getByRole('button', { name: 'Ask the agent to fix it' })
  );
  expect(replies).toEqual(['what needs me?', askAgentToFix('TypeError: boom')]);
});

test('a pasted screenshot alone can be sent, and the sent line shows it', async () => {
  const sent: string[] = [];
  const shot = {
    name: 'image.png',
    path: '.dispatch/attachments/overseer/0123456789ab/image.png',
    size: 3,
    mimeType: 'image/png',
  };
  const fetched: string[] = [];
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({
      messages: [
        {
          role: 'user',
          text: '',
          at: '2026-01-01T00:00:00.000Z',
          attachments: [
            { ...shot, path: shot.path.replace('image', 'earlier') },
            {
              name: 'build.log',
              path: '.dispatch/attachments/overseer/ba9876543210/build.log',
              size: 4,
              mimeType: 'text/plain',
            },
          ],
        },
      ],
    }),
    attachments: [shot],
    submit: (text: string) => {
      sent.push(text);
      return Promise.resolve();
    },
    fetchAttachment: (attachment) => {
      fetched.push(attachment.path);
      return Promise.resolve(new Blob(['png'], { type: 'image/png' }));
    },
  });
  render(<ChatWithDraft overseer={overseer} />);

  // The transcript's file chip and the pending shot's remove button.
  expect(screen.getByText('build.log')).not.toBeNull();
  expect(
    screen.getByRole('button', { name: 'Remove image.png' })
  ).not.toBeNull();
  await clickAndSettle(screen.getByRole('button', { name: 'Send' }));
  expect(sent).toEqual(['']);
  // Only images are fetched for previews, each once.
  expect(fetched.sort()).toEqual(
    [shot.path, shot.path.replace('image', 'earlier')].sort()
  );
});

// A tool chip's state as ToolChip draws it, read off its stable hooks: the
// chip's data-state, and a running one shimmers its label (data-shimmer).
function chipState(label: string): string | undefined {
  const chip = screen
    .getByText(label)
    .closest<HTMLElement>('[data-slot="tool-chip"]');
  if (chip === null) throw new Error(`no chip shows ${label}`);
  const shimmers = chip.querySelector('[data-shimmer]') !== null;
  expect(shimmers).toBe(chip.dataset.state === 'running');
  return chip.dataset.state;
}

test('tool chips say how each call went, and a call left running ends with its turn', () => {
  const at = '2026-08-10T00:00:01Z';
  const messages = [
    { role: 'user' as const, text: 'look around', at },
    {
      role: 'tool' as const,
      tool: 'Bash',
      text: 'Bash: ls',
      toolUseId: 'toolu_1',
      status: 'running' as const,
      at,
    },
    {
      role: 'tool' as const,
      tool: 'Edit',
      text: 'Edit: a.ts',
      status: 'error' as const,
      at,
    },
    {
      role: 'tool' as const,
      tool: 'list_runs',
      text: '{"runs":[]}',
      status: 'done' as const,
      at,
    },
  ];
  const chat = (state: OverseerRecord['state']) => (
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({ state, messages }),
      })}
    />
  );
  const { rerender } = render(chat('running'));
  expect(chipState('Bash')).toBe('running');
  expect(chipState('Edit')).toBe('failed');
  expect(chipState('list_runs')).toBe('done');

  // Stopped before the result came: no spinner, and no failure either.
  rerender(chat('ready'));
  expect(chipState('Bash')).toBe('done');
  expect(chipState('Edit')).toBe('failed');
});

// How close the next turn is to starting over from a recap: the record's
// context against the threshold the daemon names beside it.
test('the status line says how full the context is', () => {
  const chat = (over: Partial<OverseerRecordView>) => (
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: { ...overseerRecord({ spendUsd: 0.5 }), ...over },
      })}
    />
  );
  const { rerender } = render(
    chat({ contextTokens: 93_000, contextLimit: 150_000 })
  );
  expect(screen.getByTestId('overseer-context').textContent).toBe(
    '62% context'
  );
  expect(screen.getByTestId('overseer-spend').textContent).toContain('$0.50');

  // Past the threshold it reads full, never more.
  rerender(chat({ contextTokens: 180_000, contextLimit: 150_000 }));
  expect(screen.getByTestId('overseer-context').textContent).toBe(
    '100% context'
  );

  // A daemon that does not name its threshold, or a turn yet to report.
  rerender(chat({ contextTokens: 93_000 }));
  expect(screen.queryByTestId('overseer-context')).toBeNull();
  rerender(chat({ contextLimit: 150_000 }));
  expect(screen.queryByTestId('overseer-context')).toBeNull();
});

// ⌘F opens the find bar only while the chat has a layout box; happy-dom has no
// layout, so the test gives the chat's root an offsetParent by hand.
function openFind(): HTMLInputElement {
  const root = screen.getByRole('log').parentElement;
  if (root === null) throw new Error('no chat root');
  Object.defineProperty(root, 'offsetParent', {
    value: document.body,
    configurable: true,
  });
  act(() => {
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
  });
  return screen.getByRole<HTMLInputElement>('searchbox', {
    name: 'Find in this conversation',
  });
}

function findSession(): OverseerSession {
  return overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({
      messages: [
        { role: 'user', text: 'status?', at: '2026-08-10T00:00:01Z' },
        {
          role: 'assistant',
          text: 'Two runs wait on review.',
          at: '2026-08-10T00:00:02Z',
        },
      ],
    }),
  });
}

test('⌘F stays with the page while the chat has no layout box', () => {
  render(<OverseerChat overseer={findSession()} />);
  const root = screen.getByRole('log').parentElement;
  if (root === null) throw new Error('no chat root');
  Object.defineProperty(root, 'offsetParent', {
    value: null,
    configurable: true,
  });
  fireEvent.keyDown(window, { key: 'f', metaKey: true });
  expect(screen.queryByRole('searchbox')).toBeNull();
});

// Escape closes the find bar at once, with text in it or not (the legacy
// behaviour: SearchField's own clear-first Escape is caught before it), and
// goes no further, so a focus or the app's keyboard never takes it too.
test('the find bar filters, and one Escape closes it and shows everything', () => {
  render(<OverseerChat overseer={findSession()} />);
  const field = openFind();
  fireEvent.change(field, { target: { value: 'review' } });
  expect(screen.getByText('1 match')).toBeDefined();
  expect(screen.queryByText('status?')).toBeNull();

  let reachedPage = 0;
  const onPage = () => {
    reachedPage += 1;
  };
  window.addEventListener('keydown', onPage);
  try {
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByText('status?')).toBeDefined();
    expect(reachedPage).toBe(0);
  } finally {
    window.removeEventListener('keydown', onPage);
  }
});

test('Close find shuts the bar and shows the whole conversation', () => {
  render(<OverseerChat overseer={findSession()} />);
  const field = openFind();
  fireEvent.change(field, { target: { value: 'review' } });
  const done = screen.getByRole('button', { name: 'Close find' });
  expect(done.textContent).toBe('Done');
  fireEvent.click(done);
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.getByText('status?')).toBeDefined();
});

// A tool run's raw results wait behind a Disclosure: its trigger says what it
// does and carries aria-expanded, and the details hold every call's text.
test('a tool run opens its details through the Disclosure', () => {
  const at = '2026-08-10T00:00:01Z';
  render(
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
          messages: [
            { role: 'user', text: 'look around', at },
            {
              role: 'tool',
              tool: 'list_runs',
              text: '{"runs":[]}',
              status: 'done',
              at,
            },
          ],
        }),
      })}
    />
  );
  const tools = screen.getByTestId('overseer-tools');
  const toggle = screen.getByRole('button', { name: 'Details' });
  expect(tools.contains(toggle)).toBe(true);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('{"runs":[]}')).toBeNull();

  fireEvent.click(toggle);
  const open = screen.getByRole('button', { name: 'Hide details' });
  expect(open.getAttribute('aria-expanded')).toBe('true');
  const panelId = open.getAttribute('aria-controls');
  expect(panelId).not.toBeNull();
  const panel = document.getElementById(panelId ?? '');
  expect(panel?.textContent).toContain('list_runs');
  expect(panel?.textContent).toContain('{"runs":[]}');

  fireEvent.click(open);
  expect(
    screen
      .getByRole('button', { name: 'Details' })
      .getAttribute('aria-expanded')
  ).toBe('false');
});

// Starters and doors are chip buttons; a door opens through onOpenDoor.
test('the starters are chip buttons', () => {
  render(<ChatWithDraft overseer={overseerSession()} />);
  const group = screen.getByRole('group', { name: 'Starter questions' });
  const starters = group.querySelectorAll('button[data-chip-button]');
  expect(starters).toHaveLength(4);
});

// Each decided action keeps an audit line in its outcome's tone, with the
// words that say it, so the colour is never the only cue.
test('outcome lines are toned by what happened', () => {
  render(
    <OverseerChat
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
          messages: [
            {
              role: 'action',
              actionId: 'act-1',
              outcome: 'applied',
              text: 'Applied: Dispatch t-1',
              at: '2026-08-10T00:00:02Z',
            },
            {
              role: 'action',
              actionId: 'act-2',
              outcome: 'denied',
              text: 'Denied: Dispatch t-2',
              at: '2026-08-10T00:00:03Z',
            },
          ],
        }),
      })}
    />
  );
  const applied = screen.getByText(/^Applied: Dispatch /);
  const denied = screen.getByText(/^Denied: Dispatch /);
  expect(applied.closest('[data-tone]')?.getAttribute('data-tone')).toBe(
    'success'
  );
  expect(denied.closest('[data-tone]')?.getAttribute('data-tone')).toBe(
    'muted'
  );
});

// A plan, a new task or a dispatch lists its tasks as one card: proposed on the
// confirm card, then what it made, each row with its run and opening its task.
test('task actions list their tasks as a card, proposed then started', async () => {
  const opened: string[] = [];
  const work = {
    tasks: [
      { meta: { id: 't-a', title: 'Schema' } },
      { meta: { id: 't-b', title: 'UI' } },
    ],
    runs: [
      {
        id: 'r-a',
        taskId: 't-a',
        taskTitle: 'Schema',
        state: 'running',
        createdAt: '2026-08-10T00:00:06Z',
        lastStep: { text: 'Editing src/db.ts', at: '2026-08-10T00:00:07Z' },
      } as RunMeta,
    ],
    onOpenTask: (taskId: string) => opened.push(taskId),
  };
  const plan = overseerAction({
    id: 'act-2',
    tool: 'create_plan',
    input: { tasks: [{ title: 'Docs' }, { title: 'Tests' }] },
    summary: 'Create 2 tasks: "Docs", "Tests"',
  });
  render(
    <OverseerChat
      work={work}
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
          messages: [
            {
              role: 'action',
              tool: 'create_plan',
              actionId: 'act-1',
              outcome: 'applied',
              text: 'Applied: Create 2 tasks',
              at: '2026-08-10T00:00:05Z',
              taskIds: ['t-a', 't-b'],
            },
            {
              role: 'action',
              tool: 'create_plan',
              actionId: 'act-2',
              outcome: 'pending',
              text: 'Queued: Create 2 tasks',
              at: '2026-08-10T00:00:08Z',
            },
          ],
          pendingActions: [plan],
        }),
      })}
    />
  );
  const [made, proposed] = screen.getAllByTestId('overseer-task-card');
  expect(made.textContent).toContain('2 suggested tasks');
  expect(made.textContent).toContain('1 started');
  expect(made.textContent).toContain('Editing src/db.ts');
  // The proposal lists its titles in place of the summary sentence; nothing opens yet.
  expect(proposed.closest('[data-slot="overseer-confirm"]')).not.toBeNull();
  expect(proposed.textContent).toContain('0 started');
  expect(proposed.textContent).toContain('Docs');
  expect(screen.queryByText('Create 2 tasks: "Docs", "Tests"')).toBeNull();
  await clickAndSettle(screen.getByRole('button', { name: /^UI/ }));
  expect(opened).toEqual(['t-b']);
});

// Several actions in one turn: a task action's row lists its tasks, the rest keep their sentence.
test('a batch lists a task action as a card beside a plain one', () => {
  const plan = overseerAction({
    id: 'act-1',
    tool: 'create_task',
    input: { title: 'Spec the 403' },
    summary: 'Create task "Spec the 403"',
  });
  const cancel = overseerAction({ id: 'act-2' });
  render(
    <OverseerChat
      work={{ tasks: [], runs: [] }}
      overseer={overseerSession({
        conversationId: 'w-1',
        record: overseerRecord({
          messages: [
            {
              role: 'action',
              tool: 'create_task',
              actionId: 'act-1',
              outcome: 'pending',
              text: 'Queued',
              at: '2026-08-10T00:00:02Z',
            },
            {
              role: 'action',
              tool: 'cancel_run',
              actionId: 'act-2',
              outcome: 'pending',
              text: 'Queued',
              at: '2026-08-10T00:00:03Z',
            },
          ],
          pendingActions: [plan, cancel],
        }),
      })}
    />
  );
  const batch = screen.getByTestId('overseer-confirm-batch');
  const card = batch.querySelector('[data-testid="overseer-task-card"]');
  expect(card?.textContent).toContain('1 suggested task');
  expect(card?.textContent).toContain('Spec the 403');
  expect(batch.textContent).toContain('Cancel run r-1');
  expect(screen.queryByText('Create task "Spec the 403"')).toBeNull();
  // Each row keeps its own answers.
  expect(
    screen.getByRole('button', { name: 'Approve: Create task "Spec the 403"' })
  ).toBeDefined();
});
