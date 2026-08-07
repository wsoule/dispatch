import { ApiError } from '@dispatch/client';
import type { ApiClient, RunMeta, Snippet } from '@dispatch/client';
import type { CodeViewItem, FileDiffMetadata } from '@pierre/diffs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';
import { isValidElement, type ReactNode, useCallback, useRef } from 'react';

import type { ReviewChatHandle } from './ReviewChatPanel';
import { ReviewChatPanel } from './ReviewChatPanel';
import type { Annotation } from '@/lib/reviewDiffItems';
import {
  buildItems,
  decideEditSave,
  editErrorMessage,
  isEditableDiffType,
  resolveEditFailure,
} from '@/lib/reviewDiffItems';

// The props of the `CodeView` element the diff built, captured below. happy-dom has no layout,
// so `CodeView` renders no rows at all: neither the line selection nor the annotations it
// produces can be driven through the DOM, and this element is the only way to reach them.
let codeViewProps: Record<string, unknown> | null = null;

// `PierreWorkerPool` imports `@pierre/diffs/worker/worker.js?worker&url`, a
// Vite-only specifier `bun test` cannot resolve — stubbed to a passthrough so
// the component itself can be rendered. Nothing else in the suite imports it.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => {
    codeViewProps = isValidElement(children)
      ? (children.props as Record<string, unknown>)
      : null;
    return children;
  },
}));

// Pierre's editor measures text through a 2d canvas context and throws outright
// when it can't get one; happy-dom implements no canvas at all. A fixed-width
// stub is enough — nothing here asserts on layout.
HTMLCanvasElement.prototype.getContext = (() => ({
  font: '',
  measureText: () => ({ width: 7 }),
})) as unknown as HTMLCanvasElement['getContext'];

const { PierreReviewDiff } = await import('./PierreReviewDiff');

// Minimal but type-complete `FileDiffMetadata` — mirrors the helper in
// useRunFileContents.test.ts. Only `name` varies per test; the rest are fields
// `buildItems` never reads.
function fileDiff(name: string): FileDiffMetadata {
  return {
    name,
    type: 'change',
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  };
}

describe('buildItems — the load gate', () => {
  // The single most important test in this feature: the spike behind this task proved that
  // setting `edit: true` on an item whose contents have not resolved yet still attaches an
  // editor, but that editor's document is empty (`getText()` returns `''`). Saving that would
  // write an empty file over the agent's work, so `edit` must never turn on before `loaded`
  // says the file actually arrived.
  it('does not put a file into edit mode before its contents load', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'a.ts',
      loaded: new Set(),
    });

    expect(items[0]?.edit).toBe(false);
  });

  it('puts the file into edit mode once its contents are loaded', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'a.ts',
      loaded: new Set(['a.ts']),
    });

    expect(items[0]?.edit).toBe(true);
  });

  it('bumps version when edit state changes so Pierre re-renders the item', () => {
    const before = buildItems({
      files: [fileDiff('a.ts')],
      editing: null,
      loaded: new Set(['a.ts']),
    });
    const after = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'a.ts',
      loaded: new Set(['a.ts']),
    });

    expect(after[0]?.version).toBeGreaterThan(before[0]?.version ?? 0);
  });

  it('only the editing file goes into edit mode among several loaded files', () => {
    const items = buildItems({
      files: [fileDiff('a.ts'), fileDiff('b.ts')],
      editing: 'a.ts',
      loaded: new Set(['a.ts', 'b.ts']),
    });

    expect(items.find((i) => i.id === 'a.ts')?.edit).toBe(true);
    expect(items.find((i) => i.id === 'b.ts')?.edit).toBe(false);
  });

  it('with editing null, no file is in edit mode regardless of what has loaded', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: null,
      loaded: new Set(['a.ts']),
    });

    expect(items[0]?.edit).toBe(false);
  });
});

describe('buildItems — collapsed state is preserved alongside edit', () => {
  it('a viewed file still collapses while its edit mode is gated off (nothing loaded yet)', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'a.ts',
      loaded: new Set(),
      viewed: new Set(['a.ts']),
    });

    expect(items[0]?.collapsed).toBe(true);
    expect(items[0]?.edit).toBe(false);
  });
});

