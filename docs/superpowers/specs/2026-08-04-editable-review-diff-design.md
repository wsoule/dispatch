# Editable review diff

Reviewing an agent's work today is read-only. You can annotate a diff, and you
can send the whole thing back to the agent, but you cannot change a character of
it. A one-word typo costs a full round trip: request changes, re-dispatch, wait
for a model to spend a dollar re-reading the file, review again.

`@pierre/diffs@1.3.1` — already the pinned catalog version — ships a real text
editor and a per-item `edit` flag that makes any file in a `CodeView` typeable
in place. This spec puts that editor into the run review surface with two
destinations: **Apply**, which commits your edit onto the run branch, and
**Suggest**, which attaches your edit to a review comment so it travels back to
the agent as a patch instead of prose.

Scope is the run review surface only. Editing the project working tree on the
Git page, and resolving merge-queue conflicts in-app, are separate specs that
reuse this one's editor seam.

## Background: what Pierre gives us

- `@pierre/diffs/edit` exports an `Editor` class — piece table, undo stack with
  `historyMaxEntries`, bracket matching, `applyEdits()`, `setMarkers()`,
  `focus({lineNumber})`, and optional cross-file state persistence.
- `EditProvider` (React) takes a `createEditor` factory. Any `CodeView` beneath
  it can put items into edit mode.
- `CodeViewDiffItem.edit?: boolean` and `CodeViewFileItem.edit?: boolean` turn a
  single item editable. The flag is **per item, not per range** — there is no
  way to make lines 40–43 typeable while the rest of the file stays read-only.
  Pierre's docs require bumping the item's `version` whenever `edit` changes.
- `CodeView` reports edits through `onItemEditChange` (every keystroke) and
  `onItemEditComplete` (once, with final contents, when the session ends).
  Pierre's own doc comment states committing is user-space: it hands back a
  `FileContents` and takes no position on what that means.

Two consequences shape everything below.

**An editable diff item needs the whole file.** `FileContents.contents` is "the
raw text contents of the file". A diff parsed from a patch only holds the
patch's hunks, so Pierre fills the rest through `BaseDiffOptions.loadDiffFiles`,
a loader the host app supplies. **The desktop app does not supply one today** —
nothing in `apps/desktop/src` sets `loadDiffFiles`. That is required work here,
and the spike below shows it is a correctness prerequisite, not a nicety.

**Suggest cannot use `edit` on the diff item.** Because the flag is whole-file,
a range-scoped suggestion editor is a second, tiny `CodeView` holding a
`CodeViewFileItem` seeded with just the selected lines, rendered inside the
annotation where `ReviewComposer` already lives.

`@pierre/diffs@1.3.2` shipped 2026-08-04. We do not need it, and `bunfig.toml`'s
7-day `minimumReleaseAge` would refuse to install it until ~2026-08-11 anyway.
Stay on 1.3.1.

## Step 0 findings: the editor was spiked before this design was trusted

Edit mode on **diff** items is new and unexercised here, so it was proved first
against a standalone Vite page (a 40-line file, a patch touching one line inside
it, driven headlessly). Everything below is measured, not assumed.

**It works.** Typing into an editable diff item registers (`onItemEditChange`
fired once per keystroke), `onItemEditComplete` returned **all 40 lines** with
the edit at the right line and the first and last lines intact, and toggling
`edit` back off restored the read-only diff with no page errors.

**The document is whole even though the view is not.** In edit mode the diff
still renders only the patch's own rows — 10 of 40 lines. The editor's document
nonetheless holds the entire file: `editor.focus({lineNumber: 3})` on a line
outside the hunk succeeded, and typing there landed correctly at line 3. So
`Apply` writes a correct whole file, but a reviewer can only _click_ lines that
are rendered. Expanding the unchanged regions first raises that to all 80 rows
(40 lines × 2 sides), and edit mode over the expanded file renders fine.

**Without the loader, edit mode is actively unsafe.** Re-running the same page
with no `loadDiffFiles` at all — today's desktop app — the editor still
attaches, but **its document is empty**: `getText()` returned `""`, one line.
Saving that would write an empty file over the agent's work. The expansion
controls also do not render at all in that case (8 expand buttons with the
loader, 0 without) — a stronger statement than "expansion is limited", and the
correction to what `PierreReviewDiff.tsx:58` currently claims.

