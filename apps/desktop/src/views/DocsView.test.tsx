import type { ApiClient, DocRead, DocSummary } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { CONFLICT_HOLD_MS } from '../lib/docBuffer';
import { AUTOSAVE_DEBOUNCE_MS } from '../lib/editorBuffer';

// The doc page's diffs reach `PierreWorkerPool`, whose `?worker&url` import
// `bun test` cannot resolve; stubbed the way TaskView.test.tsx does.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));
const { DocsView } = await import('./DocsView');

const summary = {
  id: 'doc-1',
  handle: 'auth',
  title: 'Auth refactor',
  scope: 'team',
  status: 'draft',
  unreviewed: true,
  reviewedRev: null,
  conflicted: false,
  restored: null,
  rel: null,
  fromParent: false,
  head: { id: 'rev-1', n: 1, hash: 'h1', bytes: 10, sealed: true },
  published: null,
  lastPublishPath: null,
  updatedBy: 'run:r-1',
  updatedAt: '2026-09-26T10:00:00.000Z',
} as unknown as DocSummary;
const read = {
  doc: summary,
  rev: {
    id: 'rev-1',
    n: 1,
    hash: 'h1',
    author: 'run:r-1',
    summary: 'created',
  },
  links: [
    {
      doc: 'doc-1',
      target: { type: 'task', id: 't-1' },
      rel: 'spec',
      source: 'manual',
    },
  ],
  outline: [],
  section: null,
  text: '# Auth\nbody\n',
  offset: 0,
  nextOffset: null,
  total: 12,
  proposal: null,
} as unknown as DocRead;

function renderView(opts: {
  canDecide: boolean;
  save?: ApiClient['saveDocBody'];
  doc?: DocSummary;
  revisions?: ApiClient['listDocRevisions'];
  diff?: ApiClient['diffDoc'];
  text?: string;
  publish?: ApiClient['publishDoc'];
}) {
  const calls: string[] = [];
  const doc = opts.doc ?? summary;
  const client = {
    listDocs: () => Promise.resolve({ docs: [doc], total: 1 }),
    getDoc: () =>
      Promise.resolve({ ...read, doc, text: opts.text ?? read.text }),
    diffDoc: opts.diff,
    publishDoc: opts.publish,
    saveDocBody:
      opts.save ??
      (() =>
        Promise.resolve({
          ok: true,
          result: {
            status: 'amended',
            handle: 'auth',
            rev: { id: 'rev-1', n: 1, hash: 'h2' },
            doc,
          },
        })),
    markDocReviewed: () => {
      calls.push('reviewed');
      return Promise.resolve(doc);
    },
    setDocStatus: (_ref: string, status: string) => {
      calls.push(`status ${status}`);
      return Promise.resolve(doc);
    },
    listDocRevisions:
      opts.revisions ??
      (() =>
        Promise.resolve({
          revisions: [
            { id: 'rev-1', n: 1, author: 'run:r-1', summary: 'created' },
          ],
        })),
  } as unknown as ApiClient;
  const data = {
    client,
    port: 1,
    messageAccess: {
      canDecide: opts.canDecide,
      canMessage: true,
      explanation: null,
    },
  } as unknown as DispatchProjectData;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocsView data={data} />
    </QueryClientProvider>
  );
  return calls;
}

test('lists docs, opens one in the source editor, and previews it', async () => {
  renderView({ canDecide: true });
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
  expect(editor.value).toBe('# Auth\nbody\n');
  expect(screen.getAllByText('unreviewed').length).toBeGreaterThan(0);
  expect(screen.getByText('task:t-1')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByRole('heading', { name: 'Auth' })).toBeDefined();
});

test('shows Mark reviewed to decide-tier humans only, listing what it covers first', async () => {
  const calls = renderView({ canDecide: true });
  fireEvent.click(await screen.findByText('Auth refactor'));
  fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
  expect(await screen.findByText('rev 1 · run:r-1 · created')).toBeDefined();
  expect(calls).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm reviewed' }));
  await waitFor(() => expect(calls).toEqual(['reviewed']));
});

