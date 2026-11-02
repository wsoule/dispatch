import type {
  ApiClient,
  OverseerAttachment,
  OverseerRecord,
} from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import {
  type OverseerSession,
  useOverseerSession,
} from '../../hooks/useOverseerSession';
import { TasksComposer } from './TasksComposer';

const overseer = {
  record: undefined,
  sending: false,
  sendError: null,
  reply: () => Promise.resolve(),
  upload: () => Promise.resolve([]),
  fetchAttachment: () => Promise.resolve(new Blob()),
} as unknown as OverseerSession;

test('sits as one line until used, carrying the context pill', () => {
  render(
    <TasksComposer
      overseer={overseer}
      about={{ taskId: 't-1', title: 'Fix login' }}
      onOpenOverseer={() => {}}
      disabled={false}
      project="/repo"
    />
  );
  const collapsed = screen.getByTestId('tasks-composer-collapsed');
  expect(collapsed.textContent).toContain('about t-1');
  expect(
    screen.queryByRole('textbox', { name: 'Say something to your agent' })
  ).toBeNull();
  fireEvent.click(collapsed);
  expect(
    screen.getByRole('textbox', { name: 'Say something to your agent' })
  ).toBeTruthy();
});

// The real session, so a test sees what a Tasks send does to the Overseer
// page's composer state (its draft and its pending files), which lives there.
function record(): OverseerRecord {
  return {
    id: 'w-1',
    prompt: 'hi',
    backendName: 'fake',
    state: 'ready',
    messages: [],
    pendingActions: [],
    pendingApprovals: [],
    undeliveredDecisions: [],
    createdAt: '2026-10-26T00:00:00Z',
    updatedAt: '2026-10-26T00:00:00Z',
  };
}

const page: { current: OverseerSession | null } = { current: null };

function WithSession({ client }: { client: ApiClient }) {
  const overseer = useOverseerSession(client, 4321, '/repo');
  page.current = overseer;
  return (
    <TasksComposer
      overseer={overseer}
      about={null}
      onOpenOverseer={() => {}}
      disabled={false}
      project="/repo"
    />
  );
}

function renderWithSession(client: ApiClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WithSession client={client} />
    </QueryClientProvider>
  );
}

// Opens the Tasks composer (when it sits folded), types `text` and sends it
// with Enter.
function sendFromTasks(text: string) {
  const folded = screen.queryByTestId('tasks-composer-collapsed');
  if (folded !== null) fireEvent.click(folded);
  const box = screen.getByRole('textbox', {
    name: 'Say something to your agent',
  });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

const sentFiles: OverseerAttachment[][] = [];

function stubClient(start: () => Promise<OverseerRecord>): ApiClient {
  return {
    baseUrl: 'http://127.0.0.1:4321',
    startOverseer: (
      _prompt: string,
      options: { attachments?: OverseerAttachment[] }
    ) => {
      sentFiles.push(options.attachments ?? []);
      return start();
    },
    getOverseer: () => Promise.resolve(record()),
    uploadOverseerAttachments: (files: File[]) =>
      Promise.resolve(
        files.map((f) => ({
          path: `/att/${f.name}`,
          name: f.name,
          mimeType: 'text/plain',
          size: 1,
        }))
      ),
  } as unknown as ApiClient;
}

afterEach(() => {
  cleanup();
  page.current = null;
  sentFiles.length = 0;
});

test("a send from Tasks leaves the Overseer page's unsent draft alone", async () => {
  renderWithSession(stubClient(() => Promise.resolve(record())));
  await act(async () => {
    page.current?.setDraft('half a question for the Overseer page');
    await page.current?.attachFiles([new File(['x'], 'notes.txt')]);
  });

  sendFromTasks('hi');
  await waitFor(() => expect(page.current?.conversationId).toBe('w-1'));

  expect(page.current?.draft).toBe('half a question for the Overseer page');
  // The page's file waits for the page's own send, not this one.
  expect(sentFiles).toEqual([[]]);
  expect(page.current?.attachments.map((a) => a.name)).toEqual(['notes.txt']);
});

test('a file attached in Tasks goes out with the Tasks message only', async () => {
  renderWithSession(stubClient(() => Promise.resolve(record())));
  fireEvent.click(screen.getByTestId('tasks-composer-collapsed'));
  // The hidden `<input type="file">` behind the composer's paperclip.
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) throw new Error('no file picker');
  fireEvent.change(picker, {
    target: { files: [new File(['x'], 'log.txt')] },
  });
  await waitFor(() => expect(screen.getByText('log.txt')).toBeTruthy());
  expect(page.current?.attachments).toEqual([]);

  sendFromTasks('see the log');
  await waitFor(() => expect(page.current?.conversationId).toBe('w-1'));
  expect(sentFiles.map((files) => files.map((f) => f.name))).toEqual([
    ['log.txt'],
  ]);
  expect(screen.queryByText('log.txt')).toBeNull();
});

test('a failed send from Tasks comes back to Tasks, not the Overseer page', async () => {
  renderWithSession(
    stubClient(() => Promise.reject(new Error('dispatchd refused it')))
  );

  sendFromTasks('hi');
  await waitFor(() =>
    expect(screen.getByTestId('tasks-composer-tray').textContent).toContain(
      'dispatchd refused it'
    )
  );

  expect(page.current?.draft).toBe('');
  expect(page.current?.sendError).toBeNull();
  expect(
    screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Say something to your agent',
    }).value
  ).toBe('hi');
});

// Its files were uploaded to the project's own dispatchd, which the next
// project's daemon has never heard of.
test('a project switch starts the composer afresh', async () => {
  const session = {
    ...overseer,
    upload: (files: File[]) =>
      Promise.resolve(
        files.map((f) => ({
          path: `.dispatch/files/overseer/u-1/${f.name}`,
          name: f.name,
          mimeType: 'text/plain',
          size: 1,
        }))
      ),
  } as OverseerSession;
  const composer = (project: string) => (
    <TasksComposer
      overseer={session}
      about={null}
      onOpenOverseer={() => {}}
      disabled={false}
      project={project}
    />
  );
  const { rerender } = render(composer('/a'));
  fireEvent.click(screen.getByTestId('tasks-composer-collapsed'));
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) throw new Error('no file picker');
  fireEvent.change(picker, {
    target: { files: [new File(['x'], 'log.txt')] },
  });
  await waitFor(() => expect(screen.getByText('log.txt')).toBeTruthy());
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Say something to your agent' }),
    { target: { value: 'half a question about a' } }
  );

  rerender(composer('/b'));
  expect(screen.queryByText('log.txt')).toBeNull();
  expect(screen.getByTestId('tasks-composer-collapsed')).toBeTruthy();
});