**Two requirements fall out of that**, both binding on the design below:

1. `edit` must never be set on an item whose contents have not loaded. The
   loader is called lazily — zero calls on first render, one on entering edit —
   so the UI must await it rather than assume it ran.
2. `Apply` must refuse to write empty contents for a file the diff says is
   non-empty, as a second line of defence behind requirement 1.

The spike lives in `.agents/ignore/pierre-edit-spike/` and is not a deliverable.

## Architecture

Three layers, each usable without the one above it.

```
apply / suggest UI          PierreReviewDiff, ReviewThread
        │
editor seam                 pierreEditor.ts + EditProvider + edit flag
        │
worktree file I/O           GET /runs/:id/file, POST /runs/:id/edits
```

### Layer 1 — worktree file I/O (server)

`packages/server/src` writes only its own metadata today (`reviewComments.ts`,
`notes.ts`, `inbox.ts`). Nothing reads or writes a source file in a worktree,
and nothing commits on a human's behalf. This layer is the new surface area, and
where every safety question lives.

**`GitRepo.show(ref, path)`** in `packages/server/src/git/commands.ts` —
`git show <ref>:<path>`, returning `GitOutcome<{ contents: string }>`. Reuses
the existing `PATH_ESCAPE_ERROR` validation that `stage`/`discard` already
apply. `GitRepo` is constructed against a root directory, so a run's worktree is
just another root; no new git layer is needed.

**`GET /api/runs/:id/file?path=…&side=old|new`** → `{ contents, sha }`.

- `side=old` reads the run's base commit via `GitRepo.show`.
- `side=new` reads the working tree.
- `sha` is the sha256 of `contents`, and is what the editor later echoes back as
  its edit precondition.
- 404 when the file does not exist on that side — a deleted or added file has
  only one side, which is exactly what `loadDiffFiles` expects to hear.

**`POST /api/runs/:id/edits`** → body `{ file, contents, baseSha }`, response
`{ commit }`.

1. Validate `file` against path escape.
2. Reject if the worktree is busy, stale, or gone (below).
3. Write `contents` to `<worktreePath>/<file>`.
4. `GitRepo.stage([file])`, then `GitRepo.commit({...})` on the run branch.
5. Broadcast the existing `review.changed` event for this run so open clients
   refetch the diff.

**Attribution comes from the message, not the author.** An earlier draft of this
spec said the reviewer commit would carry a different git identity than the
agent's. That is wrong: nothing in `packages/server/src` sets `--author`,
`GIT_AUTHOR_*`, or a worktree-local `user.name`, so an agent's commits are
already authored by whoever's git config the daemon runs under — the human.
`ActorContext.humanRef` exists but attributes _task activity_, never a commit.

So the commit is marked in the two places that actually differ: a
`review: edit <file>` subject, and a `Dispatch-Reviewer-Edit: <runId>` trailer.
The trailer is the machine-readable half — `git log --format=%(trailers)` can
separate human corrections from agent work without parsing prose, which is what
an audit export needs. This is still the reason to prefer a separate commit over
an amend; the mechanism is just a trailer rather than an identity.

**Four preconditions, all `409`, each with a distinct `error` string:**

- **`worktree-busy`** — any non-terminal run occupies `meta.worktreePath`. This
  is not theoretical: `requestChanges()` (`orchestrator.ts:2790`) starts a new
  run in the _same_ worktree on the _same_ branch, so a reviewer edit and an
  agent follow-up genuinely contend for one directory.
- **`stale-base`** — the file on disk no longer hashes to `baseSha`. The agent
  moved underneath the open editor; rejecting is the only honest answer, since
  writing would silently discard whatever it wrote.
- **`worktree-missing`** — the run was cleaned up and the directory is gone.
- **`empty-contents`** — `contents` is empty for a file that is not empty on
  disk. This exists because the spike found an unloaded editor reports an empty
  document; the frontend already guards against that (below), and this is the
  server refusing to be the thing that erases a file if the guard ever slips.

### Layer 2 — the editor seam (frontend)