test('Confirm reviewed refreshes the list rather than review revisions it never showed', async () => {
  const first = [
    { id: 'rev-1', n: 1, author: 'run:r-1', summary: 'created', hash: 'h1' },
  ];
  const moved = [
    { id: 'rev-2', n: 2, author: 'run:r-2', summary: 'agent edit', hash: 'h2' },
    ...first,
  ];
  let lists = 0;
  const revisions = (() => {
    lists += 1;
    return Promise.resolve({ revisions: lists === 1 ? first : moved });
  }) as unknown as ApiClient['listDocRevisions'];
  const calls = renderView({ canDecide: true, revisions });
  fireEvent.click(await screen.findByText('Auth refactor'));
  fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
  await screen.findByText('rev 1 · run:r-1 · created');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm reviewed' }));
  expect(await screen.findByText('rev 2 · run:r-2 · agent edit')).toBeDefined();
  expect(
    screen.getByText('The doc changed since this list loaded. Check it again.')
  ).toBeDefined();
  expect(calls).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm reviewed' }));
  await waitFor(() => expect(calls).toEqual(['reviewed']));
});

test('hides Mark reviewed below decide tier', async () => {
  renderView({ canDecide: false });
  fireEvent.click(await screen.findByText('Auth refactor'));
  await screen.findByLabelText('Editing auth');
  expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
});

test('archives a doc for decide-tier humans', async () => {
  const calls = renderView({ canDecide: true });
  fireEvent.click(await screen.findByText('Auth refactor'));
  fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(calls).toEqual(['status archived']));
});

test('an archived doc opens read-only with Restore, back to the status it left', async () => {
  const archived = {
    ...summary,
    status: 'archived',
    archivedFrom: 'accepted',
  } as DocSummary;
  const calls = renderView({ canDecide: true, doc: archived });
  fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
  expect(editor.readOnly).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(calls).toEqual(['status accepted']));
});

const other = {
  ...summary,
  id: 'doc-2',
  handle: 'plan',
  title: 'Plan',
} as DocSummary;

const amended = (hash: string) => ({
  ok: true,
  result: {
    status: 'amended',
    handle: 'auth',
    rev: { id: 'rev-1', n: 1, hash },
    doc: summary,
  },
});

interface Sent {
  ref: string;
  body: string;
  baseRev: string;
  baseHash: string;
}

// Two docs in the list; every save is recorded, and `answer` replies to the nth.
// A seal records how many saves had been sent by then; `reconnect` re-renders
// the view with a new client, as a changed daemon connection does.
function renderTwoDocs(
  answer: (n: number) => Promise<unknown>,
  getDoc?: (ref: string) => Promise<DocRead>
) {
  const saves: Sent[] = [];
  const seals: number[] = [];
  const queryClient = new QueryClient();
  const client = {
    listDocs: () => Promise.resolve({ docs: [summary, other], total: 2 }),
    getDoc:
      getDoc ??
      ((ref: string) =>
        Promise.resolve({ ...read, doc: ref === 'doc-2' ? other : summary })),
    saveDocBody: (ref: string, input: Omit<Sent, 'ref'>) => {
      saves.push({ ref, ...input });
      return answer(saves.length);
    },
    sealDoc: () => {
      seals.push(saves.length);
      return Promise.resolve(summary);
    },
  } as unknown as ApiClient;
  const view = (c: ApiClient) => (
    <QueryClientProvider client={queryClient}>
      <DocsView
        data={
          {
            client: c,
            port: 1,
            messageAccess: {
              canDecide: true,
              canMessage: true,
              explanation: null,
            },
          } as unknown as DispatchProjectData
        }
      />
    </QueryClientProvider>
  );
  const { rerender } = render(view(client));
  const reconnect = () => rerender(view({ ...client } as ApiClient));
  return { saves, seals, queryClient, reconnect };
}

