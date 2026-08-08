import type { ApiClient, ChatMessage, Snippet } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'bun:test';
import { createRef, type ReactNode, type RefObject } from 'react';

import type { ReviewChatHandle } from './ReviewChatPanel';
import { ReviewChatPanel } from './ReviewChatPanel';

const SNIPPET: Snippet = {
  file: 'src/a.ts',
  startLine: 2,
  endLine: 4,
  text: 'const a = 1;',
};

function message(body: string): ChatMessage {
  return {
    id: 'cm-1',
    role: 'human',
    body,
    snippets: [],
    created: '2026-08-06T00:00:00.000Z',
  };
}

interface Calls {
  fetched: string[];
  added: Parameters<ApiClient['addChatMessage']>[0][];
}

// Only the two conversation calls this panel makes; anything else is left off so a panel that
// started fetching something new would fail rather than pass quietly.
function fakeClient(
  calls: Calls,
  stored: ChatMessage[] = []
): { client: ApiClient } {
  return {
    client: {
      baseUrl: 'http://127.0.0.1:4321',
      fetchConversation: (subject: string) => {
        calls.fetched.push(subject);
        return Promise.resolve(stored);
      },
      addChatMessage: (input: Parameters<ApiClient['addChatMessage']>[0]) => {
        calls.added.push(input);
        return Promise.resolve({
          ...message(input.body),
          id: 'cm-new',
          snippets: input.snippets,
          ...(input.target === undefined ? {} : { target: input.target }),
        });
      },
    } as unknown as ApiClient,
  };
}

function renderPanel(
  options: {
    calls?: Calls;
    stored?: ChatMessage[];
    canResumeAgent?: boolean;
    ref?: RefObject<ReviewChatHandle | null>;
  } = {}
): Calls {
  const calls = options.calls ?? { fetched: [], added: [] };
  const { client } = fakeClient(calls, options.stored ?? []);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(
    <ReviewChatPanel
      client={client}
      runId="r1"
      canResumeAgent={options.canResumeAgent ?? true}
      {...(options.ref === undefined ? {} : { ref: options.ref })}
    />,
    { wrapper }
  );
  return calls;
}

function openDock(): void {
  fireEvent.click(screen.getByRole('button', { name: /ask about this diff/i }));
}

/**
 * Settles the already-resolved promises a mount or a send kicked off, then flushes React.
 *
 * Deliberately not `waitFor`: its polling runs on a timer, and in a full-suite run the shared
 * Pierre render queue starves those for seconds at a time (measured at ~6s against a 1.5s
 * timeout), which surfaces as this file hanging rather than as a slow assertion.
 */
async function settle(): Promise<void> {
  await act(async () => {
    // Several hops, not one: a send is a chain (POST → cache write → state), and each `await`
    // here drains exactly one microtask of it.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('ReviewChatPanel — what it asks the daemon for', () => {
  // The store is keyed by subject, never by run id: this panel is the only piece of the
  // gesture that knows the subject happens to be a run.
  it('fetches the run’s subject, not its bare id', async () => {
    const calls = renderPanel();

    await settle();

    expect(calls.fetched).toEqual(['run:r1']);
  });
});

describe('ReviewChatPanel — the collapsed dock', () => {
  it('shows one input row and no composer until it is opened', () => {
    renderPanel();

    expect(screen.queryByLabelText('Message')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /ask about this diff/i })
    ).not.toBeNull();
  });

  it('opens the composer when the row is clicked', () => {
    renderPanel();

    openDock();

    expect(screen.queryByLabelText('Message')).not.toBeNull();
  });

  it('opens itself when a snippet is attached, so the chip is never hidden', () => {
    const ref = createRef<ReviewChatHandle>();
    renderPanel({ ref });

    act(() => ref.current?.attach(SNIPPET));

    expect(screen.queryByText('src/a.ts (2-4)')).not.toBeNull();
    expect(screen.queryByLabelText('Message')).not.toBeNull();
  });
});

describe('ReviewChatPanel — the conversation', () => {
  it('renders the stored messages', async () => {
    renderPanel({ stored: [message('why is this here?')] });
    await settle();

    openDock();

    expect(screen.queryByText('why is this here?')).not.toBeNull();
  });

  it('posts the body, the attachments and the target against the subject', async () => {
    const ref = createRef<ReviewChatHandle>();
    const calls = renderPanel({ ref });
    act(() => ref.current?.attach(SNIPPET));

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'why?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();

    expect(calls.added[0]).toEqual({
      subject: 'run:r1',
      role: 'human',
      body: 'why?',
      snippets: [SNIPPET],
      target: 'run-agent',
    });
  });

  // A sent message has to show up here — it is the only thing this gesture actually produces
  // today, so a send that vanished would read as a send that failed. Deliberately sent without
  // settling first: the initial fetch is still in flight, and before `cancelQueries` its empty
  // result landed after the write and wiped the message off the screen.
  it('renders the message it just stored', async () => {
    renderPanel();
    openDock();

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'is this dead code?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();

    expect(screen.queryByText('is this dead code?')).not.toBeNull();
  });

  it('clears the pending attachments once the send succeeds', async () => {
    const ref = createRef<ReviewChatHandle>();
    renderPanel({ ref });
    act(() => ref.current?.attach(SNIPPET));

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'why?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();

    // The chip's own remove control, not its label: the sent message renders that same label
    // in its own snippet list, so the label alone never disappears.
    expect(screen.queryByLabelText('Remove src/a.ts (2-4)')).toBeNull();
  });

  it('drops an attachment the reviewer removed before sending', () => {
    const ref = createRef<ReviewChatHandle>();
    renderPanel({ ref });
    act(() => ref.current?.attach(SNIPPET));
    expect(screen.queryByText('src/a.ts (2-4)')).not.toBeNull();

    fireEvent.click(screen.getByLabelText('Remove src/a.ts (2-4)'));

    expect(screen.queryByText('src/a.ts (2-4)')).toBeNull();
  });
});

describe('ReviewChatPanel — which targets are offered', () => {
  it('offers the run’s own agent while it can still be resumed', () => {
    renderPanel({ canResumeAgent: true });
    openDock();

    expect(
      screen.queryByRole('option', { name: "This run's agent" })
    ).not.toBeNull();
  });

  // A reviewed (or still-running) run has no session to resume on that branch, so offering the
  // acting target would be a promise the panel cannot keep.
  it('withholds it once the run’s agent can no longer be resumed', () => {
    renderPanel({ canResumeAgent: false });
    openDock();

    expect(
      screen.queryByRole('option', { name: "This run's agent" })
    ).toBeNull();
    expect(
      screen.queryByRole('option', { name: 'Side conversation' })
    ).not.toBeNull();
  });

  it('falls back to the side conversation as the target it posts', async () => {
    const calls = renderPanel({ canResumeAgent: false });
    openDock();

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'explain this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();

    expect(calls.added[0]?.target).toBe('side');
  });
});

describe('ReviewChatPanel — what it promises', () => {
  // Sending stores the message and nothing else: no agent is dispatched yet. Saying so is the
  // difference between an honest record and a message the reviewer thinks someone read.
  it('says the message is only recorded, not dispatched', () => {
    renderPanel();
    openDock();

    expect(
      screen.queryByText(/nothing is dispatched to an agent yet/i)
    ).not.toBeNull();
  });
});