**`apps/desktop/src/lib/pierreEditor.ts`** — a `createReviewEditor` factory, the
single place editor options are decided:

- `persistState: true`, so moving between files mid-review keeps each file's
  caret, selection and undo stack. This requires a stable unique `cacheKey` per
  file, which the item builder already has in the file path.
- `matchBrackets: true`, `roundedSelection: true`.
- A `clipboard` override. Pierre's `EditorOptions.clipboard` doc explicitly
  recommends supplying one in a desktop shell rather than relying on the web
  clipboard; Dispatch is a Tauri app.
- `historyMaxEntries` left at its default.

**`PierreReviewDiff.tsx`** wraps its `CodeView` in `<EditProvider>` and gains
`editing: string | null` — the id (file path) of the one file currently
editable. One at a time: concurrent editors would multiply the stale-base
problem by the number of open files for no real gain, and `persistState` already
makes switching cheap.

**`loadDiffFiles` gates edit mode.** The spike showed the loader is lazy — it
had not run at all before the first edit — and that an editor attached to an
unloaded item holds an _empty_ document. So clicking the pencil does not set
`edit` directly: it fetches both sides through `GET /runs/:id/file`, and only
once those resolve does `editing` become that file's id. Until then the pencil
shows a pending state. Getting this order wrong is how a save writes an empty
file over the agent's work, which is why it is stated here rather than left to
the implementer.

The item builder at line 109 sets `edit: id === editing` and bumps `version`
whenever `editing` changes, as Pierre requires. While a file is editable, its
gutter comment affordance is suppressed — `renderGutterUtility` returns `null`
for that item — so the `+` button cannot fight the caret for the same click.

`onItemEditComplete` fires once with the final `FileContents`. That is what
POSTs to `/edits`; on success the run-diff query is invalidated and the diff
re-renders against the new HEAD, with `editing` cleared.

**Editing is offered alongside expansion, not instead of it.** In edit mode the
diff still shows only the patch's rows, so a line outside the hunk cannot be
clicked until its region is expanded — the same shape GitHub has. The document
is whole regardless, so an edit made after expanding, and one made inside the
hunk, land identically.

### Layer 3 — the two destinations

**Apply** — a pencil in the file header, via `renderHeaderMetadata(item)`. Click
it and the file becomes typeable; the header swaps to `Save` / `Cancel`. `Save`
ends the edit session, which fires `onItemEditComplete` and posts the edit.
`Cancel` clears `editing` without posting.

**Suggest** — the existing gutter `+` opens `ReviewComposer` as it does today,
now with a code editor beneath the comment box: a nested `CodeView` holding one
`CodeViewFileItem` in edit mode, seeded with the text of the selected lines and
named after the file so Shiki infers the right language. You get real
highlighting in the suggestion box, which GitHub's plain textarea does not.

The composer submits with `suggestion` set to the editor's contents when they
differ from the seed, and unset when they do not — a comment with no edit stays
an ordinary comment. It offers `Suggest` (save the comment) and `Apply now`
(save the comment _and_ immediately apply it, for when you already know you want
it in).

### Data model

`ReviewComment` gains one optional field, in both
`packages/server/src/reviewComments.ts:23` and its mirror at
`packages/client/src/api.ts:823`:

```ts
/**
 * Replacement text for lines `startLine..line`, when the reviewer wrote one.
 * Absent on a plain prose comment.
 */
suggestion?: string;
```

Existing comment files parse unchanged — the field is optional and absent
everywhere until someone writes one.