describe('buildItems — collapsed and edit are never both true for the same item', () => {
  // Pierre's own doc comment for `edit` says it is "ignored while `collapsed` is true". A
  // reviewer who ticked a file "viewed" (which sets `collapsed: true`) could still click its
  // pencil: the load gate resolves, `editing`/`loaded` line up, and without this override
  // `buildItems` would emit `{ edit: true, collapsed: true }` — Pierre never attaches an
  // editor for it, but the one-file-at-a-time lock is still engaged (every other pencil
  // hidden, this file's gutter "+" suppressed), with no escape but re-clicking the same
  // pencil. Entering edit mode must force the file open.
  it('un-collapses the file once it actually enters edit mode, even if marked viewed', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'a.ts',
      loaded: new Set(['a.ts']),
      viewed: new Set(['a.ts']),
    });

    expect(items[0]?.edit).toBe(true);
    expect(items[0]?.collapsed).toBe(false);
  });

  it('leaves a different viewed file collapsed while another file is being edited', () => {
    const items = buildItems({
      files: [fileDiff('a.ts'), fileDiff('b.ts')],
      editing: 'a.ts',
      loaded: new Set(['a.ts', 'b.ts']),
      viewed: new Set(['a.ts', 'b.ts']),
    });

    const a = items.find((i) => i.id === 'a.ts');
    const b = items.find((i) => i.id === 'b.ts');
    expect(a?.edit).toBe(true);
    expect(a?.collapsed).toBe(false);
    // `b.ts` is loaded too, but it isn't the file being edited — it stays exactly as `viewed`
    // says, collapsed and not editable.
    expect(b?.edit).toBe(false);
    expect(b?.collapsed).toBe(true);
  });

  it('re-collapses a viewed file once editing moves elsewhere', () => {
    const items = buildItems({
      files: [fileDiff('a.ts')],
      editing: 'b.ts',
      loaded: new Set(['a.ts', 'b.ts']),
      viewed: new Set(['a.ts']),
    });

    expect(items[0]?.edit).toBe(false);
    expect(items[0]?.collapsed).toBe(true);
  });
});

describe('editErrorMessage — maps applyRunEdit failures to reviewer-facing sentences', () => {
  // `PierreReviewDiff` always closes the editor on any save failure (see `resolveEditFailure`
  // below) — these two sentences say so explicitly rather than implying the draft survived,
  // which the earlier wording ("wait for it to finish") did not contradict but also did
  // nothing to correct while the UI kept the editor open on top of a promise it couldn't
  // keep.
  it('maps worktree-busy, and says the edit was not saved', () => {
    expect(editErrorMessage(new ApiError('worktree-busy', 409))).toBe(
      'An agent is working in this worktree, so this edit was not saved — wait for it to finish, then reopen the file and redo it.'
    );
  });

  it('maps stale-base, and says the edit was not saved', () => {
    expect(editErrorMessage(new ApiError('stale-base', 409))).toBe(
      'This file changed while you were editing, so this edit was not saved. Reload the diff to see the new version.'
    );
  });

  it('maps worktree-missing', () => {
    expect(editErrorMessage(new ApiError('worktree-missing', 409))).toBe(
      "This run's worktree is gone."
    );
  });

  it('maps empty-contents', () => {
    expect(editErrorMessage(new ApiError('empty-contents', 409))).toBe(
      "Couldn't read this file — nothing was written."
    );
  });

  it('maps run-reviewed', () => {
    expect(editErrorMessage(new ApiError('run-reviewed', 409))).toBe(
      'This run has already been reviewed, so its branch is closed to further edits.'
    );
  });

  it('falls back to a generic sentence for an unrecognised 409', () => {
    expect(editErrorMessage(new ApiError('something-else', 409))).toBe(
      'Could not save this edit.'
    );
  });

  it('falls back to a generic sentence for a non-ApiError failure', () => {
    expect(editErrorMessage(new Error('network down'))).toBe(
      'Could not save this edit.'
    );
  });
});

