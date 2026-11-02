import type { ApiClient, OverseerRecord, RunMeta } from '@dispatch/client';
import { ListItem } from '@dispatch/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { type ReactNode, useState } from 'react';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { OverseerSession } from '../hooks/useOverseerSession';
import {
  OVERSEER_ATTACHED_EXPLANATION,
  type OverseerFocus,
  TwoViewOverseer,
  type TwoViewOverseerProps,
} from './TwoViewOverseer';

function record(id: string, prompt: string): OverseerRecord {
  return {
    id,
    prompt,
    backendName: 'fake',
    state: 'ready',
    messages: [{ role: 'user', text: prompt, at: '2026-10-06T09:00:00Z' }],
    pendingActions: [],
    pendingApprovals: [],
    undeliveredDecisions: [],
    createdAt: '2026-10-06T09:00:00Z',
    updatedAt: '2026-10-06T09:00:00Z',
  };
}

function session(over: Partial<OverseerSession>): OverseerSession {
  return {
    conversationId: 'w-1',
    record: record('w-1', 'why did r-41 fail?'),
    recordError: null,
    live: null,
    submit: () => Promise.resolve(),
    reply: () => Promise.resolve(),
    sending: false,
    sendError: null,
    revoked: false,
    confirmAction: () => Promise.resolve(),
    decidingActionId: null,
    decideApproval: () => Promise.resolve(true),
    decidingRequestId: null,
    decideError: null,
    model: 'claude-opus-5-5',
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

function Harness({
  overseer,
  client,
  extra = {},
  project = {},
}: {
  overseer: OverseerSession;
  client: Partial<ApiClient>;
  extra?: Partial<TwoViewOverseerProps>;
  project?: Partial<DispatchProjectData>;
}) {
  const [draft, setDraft] = useState('');
  const [queryClient] = useState(() => new QueryClient());
  const data = {
    client: client as ApiClient,
    port: 4321,
    portLoading: false,
    portError: false,
    ...project,
  } as unknown as DispatchProjectData;
  return (
    <QueryClientProvider client={queryClient}>
      <TwoViewOverseer
        data={data}
        overseer={{ ...overseer, draft, setDraft }}
        projectPath="/repo"
        asks={0}
        revoked={false}
        onShowAsks={() => {}}
        onOpenConnectedAgents={() => {}}
        onOpenDoor={() => {}}
        {...extra}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.localStorage.removeItem('dispatch:overseer-dock:/repo');
});

async function send(text: string): Promise<void> {
  const box = screen.getByRole('textbox', { name: 'Follow-up message' });
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('a message Jev reads as a new topic opens a new conversation and sets this one aside', async () => {
  const calls: string[] = [];
  render(
    <Harness
      overseer={session({
        submit: (text) => {
          calls.push(`submit:${text}`);
          return Promise.resolve();
        },
        submitNew: (text) => {
          calls.push(`new:${text}`);
          return Promise.resolve();
        },
      })}
      client={{
        judgeOverseerTopic: () =>
          Promise.resolve({ newTopic: true, confidence: 0.9 }),
        getOverseer: (id: string) => Promise.resolve(record(id, 'old')),
      }}
    />
  );
  await send('plan the checkout redesign');
  expect(calls).toEqual(['new:plan the checkout redesign']);
  expect(
    JSON.parse(
      window.localStorage.getItem('dispatch:overseer-dock:/repo') ?? '[]'
    )
  ).toEqual(['w-1']);
  expect(screen.getByRole('status').textContent).toContain('Put it back');
});

test('a follow-up, a slash command, or no reading stays in the conversation', async () => {
  const calls: string[] = [];
  let judged = 0;
  render(
    <Harness
      overseer={session({
        submit: (text) => {
          calls.push(`submit:${text}`);
          return Promise.resolve();
        },
        submitNew: (text) => {
          calls.push(`new:${text}`);
          return Promise.resolve();
        },
      })}
      client={{
        judgeOverseerTopic: () => {
          judged++;
          return Promise.reject(new Error('down'));
        },
      }}
    />
  );
  await send('rerun it');
  await send('/compact');
  expect(calls).toEqual(['submit:rerun it', 'submit:/compact']);
  expect(judged).toBe(1);
});

test('Set aside docks the conversation and empties the composer', () => {
  let resets = 0;
  render(
    <Harness
      overseer={session({
        reset: () => {
          resets++;
        },
      })}
      client={{ getOverseer: (id: string) => Promise.resolve(record(id, 'x')) }}
    />
  );
  fireEvent.click(screen.getByTestId('overseer-minimize'));
  expect(resets).toBe(1);
  expect(
    JSON.parse(
      window.localStorage.getItem('dispatch:overseer-dock:/repo') ?? '[]'
    )
  ).toEqual(['w-1']);
});

function FocusHarness({
  runs,
  extra = {},
  inflow,
}: {
  runs: RunMeta[];
  extra?: Partial<TwoViewOverseerProps>;
  /** A Coming in child (as posts) given the harness's own focus setter, the
      way App's notifications, posts and drafts open a focus. */
  inflow?: (openFocus: (focus: OverseerFocus) => void) => ReactNode;
}) {
  const [focus, setFocus] = useState<OverseerFocus | null>(null);
  const [draft, setDraft] = useState('');
  const [queryClient] = useState(() => new QueryClient());
  const data = {
    client: {} as ApiClient,
    port: 4321,
    portLoading: false,
    portError: false,
  } as unknown as DispatchProjectData;
  return (
    <QueryClientProvider client={queryClient}>
      <TwoViewOverseer
        data={data}
        overseer={{ ...session({}), draft, setDraft }}
        projectPath="/repo"
        asks={0}
        revoked={false}
        runs={runs}
        focus={focus}
        onFocus={setFocus}
        posts={inflow?.(setFocus)}
        postsCount={inflow === undefined ? 0 : 1}
        renderFocus={(f, onClose) => (
          <div>
            <span>focused {f.kind === 'task' ? f.taskId : f.address}</span>
            <button type="button" onClick={onClose}>
              close focus
            </button>
          </div>
        )}
        onShowAsks={() => {}}
        onOpenConnectedAgents={() => {}}
        onOpenDoor={() => {}}
        {...extra}
      />
    </QueryClientProvider>
  );
}

test('a run on the right opens its task in the middle; Esc gives the talk back', () => {
  render(
    <FocusHarness
      runs={[
        {
          id: 'r-1',
          taskId: 't-9',
          taskTitle: 'Warm the cache',
          state: 'running',
          createdAt: '2026-10-06T09:00:00Z',
          updatedAt: '2026-10-06T09:00:00Z',
        } as RunMeta,
      ]}
    />
  );
  fireEvent.click(screen.getByText('Warm the cache'));
  expect(screen.getByTestId('overseer-focus').textContent).toContain(
    'focused t-9'
  );
  // The talk is hidden, not gone, so the draft survives.
  expect(
    screen.getByRole('textbox', { name: 'Follow-up message', hidden: true })
  ).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByTestId('overseer-focus')).toBeNull();
});

test('a narrow window opens Going out as a sheet, and a run there opens its task', () => {
  render(
    <FocusHarness
      runs={[
        {
          id: 'r-1',
          taskId: 't-9',
          taskTitle: 'Warm the cache',
          state: 'running',
          createdAt: '2026-10-06T09:00:00Z',
          updatedAt: '2026-10-06T09:00:00Z',
        } as RunMeta,
      ]}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Going out' }));
  // The column opens in a modal slide-over on the right as wide as a column,
  // rendered at once; its title names the column and its count, once.
  const panel = screen.getByRole('dialog', { name: 'Going out 1' });
  expect(panel.getAttribute('aria-modal')).toBe('true');
  expect(panel.getAttribute('data-size')).toBe('narrow');
  expect(
    within(panel)
      .getAllByRole('heading')
      .map((heading) => heading.textContent)
  ).toEqual(['Going out 1', 'Running']);
  const sheet = within(panel).getByTestId('overseer-outflow-sheet');
  expect(sheet.textContent).toContain('Warm the cache');
  fireEvent.click(within(sheet).getByText('Warm the cache'));
  expect(screen.getByTestId('overseer-focus').textContent).toContain(
    'focused t-9'
  );
  // Picking a run closes the slide-over (it slides out, then unmounts).
  expect(panel.getAttribute('data-state')).toBe('closing');
});

// The opener is gone (the door sits in the hidden talk, the row in the closed
// sheet), so focus moves into the focus rather than falling to <body>.
test('a run picked in the sheet hands focus to the focus, not to <body>', async () => {
  render(
    <FocusHarness
      runs={[
        {
          id: 'r-1',
          taskId: 't-9',
          taskTitle: 'Warm the cache',
          state: 'running',
          createdAt: '2026-10-06T09:00:00Z',
          updatedAt: '2026-10-06T09:00:00Z',
        } as RunMeta,
      ]}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Going out' }));
  const sheet = screen.getByTestId('overseer-outflow-sheet');
  const row = within(sheet).getByText('Warm the cache');
  act(() => row.closest<HTMLElement>('[role="listitem"]')?.focus());
  fireEvent.click(row);
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  const focus = screen.getByTestId('overseer-focus');
  expect(focus.contains(document.activeElement)).toBe(true);
});

// Every Coming in pick (a notification, a post, a draft) opens a focus the
// same way a Going out run does, and the sheet closes for each of them.
test('a Coming in child that opens a focus closes the slide-over', () => {
  render(
    <FocusHarness
      runs={[]}
      inflow={(openFocus) => (
        <button
          type="button"
          onClick={() => openFocus({ kind: 'address', address: 'human:jev' })}
        >
          A post from Jev
        </button>
      )}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Coming in · 1' }));
  const panel = screen.getByRole('dialog', { name: 'Coming in 1' });
  fireEvent.click(
    within(panel).getByRole('button', { name: 'A post from Jev' })
  );
  expect(screen.getByTestId('overseer-focus').textContent).toContain(
    'focused human:jev'
  );
  expect(panel.getAttribute('data-state')).toBe('closing');
});

// Modal, as the legacy sheet was: a press on the scrim beside it closes it.
test('a press on the scrim closes the column sheet', () => {
  render(<FocusHarness runs={[]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Going out' }));
  const panel = screen.getByRole('dialog', { name: 'Going out 0' });
  const scrim = panel.previousElementSibling;
  if (!(scrim instanceof HTMLElement)) throw new Error('no scrim');
  fireEvent.mouseDown(scrim);
  fireEvent.click(scrim);
  expect(panel.getAttribute('data-state')).toBe('closing');
});

// A trailing control (Coming in's Dismiss buttons) keeps only its own press:
// Escape typed on it still closes the sheet around it.
test('Escape on a row’s trailing button closes the Coming in sheet', () => {
  render(
    <FocusHarness
      runs={[]}
      inflow={() => (
        <div role="list">
          <ListItem
            role="listitem"
            title="Review r-41"
            onClick={() => {}}
            trailing={
              <button type="button" aria-label="Dismiss notification">
                x
              </button>
            }
          />
        </div>
      )}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Coming in · 1' }));
  const panel = screen.getByRole('dialog', { name: 'Coming in 1' });
  const dismiss = within(panel).getByRole('button', {
    name: 'Dismiss notification',
  });
  act(() => dismiss.focus());
  fireEvent.keyDown(dismiss, { key: 'Escape' });
  expect(panel.getAttribute('data-state')).toBe('closing');
});

// The columns keep the legacy window breakpoints, read on the view: from a
// 1280px window (xl) they sit beside the talk, from 1440px at 340px. Both
// modules measure the same container at the same widths.
test('the columns and the narrow-only pieces switch at the legacy widths', () => {
  const css = (file: string) =>
    readFileSync(new URL(file, import.meta.url), 'utf8');
  const view = css('./TwoViewOverseer.module.css');
  const columns = css('../components/overseer/FlowColumns.module.css');
  expect(view).toContain('container: overseer / inline-size;');
  expect(view).toContain('@container overseer (width >= 980px)');
  expect(columns).toContain('@container overseer (width >= 980px)');
  expect(columns).toMatch(
    /@container overseer \(width >= 1140px\)\s*\{\s*\.column\s*\{\s*width: 340px;/
  );
});

test('Coming in opens in the same slide-over, its door counting what waits', () => {
  render(
    <FocusHarness runs={[]} extra={{ postsCount: 2, posts: <p>a post</p> }} />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Coming in · 2' }));
  const panel = screen.getByRole('dialog', { name: 'Coming in 2' });
  expect(within(panel).getByTestId('overseer-inflow-sheet')).toBeTruthy();
});

test('Escape closes the slide-over first, and only then the focus', () => {
  render(
    <FocusHarness
      runs={[
        {
          id: 'r-1',
          taskId: 't-9',
          taskTitle: 'Warm the cache',
          state: 'running',
          createdAt: '2026-10-06T09:00:00Z',
          updatedAt: '2026-10-06T09:00:00Z',
        } as RunMeta,
      ]}
    />
  );
  // A run in the wide column opens the focus. The column doors sit in the
  // talk, hidden under the focus, so the press reaches the hidden door: this
  // checks how the two Escape listeners stack, not a path a person takes.
  fireEvent.click(
    within(screen.getByTestId('overseer-outflow')).getByText('Warm the cache')
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Going out', hidden: true })
  );
  expect(screen.getByTestId('overseer-outflow-sheet')).toBeTruthy();

  const panel = screen.getByRole('dialog', { name: 'Going out 1' });
  fireEvent.keyDown(document.body, { key: 'Escape' });
  // It slides out (inert and hidden from assistive tech), then unmounts.
  expect(panel.getAttribute('data-state')).toBe('closing');
  expect(screen.queryByRole('dialog', { name: 'Going out 1' })).toBeNull();
  expect(screen.getByTestId('overseer-focus')).toBeTruthy();

  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.queryByTestId('overseer-focus')).toBeNull();
});

test('the asks door names how many asks wait, and opens them', () => {
  let shown = 0;
  render(
    <Harness
      overseer={session({})}
      client={{ getOverseer: (id: string) => Promise.resolve(record(id, 'x')) }}
      extra={{
        asks: 2,
        onShowAsks: () => {
          shown++;
        },
      }}
    />
  );
  const door = screen.getByTestId('overseer-asks-door');
  expect(door.textContent).toContain('2 asks wait on you');
  expect(door.getAttribute('data-tone')).toBe('warning');
  fireEvent.click(door);
  expect(shown).toBe(1);
});

test('Set aside shows its icon and its words, with its hint', () => {
  render(
    <Harness
      overseer={session({})}
      client={{ getOverseer: (id: string) => Promise.resolve(record(id, 'x')) }}
    />
  );
  const button = screen.getByRole('button', { name: 'Set aside' });
  expect(button.getAttribute('data-testid')).toBe('overseer-minimize');
  // The words are visible, as before the restyle, not only a tooltip's.
  expect(button.textContent).toBe('Set aside');
  expect(button.querySelector('svg')).not.toBeNull();
  act(() => button.focus());
  const tip = screen.getByRole('tooltip', { hidden: true });
  expect(tip.textContent).toBe('Set this conversation aside and start another');
  expect(button.getAttribute('aria-describedby')).toBe(tip.id);
});

test('an empty project opens on its first-run prompt instead of a fresh conversation', () => {
  render(
    <Harness
      overseer={session({ conversationId: null, record: null })}
      client={{}}
      extra={{ firstRun: <p>first run</p> }}
    />
  );
  expect(screen.getByTestId('overseer-first-run').textContent).toBe(
    'first run'
  );
  expect(
    screen.queryByRole('textbox', { name: 'Overseer opening question' })
  ).toBeNull();
});

test('an open conversation keeps the talk over the first-run prompt', () => {
  render(
    <Harness
      overseer={session({})}
      client={{ getOverseer: (id: string) => Promise.resolve(record(id, 'x')) }}
      extra={{ firstRun: <p>first run</p> }}
    />
  );
  expect(screen.queryByTestId('overseer-first-run')).toBeNull();
});

test('a window on the agent token locks the composer and offers the takeover', () => {
  render(
    <Harness
      overseer={session({})}
      client={{}}
      project={{
        attachedWithoutAppToken: true,
        takeover: { background: true, busy: [], parked: 0, waiting: 0 },
        handleRestartDaemon: () => Promise.resolve(),
      }}
    />
  );
  expect(screen.getByTestId('overseer-attached').textContent).toContain(
    OVERSEER_ATTACHED_EXPLANATION
  );
  expect(screen.getByTestId('daemon-takeover')).toBeTruthy();
  const box = screen.getByRole('textbox', { name: 'Follow-up message' });
  expect((box as HTMLTextAreaElement).disabled).toBe(true);
});

test('a revoked Overseer locks the open conversation, and says it is off', () => {
  render(
    <Harness
      overseer={session({ revoked: true })}
      client={{}}
      extra={{ revoked: true }}
    />
  );
  expect(screen.getByTestId('overseer-off')).toBeTruthy();
  const box = screen.getByRole('textbox', { name: 'Follow-up message' });
  expect((box as HTMLTextAreaElement).disabled).toBe(true);
});

// No record would ever tell the window the agent came back, so the next
// message decides: it works, or it is refused and the banner stays.
test('with no conversation open, a revoked Overseer says it is off but keeps the composer', () => {
  render(
    <Harness
      overseer={session({ revoked: true, conversationId: null })}
      client={{}}
      extra={{ revoked: true }}
    />
  );
  expect(screen.getByTestId('overseer-off')).toBeTruthy();
  const box = screen.getByRole('textbox', {
    name: 'Overseer opening question',
  });
  expect((box as HTMLTextAreaElement).disabled).toBe(false);
});