**`formatCommentsForAgent`** (`reviewComments.ts:240`) renders a fenced
` ```suggestion ` block after the comment body, and its preamble gains one
sentence: suggestions are to be applied exactly as written. That function's own
doc comment already calls itself the contract for what reaches the agent, so
this extends an existing promise rather than opening a second channel.

**Applying a suggestion** reuses `POST /edits`. A new
`POST /api/runs/:id/comments/:commentId/apply` reads the current file, splices
`suggestion` over `startLine..line`, and performs the same write-stage-commit —
but only after `resolveAnchor` (`reviewComments.ts:91`) returns `exact` for the
comment. `moved` or `outdated` means the code shifted since the suggestion was
written, and splicing by line number would land the edit on unrelated code. In
that case the endpoint returns `409 anchor-drifted` and the UI disables the
button with the reason visible. That anchor logic already exists and is tested;
it only needs to gate this.

Applying does not resolve the thread. Resolving is the reviewer saying "never
mind"; applying is the reviewer saying "done" — and the record of a human edit
should survive in the conversation either way.

## Error handling

Every failure is a message in the review surface, never a silent no-op:

| Condition                 | Where                   | What the reviewer sees                                                                                                             |
| ------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `worktree-busy`           | Apply, Apply-suggestion | "An agent is working in this worktree — wait for it to finish." Edit stays open, nothing lost.                                     |
| `stale-base`              | Apply                   | "This file changed while you were editing. Reload the diff to see the new version." Edit stays open so the text can be copied out. |
| `worktree-missing`        | Apply                   | "This run's worktree is gone." Edit mode disabled for the whole run.                                                               |
| `anchor-drifted`          | Apply-suggestion        | Button disabled, with the anchor state named.                                                                                      |
| `empty-contents`          | Apply                   | "Couldn't read this file — nothing was written." Should be unreachable behind the load gate; if it fires, the gate has a bug.      |
| Contents fail to load     | Pencil click            | The pencil returns to its resting state with "Couldn't load this file." Edit mode is never entered, so no empty document exists.   |
| Patch Pierre cannot parse | Diff render             | Unchanged from today — `files` is empty and the comment panel still works (`PierreReviewDiff.tsx:102`).                            |
| Editor throws             | Diff render             | The existing `ErrorBoundary` wrapping `CodeView` already contains this.                                                            |

Edit mode is hidden entirely, rather than shown disabled, when the run is not
terminal (`isTerminalRunState`) or has already been reviewed
(`meta.reviewedAt !== undefined`, which is what merging sets). That matches how
`RunReviewView` already hides the PR action when the project cannot open PRs
(`RunReviewView.tsx:27`) — there is nothing the reviewer could do in-app to make
a disabled pencil work, so showing one is noise.

## Testing

**Server (`bun test`, `packages/server`)**

- `GitRepo.show` — existing file, missing file, path escape rejection.
- `POST /edits` — happy path writes and commits on the run branch; each of the
  four 409s; path escape; the commit carries the `Dispatch-Reviewer-Edit`
  trailer with this run's id.
- `GET /file` — both sides, a file missing on one side, and that `sha` matches
  the sha256 the edit precondition will later compare against.
- Suggestion splice — single line, multi-line range, and each `resolveAnchor`
  state (`exact` applies, `moved` and `outdated` both 409).
- `formatCommentsForAgent` — a comment with a suggestion renders the fenced
  block; one without is byte-identical to today's output.
- `ReviewCommentStore` round-trips `suggestion`, and a comment file written
  before this change still parses.

**Desktop (`bun test`, `apps/desktop`)**

- The helper that derives a suggestion's seed text from a selected line range,
  unit tested the way `pierreTree.test.ts` tests its own helper.
- The item builder sets `edit` on exactly one item and bumps `version` when
  `editing` changes.
- **The load gate**: the item builder never sets `edit` for a file whose
  contents have not resolved. This is the unit test standing in for the failure
  the spike found, and it is the most important one in this list.

**End-to-end (Playwright)** — one spec: open a terminal run's review, click the
pencil, type, save, and assert the diff re-renders with the new text and the run
gains a commit. Per `.agents/skills/testing-and-verification`, keep it to the
one path that proves the wiring. Note the storefront fixture is gitignored and
keyed by `sha256(rootDir)`, so a worktree regenerates it; do not regenerate PNG
baselines locally.

**Verification baseline** — `bun run format` and `bun run lint` from the root,
plus `bun run tsc` and focused tests in `packages/server`, `packages/client` and
`apps/desktop`.

## What this deliberately does not do

- **No amend, no force-push.** A reviewer edit is always a new commit.
- **No multi-file edit session.** One file editable at a time.
- **No auto-apply on send-back.** Suggestions travel as text; a human decides
  when one becomes a commit.
- **No editing on a merged or non-terminal run.**
- **No conflict resolution and no working-tree editing.** Separate specs.