describe('resolveEditFailure — what happens to state after a save fails', () => {
  // Fix round 1 finding: an earlier version re-opened the editor (`editing` back to the
  // file) on `worktree-busy`/`stale-base`, believing that kept the reviewer's draft safe.
  // It did not — `onItemEditComplete` fires only once Pierre has already torn the editor
  // down, and re-attaching it has no documented way to seed the reviewer's unsaved text, so
  // the "recovered" editor actually showed stale on-disk content while the banner claimed
  // their work was fine. `editing` must always end up `null`: closing honestly, never
  // reopening on a promise Pierre can't keep.
  it('always closes the editor, whatever the failure', () => {
    expect(resolveEditFailure(new ApiError('worktree-busy', 409)).editing).toBe(
      null
    );
    expect(resolveEditFailure(new ApiError('stale-base', 409)).editing).toBe(
      null
    );
    expect(
      resolveEditFailure(new ApiError('worktree-missing', 409)).editing
    ).toBe(null);
    expect(
      resolveEditFailure(new ApiError('empty-contents', 409)).editing
    ).toBe(null);
    expect(resolveEditFailure(new Error('network down')).editing).toBe(null);
  });

  it('asks for the cache to be evicted only on stale-base, where disk actually changed', () => {
    expect(
      resolveEditFailure(new ApiError('stale-base', 409)).refetchContents
    ).toBe(true);
  });

  it('does not ask for eviction on failures where disk never changed', () => {
    expect(
      resolveEditFailure(new ApiError('worktree-busy', 409)).refetchContents
    ).toBe(false);
    expect(
      resolveEditFailure(new ApiError('worktree-missing', 409)).refetchContents
    ).toBe(false);
    expect(
      resolveEditFailure(new ApiError('empty-contents', 409)).refetchContents
    ).toBe(false);
    expect(resolveEditFailure(new Error('network down')).refetchContents).toBe(
      false
    );
  });
});

const TWO_FILE_PATCH = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 const a = 0;
-const b = 1;
+const b = 2;
diff --git a/b.ts b/b.ts
index 3333333..4444444 100644
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1,2 @@
 const c = 0;
-const d = 1;
+const d = 2;
`;

// Terminal and not yet reviewed — the only shape that offers edit mode at all.
function runMeta(): RunMeta {
  return { id: 'r1', state: 'finished' } as RunMeta;
}

// Only the two calls the edit path makes; every other member is unreachable here.
function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    fetchRunFile: () =>
      Promise.resolve({
        contents: 'const a = 0;\nconst b = 2;\n',
        sha: 'sha1',
      }),
    applyRunEdit: () => Promise.resolve({ commit: 'abc' }),
    ...overrides,
  } as ApiClient;
}

function renderDiff(props: { only?: string; client?: ApiClient } = {}) {
  return render(
    <PierreReviewDiff
      client={props.client ?? fakeClient()}
      runId="r1"
      meta={runMeta()}
      patch={TWO_FILE_PATCH}
      comments={[]}
      onResolve={() => Promise.resolve()}
      onReply={() => Promise.resolve()}
      {...(props.only === undefined ? {} : { only: props.only })}
    />
  );
}

async function enterEditMode(): Promise<void> {
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit this file' })[0]);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeNull()
  );
}

describe('PierreReviewDiff — Save and Cancel in the file header', () => {
  it('swaps the pencil for Save and Cancel once edit mode is on', async () => {
    renderDiff({ only: 'a.ts' });

    await enterEditMode();

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit this file' })).toBeNull();
  });

  it('Cancel leaves edit mode without sending anything', async () => {
    let posts = 0;
    renderDiff({
      only: 'a.ts',
      client: fakeClient({
        applyRunEdit: () => {
          posts += 1;
          return Promise.resolve({ commit: 'abc' });
        },
      }),
    });
    await enterEditMode();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Edit this file' })
      ).not.toBeNull()
    );
    expect(posts).toBe(0);
  });
});

describe('PierreReviewDiff — switching files while an editor is open', () => {
  // `ReviewView` renders this with `only={selected}` and no `key`, so `editing`
  // outlives the file it names. Every other file's pencil is hidden while one
  // file is being edited, so a stale `editing` locks the whole diff.
  it('unlocks the other files’ pencils when the edited file leaves the view', async () => {
    const { rerender } = renderDiff({ only: 'a.ts' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit this file' }));
    // The lock engaging is the signal edit mode is really on: while one file is
    // being edited, no file offers a plain pencil.
    await waitFor(() =>
      expect(
        screen.queryAllByRole('button', { name: 'Edit this file' }).length
      ).toBe(0)
    );

    rerender(
      <PierreReviewDiff
        client={fakeClient()}
        runId="r1"
        meta={runMeta()}
        patch={TWO_FILE_PATCH}
        comments={[]}
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
        only="b.ts"
      />
    );

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Edit this file' })
      ).not.toBeNull()
    );
  });
});

const ADDED_FILE_PATCH = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+const a = 0;
+const b = 1;
`;