const BANNER =
  'Rev 2 by run:r-1 changed the same lines. Resolve the marked blocks, then save.';
const MARKED =
  '<<<<<<< head (rev 2, run:r-1)\nx\n=======\n# Auth\nmine\n>>>>>>> yours\n';

// The first save answers 409 with MARKED against rev 2; later ones amend.
const conflictThenAmend = (n: number) =>
  Promise.resolve(
    n === 1
      ? {
          ok: false,
          conflict: {
            code: 'conflict',
            reason: 'merge-conflict',
            head: {
              id: 'rev-2',
              n: 2,
              hash: 'h2',
              body: 'x\n',
              author: 'run:r-1',
            },
            base: { id: 'rev-1', n: 1 },
            hunks: [],
            marked: MARKED,
          },
        }
      : amended('h3')
  );

// Opens doc-1 as unsealed so Save version shows.
const unsealed = (ref: string) =>
  Promise.resolve({
    ...read,
    doc:
      ref === 'doc-2'
        ? other
        : ({
            ...summary,
            head: { ...summary.head, sealed: false },
          } as DocSummary),
  } as DocRead);

const wait = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

test('switching docs saves typing the debounce still held', async () => {
  const { saves } = renderTwoDocs(() => Promise.resolve(amended('h2')));
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor = await screen.findByLabelText('Editing auth');
  fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
  await screen.findByLabelText('Editing plan');
  await waitFor(() =>
    expect(saves).toEqual([
      {
        ref: 'doc-1',
        body: '# Auth\nmine\n',
        baseRev: 'rev-1',
        baseHash: 'h1',
      },
    ])
  );
});

