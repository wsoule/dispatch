# Editable review diff — what still needs a human, and what was deferred

Companion to `docs/superpowers/specs/2026-08-04-editable-review-diff-design.md`
and `docs/superpowers/plans/2026-08-04-editable-review-diff.md`. Written at the
end of implementation so the open items survive the scratch workspace they were
tracked in.

Nothing here blocks merge. The final whole-branch review closed every finding it
raised and returned "ready with follow-ups".

## Nobody has run this in a browser

Agents could not launch the app, a dev server, or Playwright in this environment
— the Playwright webserver cannot `posix_spawn` git. Everything below is covered
by unit and server tests but has never been observed working:

1. **Run `apps/desktop/e2e/edit-diff.spec.ts`.** It has never been executed. It
   is the only end-to-end coverage of Save → POST → commit anywhere on the
   branch. Watch for a strict-mode locator collision:
   `getByRole('button', {name: 'Save'})` is a generic name inside the full app
   shell.
2. **Gutter `+` → write a suggestion → Apply.** Confirm the anchor resolves
   `exact`. This is the one hop in the anchor chain covered only by `tsc`: the
   composer captures the anchor, but Pierre's hover-to-line derivation feeding
   it is untested because hover tracking does not resolve under happy-dom.
3. **Edit → type → Cancel**, and **edit → type → switch files**. Confirm neither
   produces a commit on the run branch (`git log` in the run's worktree).
4. **Hunk expansion.** The pre-implementation spike measured 8 expand controls
   with a contents loader and 0 without. Confirm they now render, and that
   expanding then editing an out-of-hunk line lands on the right line.
5. **After a successful apply**, confirm the re-rendered diff's _expanded_
   regions show post-edit content. Our loader cache is invalidated, but whether
   `CodeView` re-calls `loadDiffFiles` for a changed item is unverified.
6. **A renamed file's diff** — confirm the old side loads. `FileContents.name`
   for the old side uses `fileDiff.name` rather than `oldPath`; that was a
   judgment call nobody could check without the app.
7. **A file already ticked "viewed"** — confirm clicking its pencil
   force-expands it and the editor attaches.
8. **The suggestion editor mounts and highlights** inside the composer. It has
   never rendered anywhere; happy-dom cannot mount it.
9. **A real `worktree-busy`** — start a follow-up run in the same worktree, then
   save an edit, and confirm the reworded 409 copy reads correctly in place.
10. **A trailing-newline file** — save an edit and confirm the newline
    round-trips through `onItemEditComplete` and the commit does not strip it.

## Deliberate behaviour worth a second opinion

- **Switching files mid-edit silently discards the reviewer's typing.** This is
  correct as implemented — the alternative was silently committing it, which is
  what the code did before the final fix wave — but it is worth deciding whether
  a warning belongs there.
- **A recoverable 409 closes the editor and does not preserve the draft.**
  Pierre offers no mechanism to seed a reattached editor with draft text, so the
  copy was made honest instead ("this edit was not saved — … reopen the file and
  redo it").

## Deferred, with reasoning

Each was triaged by the final review as fine to defer.

| Item                                                                              | Where                        | Why it can wait                                                                                                                        |
| --------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Switching **runs** mid-edit leaves `editing`/`loaded`/`sessionRef` on the old run | `PierreReviewDiff.tsx`       | Fails safe — Save hits `409 stale-base` rather than committing to the wrong run. A reset keyed on `runId` closes it.                   |
| `restoreIndexEntry`'s outcome is discarded                                        | `packages/server/src/api.ts` | The response is still an honest 500, but a failed restore would silently lose an agent's staged blob.                                  |
| A suggestion anchored to a **blank line** is permanently un-appliable             | `resolveAnchor`              | Pre-existing rule: an empty anchor matches half the file, so it is deliberately never followed.                                        |
| Mid-merge worktree rejects all reviewer edits                                     | `git commit -- <path>`       | `git` refuses a partial commit during a merge. Fails cleanly and reverts; better than the old bare commit, which swept merge state in. |
| `side=old` path escape answers 404, not 400                                       | `readRunFile`                | Still refused; only the status code differs from its `side=new` sibling.                                                               |
| Second Apply click after success                                                  | `ReviewThread.tsx`           | Now renders a disabled "Applied", so the confusing 409 is unreachable — verify in the app.                                             |
| Loader cache grows unbounded per session                                          | `useRunFileContents.ts`      | Growth only, no stale reads. Holds both sides of every file of every run visited, so a long session over large files is tens of MB.    |
| `EISDIR` / TOCTOU on `readRunFile`                                                | `api.ts`                     | Opaque 500, read-only, no escape. The only client sends parsed patch filenames.                                                        |
| `reviewedAt` enforcement                                                          | —                            | Closed in the final wave (`409 run-reviewed` on both write routes).                                                                    |
| Stale comment at `ReviewThread.tsx:97-99`                                         | —                            | Says only `anchor-drifted` disables the button; `run-reviewed` now does too.                                                           |

## What this branch kept getting wrong

Six of the eight fix rounds closed the same bug class: **state that cannot
distinguish two outcomes.** A content assertion that could not tell "never
written" from "written then reverted". An error banner that could not tell "your
draft is safe" from "your draft is gone". A failure written where nothing read
it. A success indistinguishable from never-attempted. Every one passed its
author's tests, lint, and typecheck, and was caught by a reviewer reasoning
about sequences.

Worth remembering when extending this code: if two different histories can
produce the same state, the type is probably missing a case.