describe('PierreReviewDiff — the pencil gate reads the parsed file’s type', () => {
  // The diff's shell (parse, worker pool, states) moved to `DiffSurface`, but this gate still
  // needs the parsed file list: Pierre can't attach an editor to an added file, so its pencil
  // has to be withheld rather than shown doing nothing.
  it('withholds the pencil on an added file', () => {
    render(
      <PierreReviewDiff
        client={fakeClient()}
        runId="r1"
        meta={runMeta()}
        patch={ADDED_FILE_PATCH}
        comments={[]}
        onResolve={() => Promise.resolve()}
        onReply={() => Promise.resolve()}
      />
    );

    // Guards the assertion below against passing vacuously: a patch that failed to parse would
    // render a message instead of the diff, and show no pencil for that reason.
    expect(
      screen.queryByText(/No changes to show|Couldn’t load the diff/)
    ).toBe(null);
    expect(screen.queryByRole('button', { name: 'Edit this file' })).toBeNull();
  });

  it('still offers it on a changed file', () => {
    renderDiff({ only: 'a.ts' });

    expect(
      screen.queryByRole('button', { name: 'Edit this file' })
    ).not.toBeNull();
  });
});

describe('PierreReviewDiff — nothing to render', () => {
  it('says so when `only` names a file the patch does not contain', () => {
    renderDiff({ only: 'gone.ts' });

    expect(screen.queryByText('No changes to show.')).not.toBeNull();
  });
});

describe('decideEditSave — what a finished edit session should do', () => {
  const session = { baseSha: 'sha1', contents: 'const a = 0;\n' };

  // Pierre fires `onItemEditComplete` when an item is REMOVED as well as when
  // edit turns off (its own doc comment: "item removed (including a controlled
  // setItems([]))"), so a file switch mid-edit delivers a completed session the
  // reviewer never asked to save. Only an explicit Save may post.
  it('refuses to post a session the reviewer never asked to save', () => {
    expect(
      decideEditSave({
        requestedFile: null,
        itemId: 'a.ts',
        contents: 'changed\n',
        session,
      })
    ).toEqual({ post: false, reason: 'not-requested' });
  });

  it('refuses to post when the request names a different file', () => {
    expect(
      decideEditSave({
        requestedFile: 'b.ts',
        itemId: 'a.ts',
        contents: 'changed\n',
        session,
      })
    ).toEqual({ post: false, reason: 'not-requested' });
  });

  it('posts an explicitly saved session that actually changed', () => {
    expect(
      decideEditSave({
        requestedFile: 'a.ts',
        itemId: 'a.ts',
        contents: 'changed\n',
        session,
      })
    ).toEqual({ post: true, baseSha: 'sha1' });
  });

  // Saving an untouched document used to write nothing, stage nothing, and hit
  // `git commit` with an empty index — exit 1, 500, and a red "Could not save
  // this edit." for a deliberate no-op.
  it('treats a byte-identical save as a no-op rather than a request', () => {
    expect(
      decideEditSave({
        requestedFile: 'a.ts',
        itemId: 'a.ts',
        contents: session.contents,
        session,
      })
    ).toEqual({ post: false, reason: 'unchanged' });
  });

  it('refuses to post a session that never went through the load gate', () => {
    expect(
      decideEditSave({
        requestedFile: 'a.ts',
        itemId: 'a.ts',
        contents: 'changed\n',
        session: undefined,
      })
    ).toEqual({ post: false, reason: 'no-session' });
  });
});

describe('isEditableDiffType', () => {
  // Pierre marks an added/deleted diff `isPartial` but excludes it from `canHydrateDiff`, so it
  // never leaves the partial state and the editor never attaches — see
  // docs/pierre-editable-diff-bug.md. A pencil there would be an affordance that does nothing.
  it('refuses an added or deleted file', () => {
    expect(isEditableDiffType('new')).toBe(false);
    expect(isEditableDiffType('deleted')).toBe(false);
  });

  it('allows the types the editor can actually attach to', () => {
    expect(isEditableDiffType('change')).toBe(true);
    expect(isEditableDiffType('rename-changed')).toBe(true);
    expect(isEditableDiffType('rename-pure')).toBe(true);
  });
});