test('switching docs mid-save still saves what was typed after it', async () => {
  let land: () => void = () => {};
  const { saves } = renderTwoDocs((n) =>
    n === 1
      ? new Promise((resolve) => {
          land = () => resolve(amended('h2'));
        })
      : Promise.resolve(amended('h3'))
  );
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor = await screen.findByLabelText('Editing auth');
  fireEvent.change(editor, { target: { value: 'first\n' } });
  await waitFor(() => expect(saves.length).toBe(1), { timeout: 3000 });
  fireEvent.change(editor, { target: { value: 'first\nsecond\n' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
  await screen.findByLabelText('Editing plan');
  land();
  await waitFor(() =>
    expect(saves).toEqual([
      { ref: 'doc-1', body: 'first\n', baseRev: 'rev-1', baseHash: 'h1' },
      {
        ref: 'doc-1',
        body: 'first\nsecond\n',
        baseRev: 'rev-1',
        baseHash: 'h2',
      },
    ])
  );
});

test('review focus 1: switching docs under the conflict banner saves the marked text', async () => {
  const { saves } = renderTwoDocs(conflictThenAmend);
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor = await screen.findByLabelText('Editing auth');
  fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
  await screen.findByText(BANNER, {}, { timeout: 3000 });
  fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
  await screen.findByLabelText('Editing plan');
  await waitFor(() =>
    expect(saves).toEqual([
      {
        ref: 'doc-1',
        body: '# Auth\nmine\n',
        baseRev: 'rev-1',
        baseHash: 'h1',
      },
      { ref: 'doc-1', body: MARKED, baseRev: 'rev-2', baseHash: 'h2' },
    ])
  );
});

test(
  'review focus 1: the marked text saves after a few idle seconds, with the banner still up',
  async () => {
    const { saves } = renderTwoDocs(conflictThenAmend);
    fireEvent.click(await screen.findByText('Auth refactor'));
    const editor =
      await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
    fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
    await screen.findByText(BANNER, {}, { timeout: 3000 });
    // The hold outlasts the ordinary debounce, so resolving can start first.
    await wait(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(saves.length).toBe(1);
    await waitFor(() => expect(saves.length).toBe(2), {
      timeout: CONFLICT_HOLD_MS + 1000,
    });
    expect(saves[1]).toEqual({
      ref: 'doc-1',
      body: MARKED,
      baseRev: 'rev-2',
      baseHash: 'h2',
    });
    await waitFor(() =>
      expect(screen.getByText('Saved · rev 1')).toBeDefined()
    );
    expect(screen.getByText(BANNER)).toBeDefined();
    expect(editor.value).toBe(MARKED);
  },
  CONFLICT_HOLD_MS + 5000
);

test('a changed daemon connection leaves the conflict hold in place', async () => {
  const { saves, reconnect } = renderTwoDocs(conflictThenAmend);
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor = await screen.findByLabelText('Editing auth');
  fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
  await screen.findByText(BANNER, {}, { timeout: 3000 });
  reconnect();
  await wait(AUTOSAVE_DEBOUNCE_MS);
  expect(saves.length).toBe(1);
  expect(screen.getByText(BANNER)).toBeDefined();
});

test('Save version waits out a save in flight, then seals what was typed', async () => {
  let land: () => void = () => {};
  const { saves, seals } = renderTwoDocs(
    (n) =>
      n === 1
        ? new Promise((resolve) => {
            land = () => resolve(amended('h2'));
          })
        : Promise.resolve(amended('h3')),
    unsealed
  );
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor = await screen.findByLabelText('Editing auth');
  fireEvent.change(editor, { target: { value: 'first\n' } });
  await waitFor(() => expect(saves.length).toBe(1), { timeout: 3000 });
  fireEvent.change(editor, { target: { value: 'first\nsecond\n' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
  await wait(50);
  expect(seals).toEqual([]);
  land();
  await waitFor(() => expect(seals).toEqual([2]));
  expect(saves[1]).toEqual({
    ref: 'doc-1',
    body: 'first\nsecond\n',
    baseRev: 'rev-1',
    baseHash: 'h2',
  });
});

test('Save version under the conflict banner saves the marked text but seals nothing', async () => {
  const { saves, seals } = renderTwoDocs(conflictThenAmend, unsealed);
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor = await screen.findByLabelText('Editing auth');
  fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
  await screen.findByText(BANNER, {}, { timeout: 3000 });
  fireEvent.click(screen.getByRole('button', { name: 'Save version' }));
  expect(
    await screen.findByText(
      'Resolve the marked blocks before saving a version.'
    )
  ).toBeDefined();
  expect(saves[1]).toEqual({
    ref: 'doc-1',
    body: MARKED,
    baseRev: 'rev-2',
    baseHash: 'h2',
  });
  expect(seals).toEqual([]);
});

test('a newer head that arrives mid-save shows once the save lands', async () => {
  let land: () => void = () => {};
  let head = read;
  const { saves, queryClient } = renderTwoDocs(
    () =>
      new Promise((resolve) => {
        land = () => resolve(amended('h2'));
      }),
    () => Promise.resolve(head)
  );
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
  fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
  await waitFor(() => expect(saves.length).toBe(1), { timeout: 3000 });
  head = {
    ...read,
    doc: {
      ...summary,
      title: 'Auth refactor v2',
      head: { ...summary.head, id: 'rev-2', n: 2, hash: 'h3' },
    },
    rev: { ...read.rev, id: 'rev-2', n: 2, hash: 'h3' },
    text: '# Auth\nmine\nagent\n',
  } as DocRead;
  await queryClient.invalidateQueries();
  // The newer head renders while the save is still out.
  await screen.findByRole('heading', { name: 'Auth refactor v2' });
  expect(editor.value).toBe('# Auth\nmine\n');
  land();
  await waitFor(() => expect(editor.value).toBe('# Auth\nmine\nagent\n'));
  expect(screen.getByText('Saved · rev 2')).toBeDefined();
});

test('a refused save waits for the next keystroke instead of retrying', async () => {
  const { saves } = renderTwoDocs(() =>
    Promise.reject(new ApiError('archived; restore it first', 409))
  );
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor = await screen.findByLabelText('Editing auth');
  fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
  await screen.findByText('archived; restore it first', {}, { timeout: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(saves.length).toBe(1);
  fireEvent.change(editor, { target: { value: '# Auth\nmine\nmore\n' } });
  await waitFor(() => expect(saves.length).toBe(2), { timeout: 3000 });
});

test('a 409 loads the marked text under the banner', async () => {
  const save = (() =>
    Promise.resolve({
      ok: false,
      conflict: {
        code: 'conflict',
        reason: 'merge-conflict',
        head: { id: 'rev-2', n: 2, hash: 'h2', body: 'x', author: 'run:r-1' },
        base: { id: 'rev-1', n: 1 },
        hunks: [],
        marked: '<<<<<<< head (rev 2, run:r-1)\n',
      },
    })) as ApiClient['saveDocBody'];
  renderView({ canDecide: true, save });
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
  fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
  expect(
    await screen.findByText(
      'Rev 2 by run:r-1 changed the same lines. Resolve the marked blocks, then save.',
      {},
      { timeout: 3000 }
    )
  ).toBeDefined();
  expect(editor.value).toBe('<<<<<<< head (rev 2, run:r-1)\n');
});

test('the merge view resolves a 409 block by block and saves the text without markers', async () => {
  const marked =
    '# Auth\n<<<<<<< head (rev 2, run:r-1)\nagent line\n||||||| base (rev 1)\nbody\n=======\nmine\n>>>>>>> yours\nmiddle\n<<<<<<< head (rev 2, run:r-1)\nagent tail\n=======\nmy tail\n>>>>>>> yours\n';
  const resolved = '# Auth\nagent line\nmiddle\nmy tail\n';
  const bodies: string[] = [];
  const save = ((_ref: string, input: { body: string }) => {
    bodies.push(input.body);
    return Promise.resolve(
      bodies.length === 1
        ? {
            ok: false,
            conflict: {
              code: 'conflict',
              reason: 'merge-conflict',
              head: {
                id: 'rev-2',
                n: 2,
                hash: 'h2',
                body: '# Auth\nagent line\n',
                author: 'run:r-1',
              },
              base: { id: 'rev-1', n: 1 },
              hunks: [],
              marked,
            },
          }
        : {
            ok: true,
            result: {
              status: 'saved',
              handle: 'auth',
              rev: { id: 'rev-3', n: 3, hash: 'h3' },
              doc: summary,
            },
          }
    );
  }) as unknown as ApiClient['saveDocBody'];
  renderView({ canDecide: true, save });
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
  fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
  fireEvent.click(
    await screen.findByRole(
      'button',
      { name: 'Open merge view' },
      { timeout: 3000 }
    )
  );
  const saveResolution = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Save resolution',
  });
  expect(saveResolution.disabled).toBe(true);
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Conflict 1 of 2' })).getByRole(
      'button',
      { name: 'Take head' }
    )
  );
  expect(saveResolution.disabled).toBe(true);
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Conflict 2 of 2' })).getByRole(
      'button',
      { name: 'Take yours' }
    )
  );
  fireEvent.click(saveResolution);
  await waitFor(() => expect(bodies).toEqual(['# Auth\nmine\n', resolved]));
  expect(editor.value).toBe(resolved);
  await waitFor(() =>
    expect(screen.queryByText(/changed the same lines/)).toBeNull()
  );
});

test('a stored merge offers the merge view, naming each side by revision', async () => {
  const text =
    '<<<<<<< rev-01A\nH\n||||||| rev-01O\nB\n=======\nM\n>>>>>>> rev-01B\n';
  const revisions = (() =>
    Promise.resolve({
      revisions: [
        { id: 'rev-01B', n: 8, author: 'human:wyat', summary: 'saved' },
        { id: 'rev-01A', n: 7, author: 'run:r-1', summary: 'edited' },
      ],
    })) as unknown as ApiClient['listDocRevisions'];
  renderView({ canDecide: true, text, revisions });
  fireEvent.click(await screen.findByText('Auth refactor'));
  fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
  expect(await screen.findByText('head · rev 7 by run:r-1')).toBeDefined();
  expect(screen.getByText('yours · rev 8 by human:wyat')).toBeDefined();
});

test('Mark reviewed shows the diff from the last review to the newest revision', async () => {
  const asked: unknown[] = [];
  const diff = ((ref: string, from: string, to: number) => {
    asked.push([ref, from, to]);
    return Promise.resolve({
      chunks: [{ equal: false, a: ['body\n'], b: ['agent text\n'] }],
      spent: false,
    });
  }) as unknown as ApiClient['diffDoc'];
  const revisions = (() =>
    Promise.resolve({
      revisions: [
        { id: 'rev-2', n: 2, author: 'run:r-1', summary: 'edited', hash: 'h2' },
        {
          id: 'rev-1',
          n: 1,
          author: 'human:wyat',
          summary: 'created',
          hash: 'h1',
        },
      ],
    })) as unknown as ApiClient['listDocRevisions'];
  const doc = { ...summary, reviewedRev: 'rev-1' } as unknown as DocSummary;
  renderView({ canDecide: true, doc, revisions, diff });
  fireEvent.click(await screen.findByText('Auth refactor'));
  fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
  expect(await screen.findByText('rev 2 · run:r-1 · edited')).toBeDefined();
  expect(screen.queryByText('rev 1 · human:wyat · created')).toBeNull();
  expect(asked).toEqual([['doc-1', 'rev-1', 2]]);
});

// The view as App mounts it: the doc and section navigation names, and each
// list pick reported back so navigation keeps naming the open doc.
function renderNamed(initialDoc: string | null, initialAnchor: string | null) {
  const picked: string[] = [];
  // The daemon's outline names each heading's line; the one in fenced code is not a heading.
  const body = '# Auth\n- ```md\n  ## API\n  ```\n## API\nroutes\n';
  const client = {
    listDocs: () => Promise.resolve({ docs: [summary, other], total: 2 }),
    getDoc: (ref: string) =>
      Promise.resolve({
        ...read,
        doc: ref === 'doc-2' ? other : summary,
        text: body,
        outline: [
          {
            ord: 1,
            level: 1,
            heading: 'Auth',
            anchor: 'auth',
            bytes: 36,
            line: 0,
          },
          {
            ord: 2,
            level: 2,
            heading: 'API',
            anchor: 'api',
            bytes: 14,
            line: 4,
          },
        ],
      }),
  } as unknown as ApiClient;
  const data = {
    client,
    port: 1,
    messageAccess: { canDecide: true, canMessage: true, explanation: null },
  } as unknown as DispatchProjectData;
  const queryClient = new QueryClient();
  const view = (doc: string | null, anchor: string | null) => (
    <QueryClientProvider client={queryClient}>
      <DocsView
        data={data}
        initialDoc={doc}
        initialAnchor={anchor}
        onSelectDoc={(id) => picked.push(id)}
      />
    </QueryClientProvider>
  );
  const { rerender } = render(view(initialDoc, initialAnchor));
  return {
    picked,
    body,
    rename: (doc: string | null, anchor: string | null) =>
      rerender(view(doc, anchor)),
  };
}

test('opens the doc a link names with the caret on its section heading', async () => {
  const { body } = renderNamed('doc-1', 'api');
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
  await waitFor(() =>
    expect(editor.selectionStart).toBe(body.indexOf('## API\nroutes'))
  );
});

test('a doc named later replaces the open one, and a list pick is reported', async () => {
  const { picked, rename } = renderNamed('doc-1', null);
  await screen.findByLabelText('Editing auth');
  rename('doc-2', null);
  expect(await screen.findByLabelText('Editing plan')).toBeDefined();
  fireEvent.click(screen.getByText('Auth refactor'));
  expect(await screen.findByLabelText('Editing auth')).toBeDefined();
  expect(picked).toEqual(['doc-1']);
});

// A reviewed team doc published at rev 1, its head at `headN`, last asked for docs/next.md.
const publishedDoc = (headN: number) =>
  ({
    ...summary,
    unreviewed: false,
    head: { id: `rev-${headN}`, n: headN, hash: 'h', bytes: 10, sealed: true },
    published: {
      path: 'docs/spec.md',
      rev: 'rev-1',
      n: 1,
      task: 't-pub-1',
      commit: 'abc123',
    },
    lastPublishPath: 'docs/next.md',
  }) as unknown as DocSummary;

test('says how far the head is past the published revision', async () => {
  renderView({ canDecide: true, doc: publishedDoc(2) });
  fireEvent.click(await screen.findByText('Auth refactor'));
  expect(
    await screen.findByText('published rev 1 to docs/spec.md; head is rev 2')
  ).toBeDefined();
});

test('shows no behind line while the head is the published revision', async () => {
  renderView({ canDecide: true, doc: publishedDoc(1) });
  fireEvent.click(await screen.findByText('Auth refactor'));
  await screen.findByLabelText('Editing auth');
  expect(screen.queryByText(/^published rev/)).toBeNull();
});

test('opens Publish with the remembered path and sends what the human typed', async () => {
  const sent: unknown[] = [];
  const publish = ((ref: string, input: unknown) => {
    sent.push([ref, input]);
    return Promise.resolve({
      task: 't-pub-2',
      run: 'r-1',
      dispatchError: null,
      doc: publishedDoc(2),
    });
  }) as unknown as ApiClient['publishDoc'];
  renderView({ canDecide: false, doc: publishedDoc(2), publish });
  fireEvent.click(await screen.findByText('Auth refactor'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Publish to repo' })
  );
  const path =
    await screen.findByLabelText<HTMLInputElement>('Path in the repo');
  expect(path.value).toBe('docs/next.md');
  fireEvent.change(path, { target: { value: 'docs/specs/auth.md' } });
  fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
  await waitFor(() =>
    expect(sent).toEqual([['doc-1', { path: 'docs/specs/auth.md' }]])
  );
  expect(await screen.findByText(/task t-pub-2/)).toBeDefined();
});

test('offers no Publish on an unreviewed draft', async () => {
  renderView({ canDecide: true });
  fireEvent.click(await screen.findByText('Auth refactor'));
  await screen.findByLabelText('Editing auth');
  expect(screen.queryByRole('button', { name: 'Publish to repo' })).toBeNull();
});

test('a named proposal opens the doc on its marked merge', async () => {
  const getDocProposal = mock((_rev: string) =>
    Promise.resolve({
      proposal: { rev: 'rev-p', author: 'run:r-1', state: 'open' },
      title: 'Auth refactor',
      body: '# Auth\nrun\n',
      chunks: [],
      mergeable: { clean: false, headN: 1, headRev: 'rev-1', headHash: 'h1' },
      marked: '# Auth\n<<<<<<< rev-1\nbody\n=======\nrun\n>>>>>>> rev-p\n',
    })
  );
  const client = {
    listDocs: () => Promise.resolve({ docs: [summary], total: 1 }),
    getDoc: () => Promise.resolve(read),
    getDocProposal,
    listDocRevisions: () => Promise.resolve({ revisions: [] }),
  } as unknown as ApiClient;
  const data = {
    client,
    port: 1,
    messageAccess: { canDecide: true, canMessage: true, explanation: null },
  } as unknown as DispatchProjectData;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocsView data={data} initialDoc="doc-1" initialMerge="rev-p" />
    </QueryClientProvider>
  );
  expect(
    await screen.findByRole('region', { name: 'Conflict 1 of 1' })
  ).toBeDefined();
  expect(getDocProposal).toHaveBeenCalledWith('rev-p');
});