/**
 * The reviewer's real gesture: a drag across the code, which the browser reports as an ordinary
 * DOM text selection on the document. happy-dom lays nothing out, so `CodeView` renders no code
 * rows to drag over — the selected text is placed inside the diff's own container instead and
 * the `selectionchange` event a browser would fire is dispatched.
 *
 * Deliberately NOT Pierre's `onSelectedLinesChange`. That callback cannot fire for this gesture
 * at all (`enableLineSelection` defaults off, and a line selection only ever starts from the
 * line-number column), which is exactly why an earlier version of this feature rendered no bar
 * in a real browser while its tests were green.
 */
function selectText(text: string, host?: Element): void {
  const target = host ?? document.querySelector('diffs-container');
  if (target === null) throw new Error('no diff container to select inside');
  const span = document.createElement('span');
  span.appendChild(document.createTextNode(text));
  target.appendChild(span);
  const range = document.createRange();
  range.selectNodeContents(span);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

function renderForSelection(
  props: {
    onAddToChat?: (snippet: Snippet) => void;
    withComposer?: boolean;
  } = {}
) {
  return render(
    <PierreReviewDiff
      client={fakeClient()}
      runId="r1"
      meta={runMeta()}
      patch={TWO_FILE_PATCH}
      only="a.ts"
      comments={[]}
      onResolve={() => Promise.resolve()}
      onReply={() => Promise.resolve()}
      {...(props.withComposer === false
        ? {}
        : { onAdd: () => Promise.reject(new Error('not used here')) })}
      {...(props.onAddToChat === undefined
        ? {}
        : { onAddToChat: props.onAddToChat })}
    />
  );
}

function selectionBar(): HTMLElement | null {
  return screen.queryByRole('toolbar', { name: 'Selection actions' });
}

/**
 * Settles the already-resolved contents fetch a selection kicks off, then flushes React.
 *
 * Deliberately not `waitFor`: its polling runs on a timer, and in a full-suite run Pierre's
 * shared render queue starves those for seconds at a time, which surfaces as a hang rather
 * than a slow assertion.
 */
async function settle(): Promise<void> {
  await act(async () => {
    // Several hops, not one: each `await` here drains exactly one microtask of the chain.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('PierreReviewDiff — the selection action bar', () => {
  it('offers nothing until code is actually selected', () => {
    renderForSelection({ onAddToChat: () => {} });

    expect(selectionBar()).toBeNull();
  });

  it('appears once code in this file is selected', async () => {
    renderForSelection({ onAddToChat: () => {} });

    selectText('const b = 2;');
    await settle();

    expect(selectionBar()).not.toBeNull();
  });

  it('goes away when the selection is dropped', async () => {
    renderForSelection({ onAddToChat: () => {} });
    selectText('const b = 2;');
    await settle();
    expect(selectionBar()).not.toBeNull();

    clearSelection();
    await settle();

    expect(selectionBar()).toBeNull();
  });

  // A selection in the chat dock, or in a comment thread, is not a selection in the diff.
  it('ignores a selection outside the diff', async () => {
    renderForSelection({ onAddToChat: () => {} });
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    selectText('const b = 2;', outside);
    await settle();

    expect(selectionBar()).toBeNull();
  });

  // Text that is not in the file has no lines to name — a drag across the deleted side of a
  // split diff, or one taken against contents that have since moved on.
  it('stays away for text this file does not contain', async () => {
    renderForSelection({ onAddToChat: () => {} });

    selectText('const gone = 1;');
    await settle();

    expect(selectionBar()).toBeNull();
  });

  // Selecting again must not leave the bar acting on the previous selection for a frame: the
  // bar moves with the new one immediately, so a click there would attach the wrong code.
  it('drops the previous selection the moment a new one starts', async () => {
    renderForSelection({ onAddToChat: () => {} });
    selectText('const b = 2;');
    await settle();
    expect(selectionBar()).not.toBeNull();

    selectText('const a = 0;');

    expect(selectionBar()).toBeNull();
  });

  it('withholds Add to chat where there is no chat to add to', async () => {
    renderForSelection();

    selectText('const b = 2;');
    await settle();

    expect(selectionBar()).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeNull();
  });

  it('hands the chat the selected code and the lines it sits on', async () => {
    const attached: Snippet[] = [];
    renderForSelection({ onAddToChat: (snippet) => attached.push(snippet) });

    // Spans both lines of the file `fakeClient` serves, so the range is not the trivial one.
    selectText('const a = 0;\nconst b = 2;');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));

    expect(attached).toEqual([
      {
        file: 'a.ts',
        startLine: 1,
        endLine: 2,
        text: 'const a = 0;\nconst b = 2;',
      },
    ]);
  });

  it('names the lines a selection part-way down the file sits on', async () => {
    const attached: Snippet[] = [];
    renderForSelection({ onAddToChat: (snippet) => attached.push(snippet) });

    selectText('const b = 2;');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));

    expect(attached[0]).toMatchObject({ startLine: 2, endLine: 2 });
  });

  it('copies the selected code to the clipboard', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    renderForSelection({ onAddToChat: () => {} });

    selectText('const b = 2;');
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(written).toEqual(['const b = 2;']);
  });

  // Comment is a second entry point to the composer the gutter "+" already opens, not a
  // parallel one — so it must produce the same composer annotation on the same range.
  it('opens the existing composer on the selected range', async () => {
    renderForSelection({ onAddToChat: () => {} });
    selectText('const a = 0;\nconst b = 2;');
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await settle();

    const items = codeViewProps?.items as CodeViewItem<Annotation>[];
    const annotations = items.flatMap((item) =>
      'annotations' in item ? (item.annotations ?? []) : []
    );
    expect(
      annotations.map((a) => a.metadata).filter((m) => m?.kind === 'composer')
    ).toEqual([{ kind: 'composer', file: 'a.ts', startLine: 1 }]);
  });
});

// The gesture end to end, wired exactly the way `ReviewView` wires it: the diff owns the
// selection, the dock owns the pending attachments, and neither module in between
// (`SelectionActions`, `SnippetComposer`) knows a run exists. This is the only test that holds
// the two halves together.
describe('select code, then chat about it', () => {
  function Wiring({ client }: { client: ApiClient }) {
    const chatRef = useRef<ReviewChatHandle>(null);
    const handleAddToChat = useCallback((snippet: Snippet) => {
      chatRef.current?.attach(snippet);
    }, []);
    return (
      <>
        <PierreReviewDiff
          client={client}
          runId="r1"
          meta={runMeta()}
          patch={TWO_FILE_PATCH}
          only="a.ts"
          comments={[]}
          onResolve={() => Promise.resolve()}
          onReply={() => Promise.resolve()}
          onAddToChat={handleAddToChat}
        />
        <ReviewChatPanel
          ref={chatRef}
          client={client}
          runId="r1"
          canResumeAgent
        />
      </>
    );
  }

  it('carries the selected lines all the way into a stored message', async () => {
    const added: Parameters<ApiClient['addChatMessage']>[0][] = [];
    const client = fakeClient({
      baseUrl: 'http://127.0.0.1:4321',
      fetchConversation: () => Promise.resolve([]),
      addChatMessage: (input: Parameters<ApiClient['addChatMessage']>[0]) => {
        added.push(input);
        return Promise.resolve({
          id: 'cm-1',
          role: 'human' as const,
          body: input.body,
          snippets: input.snippets,
          created: '2026-08-06T00:00:00.000Z',
        });
      },
    } as Partial<ApiClient>);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Wiring client={client} />
      </QueryClientProvider>
    );

    selectText('const a = 0;\nconst b = 2;');
    await settle();
    expect(selectionBar()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));

    // The dock opened itself and is holding the snippet as a chip.
    await waitFor(() =>
      expect(screen.queryByText('a.ts (1-2)')).not.toBeNull()
    );

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'why is this needed?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(added.length).toBe(1));
    expect(added[0]).toEqual({
      subject: 'run:r1',
      role: 'human',
      body: 'why is this needed?',
      snippets: [
        {
          file: 'a.ts',
          startLine: 1,
          endLine: 2,
          text: 'const a = 0;\nconst b = 2;',
        },
      ],
      target: 'run-agent',
    });
  });
});
