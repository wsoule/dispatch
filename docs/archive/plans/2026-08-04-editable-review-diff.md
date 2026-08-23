# Editable Review Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer edit an agent's diff in place — committing the fix onto
the run branch, or attaching it to a review comment as a suggestion the agent
applies.

**Architecture:** Three layers. The server gains the ability to read and write
one file inside a run's worktree and commit it. The desktop app gains a single
Pierre `Editor` factory behind an `EditProvider`, plus the `loadDiffFiles`
loader that makes an editable diff item hold a real document. The review UI then
offers two destinations for an edit: Apply (commit) and Suggest (comment
metadata).

**Tech Stack:** Bun, TypeScript, React 19, `@pierre/diffs@1.3.1`, Tauri,
Playwright.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-editable-review-diff-design.md`. Read
  it before Task 1.
- `export AGENT=1` at the start of every terminal session.
- Use `bun` only. Never `npm`/`pnpm`/`npx`.
- `bun ws <dir-name> <script>` takes the **directory** name:
  `bun run ws server test`, not `@dispatch/server`.
- Stay on `@pierre/diffs@1.3.1`. Do not bump — `bunfig.toml` sets
  `minimumReleaseAge` to 7 days and 1.3.2 shipped 2026-08-04.
- Never add a dependency version to a package `package.json`; the root
  `workspaces.catalog` owns versions.
- Preserve trailing newlines.
- After every task: `bun run format` and `bun run lint` from the repo root. Lint
  baseline in this worktree is **0 errors, 159 warnings** — any error is yours.
- `packages/server` tests take ~390s. Pass an explicit timeout; do not assume a
  hang.
- Comments: 1–2 lines, explain _why_, no incident narratives.

## File Structure

### Created

- `apps/desktop/src/lib/pierreEditor.ts` — the single `Editor` factory. Owns
  editor options; knows nothing about runs.
- `apps/desktop/src/lib/suggestionRange.ts` — pure helpers converting between a
  selected line range and suggestion text. Unit-testable without a DOM.
- `apps/desktop/src/lib/suggestionRange.test.ts`
- `apps/desktop/src/hooks/useRunFileContents.ts` — fetches and caches a run's
  file contents per side; backs both `loadDiffFiles` and the edit-mode load
  gate.
- `packages/server/test/run-file-edits.test.ts` — routes for reading and writing
  a worktree file.

### Modified

- `packages/server/src/git/commands.ts` — add `show()`.
- `packages/server/src/reviewComments.ts` — `suggestion` field, suggestion block
  in `formatCommentsForAgent`, `spliceSuggestion` helper.
- `packages/server/src/api.ts` — three routes and their handlers.
- `packages/client/src/api.ts` — types and bindings mirroring those routes.
- `apps/desktop/src/components/runs/PierreReviewDiff.tsx` — `EditProvider`,
  loader, edit state, pencil, load gate.
- `apps/desktop/src/components/runs/ReviewThread.tsx` — suggestion editor in the
  composer, Apply on a thread.

---

### Task 1: `GitRepo.show(ref, path)`

Reads a file at a ref. Nothing in the repo reads file contents through git
today.

**Files:**

- Modify: `packages/server/src/git/commands.ts` (after `diffCommit`, ~line 185)
- Test: `packages/server/test/git.test.ts`

**Interfaces:**

- Produces:
  `GitRepo.show(ref: string, path: string): Promise<GitOutcome<{ contents: string }>>`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/git.test.ts`:

```ts
describe('GitRepo: show', () => {
  it('reads a file at a ref', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    setupGit(root, ['add', 'a.txt']);
    setupGit(root, ['commit', '-m', 'add a']);
    writeFileSync(join(root, 'a.txt'), 'changed\n');

    const result = await repo.show('HEAD', 'a.txt');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contents).toBe('hello\n');
  });

  it('fails for a path that is not in the ref', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello\n');
    setupGit(root, ['add', 'a.txt']);
    setupGit(root, ['commit', '-m', 'add a']);

    const result = await repo.show('HEAD', 'missing.txt');

    expect(result.ok).toBe(false);
  });

  it('refuses a path that escapes the repository root', async () => {
    const result = await repo.show('HEAD', '../outside.txt');

    expect(result).toEqual({ ok: false, stderr: PATH_ESCAPE_ERROR });
  });

  it('refuses a ref that looks like a flag', async () => {
    const result = await repo.show('--upload-pack=x', 'a.txt');

    expect(result).toEqual({ ok: false, stderr: INVALID_REF_ERROR });
  });
});
```

Add `PATH_ESCAPE_ERROR` and `INVALID_REF_ERROR` to the existing `GitRepo` import
at the top of the file if they are not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/git.test.ts -t "show"` Expected: FAIL
— `repo.show is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/server/src/git/commands.ts`, directly after `diffCommit`:

```ts
  // Reads one file's contents at a ref. `--` separates the ref:path spec from
  // pathspecs so a path starting with a dash can't be read as a flag.
  async show(ref: string, path: string): Promise<GitOutcome<{ contents: string }>> {
    if (!isSafeRef(ref)) return { ok: false, stderr: INVALID_REF_ERROR };
    const safe = this.safePath(path);
    if (safe === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
    const result = await this.runGit(['show', `${ref}:${safe}`, '--']);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, contents: result.stdout };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/git.test.ts -t "show"` Expected: PASS,
4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/git/commands.ts packages/server/test/git.test.ts
git commit -m "feat(server): read a file at a ref with GitRepo.show"
```

---

### Task 2: `GET /api/runs/:id/file`

Serves one side of a file so the desktop app can supply `loadDiffFiles`.
Read-only; no writes yet.

**Files:**

- Modify: `packages/server/src/api.ts` (handler near `listReviewComments` ~line
  886; route near the `diff` route ~line 2820)
- Modify: `packages/client/src/api.ts` (interface ~line 1388, binding
  ~line 1838)
- Test: `packages/server/test/run-file-edits.test.ts` (create)

**Interfaces:**

- Consumes: `GitRepo.show` from Task 1.
- Produces:
  - Route `GET /api/runs/:id/file?path=<p>&side=old|new` →
    `{ contents: string; sha: string }`
  - Client
    `fetchRunFile(runId: string, path: string, side: 'old' | 'new'): Promise<{ contents: string; sha: string }>`
  - Exported helper `sha256Hex(text: string): string` in
    `packages/server/src/api.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/run-file-edits.test.ts`. Copy the daemon/fixture
bootstrap from the top of `packages/server/test/git-api.test.ts` so this file
starts a real API the same way that one does; then add:

```ts
describe('GET /api/runs/:id/file', () => {
  it('returns the working-tree side with its sha', async () => {
    const res = await apiFetch(`/api/runs/${runId}/file?path=a.txt&side=new`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contents: string; sha: string };
    expect(body.contents).toBe('changed\n');
    expect(body.sha).toBe(sha256Hex('changed\n'));
  });

  it('returns the committed side', async () => {
    const res = await apiFetch(`/api/runs/${runId}/file?path=a.txt&side=old`);
    const body = (await res.json()) as { contents: string };
    expect(body.contents).toBe('hello\n');
  });

  it('404s for a file missing on that side', async () => {
    const res = await apiFetch(
      `/api/runs/${runId}/file?path=nope.txt&side=old`
    );
    expect(res.status).toBe(404);
  });

  it('400s for a missing path', async () => {
    const res = await apiFetch(`/api/runs/${runId}/file?side=new`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/run-file-edits.test.ts` Expected: FAIL
— 404 from the router (no such route).

- [ ] **Step 3: Write minimal implementation**

In `packages/server/src/api.ts`, add near the other run handlers:

```ts
/** Content hash used as the edit precondition — see readRunFile / applyRunEdit. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * GET /api/runs/:id/file — one side of a file in the run's worktree.
 *
 * Backs the diff renderer's `loadDiffFiles`: a patch alone only carries its own
 * hunks, so expansion and edit mode both need the file's real contents.
 */
async function readRunFile(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  const side = url.searchParams.get('side') ?? 'new';
  if (path === null || path === '')
    return errorResponse(400, 'path is required');
  if (!isWorktreeRelativePath(path)) {
    return errorResponse(400, PATH_ESCAPE_ERROR);
  }
  if (side !== 'old' && side !== 'new') {
    return errorResponse(400, `invalid side: ${side} (expected old|new)`);
  }
  const detail = ctx.orchestrator.getRun(runId);
  if (detail === null) return errorResponse(404, `run not found: ${runId}`);
  const meta = detail.meta;
  if (!existsSync(meta.worktreePath)) {
    return errorResponse(409, 'worktree-missing');
  }
  const repo = new GitRepo(meta.worktreePath);
  if (side === 'old') {
    const shown = await repo.show(meta.baseBranch, path);
    if (!shown.ok) return errorResponse(404, shown.stderr);
    return jsonResponse({
      contents: shown.contents,
      sha: sha256Hex(shown.contents),
    });
  }
  const onDisk = join(meta.worktreePath, path);
  if (!existsSync(onDisk)) return errorResponse(404, `no such file: ${path}`);
  const contents = readFileSync(onDisk, 'utf8');
  return jsonResponse({ contents, sha: sha256Hex(contents) });
}
```

Add `createHash` from `node:crypto`, `existsSync`/`readFileSync` from `node:fs`,
`join` from `node:path`, and `GitRepo` to the file's imports if absent.

Wire the route beside the `diff` route:

```ts
if (segments.length === 3 && segments[2] === 'file' && method === 'GET') {
  return await readRunFile(req, ctx, segments[1]);
}
```

Note: the working-tree branch reads through `existsSync`/`readFileSync` rather
than `GitRepo`, because an uncommitted edit is exactly what the reviewer needs
to see and `git show` cannot reach it. That bypasses `GitRepo`'s own `safePath`,
so this route must do its own check — `join(worktreePath, '../../etc/passwd')`
resolves happily and the file exists, so neither `join` nor the 404 stops a
traversal. Add the shared guard next to `sha256Hex` and use it here and in Task
3:

```ts
/**
 * Rejects a path that could escape the worktree it is joined onto. Routes that
 * touch the working tree directly need this because they bypass `GitRepo`,
 * which does its own `safePath` check on every pathspec it passes to git.
 */
export function isWorktreeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('-') || path.startsWith('/')) return false;
  return !path.split('/').includes('..');
}
```

Add this test to the `GET` describe block:

```ts
it('refuses a path that escapes the worktree', async () => {
  const res = await apiFetch(
    `/api/runs/${runId}/file?path=../../etc/passwd&side=new`
  );
  expect(res.status).toBe(400);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/run-file-edits.test.ts` Expected:
PASS, 4 tests.

- [ ] **Step 5: Add the client binding**

In `packages/client/src/api.ts`, in the interface near `fetchReviewComments`:

```ts
  /** One side of a file in a run's worktree. `sha` is the precondition for applyRunEdit. */
  fetchRunFile(
    runId: string,
    path: string,
    side: 'old' | 'new'
  ): Promise<{ contents: string; sha: string }>;
```

And in the implementation object:

```ts
    fetchRunFile: (runId, path, side) =>
      request(
        target,
        `/api/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(path)}&side=${side}`
      ),
```

- [ ] **Step 6: Verify and commit**

```bash
bun run ws client tsc && bun run ws server tsc
git add packages/server/src/api.ts packages/server/test/run-file-edits.test.ts packages/client/src/api.ts
git commit -m "feat(server): serve a run worktree file for diff expansion"
```

---

### Task 3: `POST /api/runs/:id/edits`

Writes a reviewer's edit into the worktree and commits it on the run branch.

**Files:**

- Modify: `packages/server/src/api.ts`
- Modify: `packages/client/src/api.ts`
- Test: `packages/server/test/run-file-edits.test.ts`

**Interfaces:**

- Consumes: `sha256Hex` from Task 2.
- Produces:
  - Route `POST /api/runs/:id/edits`, body
    `{ file: string; contents: string; baseSha: string }` → `{ commit: string }`
  - Client
    `applyRunEdit(runId, input: { file: string; contents: string; baseSha: string }): Promise<{ commit: string }>`
  - Exported const `REVIEWER_EDIT_TRAILER = 'Dispatch-Reviewer-Edit'`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/run-file-edits.test.ts`:

```ts
describe('POST /api/runs/:id/edits', () => {
  it('writes the file and commits it on the run branch', async () => {
    const before = await apiFetch(
      `/api/runs/${runId}/file?path=a.txt&side=new`
    );
    const { sha } = (await before.json()) as { sha: string };

    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({
        file: 'a.txt',
        contents: 'fixed\n',
        baseSha: sha,
      }),
    });

    expect(res.status).toBe(200);
    const { commit } = (await res.json()) as { commit: string };
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('fixed\n');
  });

  it('marks the commit with the reviewer trailer', async () => {
    const before = await apiFetch(
      `/api/runs/${runId}/file?path=a.txt&side=new`
    );
    const { sha } = (await before.json()) as { sha: string };
    await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({
        file: 'a.txt',
        contents: 'fixed\n',
        baseSha: sha,
      }),
    });

    const log = Bun.spawnSync(['git', 'log', '-1', '--format=%B'], {
      cwd: worktree,
    });
    const message = log.stdout.toString();
    expect(message).toContain('review: edit a.txt');
    expect(message).toContain(`Dispatch-Reviewer-Edit: ${runId}`);
  });

  it('409s when the file changed under the editor', async () => {
    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({
        file: 'a.txt',
        contents: 'x\n',
        baseSha: 'deadbeef',
      }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'stale-base',
    });
  });

  it('409s on empty contents for a non-empty file', async () => {
    const before = await apiFetch(
      `/api/runs/${runId}/file?path=a.txt&side=new`
    );
    const { sha } = (await before.json()) as { sha: string };

    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({ file: 'a.txt', contents: '', baseSha: sha }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'empty-contents',
    });
  });

  it('409s while a non-terminal run occupies the worktree', async () => {
    // Put a second, still-running run in the same worktree — exactly what
    // requestChanges() does — and the edit must refuse.
    registerRunInWorktree({ state: 'running', worktreePath: worktree });

    const before = await apiFetch(
      `/api/runs/${runId}/file?path=a.txt&side=new`
    );
    const { sha } = (await before.json()) as { sha: string };
    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({
        file: 'a.txt',
        contents: 'fixed\n',
        baseSha: sha,
      }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'worktree-busy',
    });
  });

  it('refuses a path that escapes the worktree', async () => {
    const res = await apiFetch(`/api/runs/${runId}/edits`, {
      method: 'POST',
      body: JSON.stringify({
        file: '../escape.txt',
        contents: 'x\n',
        baseSha: 'x',
      }),
    });

    expect(res.status).toBe(400);
  });
});
```

`registerRunInWorktree` is a local helper in this test file that creates a
second run in the registry sharing `worktreePath`; model it on how
`git-api.test.ts` seeds its fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/run-file-edits.test.ts -t "edits"`
Expected: FAIL — router 404s.

- [ ] **Step 3: Write minimal implementation**

```ts
/** Trailer marking a commit a human made while reviewing, so an audit export can
 *  separate reviewer corrections from agent work without parsing the subject. */
export const REVIEWER_EDIT_TRAILER = 'Dispatch-Reviewer-Edit';

/**
 * POST /api/runs/:id/edits — write one file into the run's worktree and commit it.
 *
 * Every rejection below is a 409 with a machine-readable `error`, because each
 * one has a different fix and the UI shows a different sentence for each.
 */
async function applyRunEdit(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    file?: unknown;
    contents?: unknown;
    baseSha?: unknown;
  };
  if (typeof body.file !== 'string' || body.file === '') {
    return errorResponse(400, 'file is required');
  }
  if (typeof body.contents !== 'string') {
    return errorResponse(400, 'contents is required');
  }
  if (typeof body.baseSha !== 'string' || body.baseSha === '') {
    return errorResponse(400, 'baseSha is required');
  }

  const detail = ctx.orchestrator.getRun(runId);
  if (detail === null) return errorResponse(404, `run not found: ${runId}`);
  const meta = detail.meta;
  if (!existsSync(meta.worktreePath))
    return errorResponse(409, 'worktree-missing');

  // A resumed run shares this exact directory (see orchestrator requestChanges),
  // so "is anything live here" is a real race, not a hypothetical one.
  const busy = ctx.orchestrator
    .list()
    .some(
      (r) =>
        r.worktreePath === meta.worktreePath &&
        !TERMINAL_RUN_STATES.has(r.state)
    );
  if (busy) return errorResponse(409, 'worktree-busy');

  const repo = new GitRepo(meta.worktreePath);
  const onDisk = join(meta.worktreePath, body.file);
  const current = existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : '';
  if (sha256Hex(current) !== body.baseSha)
    return errorResponse(409, 'stale-base');
  if (body.contents === '' && current !== '') {
    return errorResponse(409, 'empty-contents');
  }

  // Staging first: `git add` rejects a path outside the repo, so a traversal
  // fails before anything is written.
  writeFileSync(onDisk, body.contents);
  const staged = await repo.stage([body.file]);
  if (!staged.ok) {
    writeFileSync(onDisk, current);
    return errorResponse(
      staged.stderr === PATH_ESCAPE_ERROR ? 400 : 500,
      staged.stderr
    );
  }
  const committed = await repo.commit({
    message: `review: edit ${body.file}\n\n${REVIEWER_EDIT_TRAILER}: ${runId}`,
  });
  if (!committed.ok) return errorResponse(500, committed.stderr);

  ctx.events.broadcast({ type: 'review.changed', runId });
  return jsonResponse({ commit: committed.sha });
}
```

The path-escape test expects a 400 before any write. Reuse Task 2's shared guard
— do not write a second copy of the check — immediately after the body
validation, so a traversal never reaches `writeFileSync`:

```ts
if (!isWorktreeRelativePath(body.file)) {
  return errorResponse(400, PATH_ESCAPE_ERROR);
}
```

Import `writeFileSync` and `TERMINAL_RUN_STATES` (from
`./orchestrator/types.js`) and `PATH_ESCAPE_ERROR` (from `./git/commands.js`).

Route, beside the `file` route:

```ts
if (segments.length === 3 && segments[2] === 'edits' && method === 'POST') {
  return await applyRunEdit(req, ctx, segments[1]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/run-file-edits.test.ts` Expected:
PASS, 10 tests.

- [ ] **Step 5: Add the client binding**

Interface:

```ts
  /** Writes a reviewer's edit into the run's worktree and commits it on the run branch. */
  applyRunEdit(
    runId: string,
    input: { file: string; contents: string; baseSha: string }
  ): Promise<{ commit: string }>;
```

Implementation:

```ts
    applyRunEdit: (runId, input) =>
      request(target, `/api/runs/${encodeURIComponent(runId)}/edits`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
```

- [ ] **Step 6: Verify and commit**

```bash
bun run format && bun run lint
git add packages/server packages/client
git commit -m "feat(server): commit a reviewer's edit onto the run branch"
```

---

### Task 4: `suggestion` on a review comment

Pure data plus the send-back rendering. No UI.

**Files:**

- Modify: `packages/server/src/reviewComments.ts`
- Modify: `packages/client/src/api.ts` (`ReviewComment`, ~line 823;
  `addReviewComment` input, ~line 1390)
- Modify: `packages/server/src/api.ts` (`addReviewComment` handler, ~line 899)
- Test: `packages/server/test/reviewComments.test.ts`

**Interfaces:**

- Produces:
  - `ReviewComment.suggestion?: string` on both server and client types
  - `AddCommentInput.suggestion?: string`
  - `formatCommentsForAgent` renders a ` ```suggestion ` fence

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/reviewComments.test.ts`:

````ts
describe('suggestions', () => {
  it('round-trips a suggestion through the store', () => {
    const store = new ReviewCommentStore(root, 'tester');
    const added = store.add('r-1', {
      file: 'a.ts',
      line: 3,
      anchorText: 'const a = 1;',
      body: 'typo',
      suggestion: 'const a = 2;',
      pending: false,
    });

    expect(added.suggestion).toBe('const a = 2;');
    expect(store.list('r-1')[0]?.suggestion).toBe('const a = 2;');
  });

  it('renders a suggestion as a fenced block for the agent', () => {
    const text = formatCommentsForAgent([
      {
        id: 'c-1',
        file: 'a.ts',
        line: 3,
        pending: false,
        anchorText: 'const a = 1;',
        author: 'tester',
        body: 'typo',
        suggestion: 'const a = 2;',
        resolved: false,
        created: '2026-08-04T00:00:00.000Z',
        replies: [],
      },
    ]);

    expect(text).toContain('```suggestion');
    expect(text).toContain('const a = 2;');
  });

  it('leaves a comment without a suggestion unchanged', () => {
    const text = formatCommentsForAgent([
      {
        id: 'c-1',
        file: 'a.ts',
        line: 3,
        pending: false,
        anchorText: 'const a = 1;',
        author: 'tester',
        body: 'typo',
        resolved: false,
        created: '2026-08-04T00:00:00.000Z',
        replies: [],
      },
    ]);

    expect(text).not.toContain('```suggestion');
  });
});
````

- [ ] **Step 2: Run test to verify it fails**

Run:
`cd packages/server && bun test test/reviewComments.test.ts -t "suggestion"`
Expected: FAIL — `suggestion` is not a known property.

- [ ] **Step 3: Write minimal implementation**

In `packages/server/src/reviewComments.ts`, on `ReviewComment` (after `body`):

```ts
  /**
   * Replacement text for lines `startLine..line`, when the reviewer wrote one.
   * Absent on a plain prose comment.
   */
  suggestion?: string;
```

Add the same optional field to `AddCommentInput`, and carry it through `add()`
the way `startLine` is carried.

In `formatCommentsForAgent`, after the line that pushes the comment body, add:

````ts
if (c.suggestion !== undefined && c.suggestion !== '') {
  lines.push('', 'Apply this exactly:', '```suggestion', c.suggestion, '```');
}
````

And extend the preamble string to end with:
``' A fenced `suggestion` block is the exact replacement text for the lines named above — apply it verbatim.'``

Mirror `suggestion?: string` onto `ReviewComment` in
`packages/client/src/api.ts` and onto `addReviewComment`'s input, and accept it
in `api.ts`'s `addReviewComment` handler:

```ts
    suggestion:
      typeof body.suggestion === 'string' && body.suggestion !== ''
        ? body.suggestion
        : undefined,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/reviewComments.test.ts` Expected:
PASS, including the three new tests.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run lint
git add packages/server packages/client
git commit -m "feat(review): carry a suggestion on a review comment"
```

---

### Task 5: Apply a suggestion

Splices a suggestion into the file and reuses Task 3's write path — but only
when the comment's anchor is still exact.

**Files:**

- Modify: `packages/server/src/reviewComments.ts` (add `spliceSuggestion`)
- Modify: `packages/server/src/api.ts` (handler + route)
- Modify: `packages/client/src/api.ts`
- Test: `packages/server/test/reviewComments.test.ts`,
  `packages/server/test/run-file-edits.test.ts`

**Interfaces:**

- Consumes: `resolveAnchor` (existing), the write path from Task 3.
- Produces:
  - `spliceSuggestion(fileLines: string[], comment: Pick<ReviewComment, 'line' | 'startLine'>, suggestion: string): string[]`
  - Route `POST /api/runs/:id/comments/:commentId/apply` → `{ commit: string }`
  - Client
    `applySuggestion(runId: string, commentId: string): Promise<{ commit: string }>`

- [ ] **Step 1: Write the failing test**

```ts
describe('spliceSuggestion', () => {
  it('replaces a single line', () => {
    const out = spliceSuggestion(['a', 'b', 'c'], { line: 2 }, 'B');
    expect(out).toEqual(['a', 'B', 'c']);
  });

  it('replaces a range with however many lines the suggestion has', () => {
    const out = spliceSuggestion(
      ['a', 'b', 'c', 'd'],
      { line: 3, startLine: 2 },
      'X\nY\nZ'
    );
    expect(out).toEqual(['a', 'X', 'Y', 'Z', 'd']);
  });
});
```

And in `run-file-edits.test.ts`:

```ts
describe('POST /api/runs/:id/comments/:id/apply', () => {
  it('commits the suggestion when the anchor is exact', async () => {
    const comment = await addComment({
      file: 'a.txt',
      line: 1,
      anchorText: 'changed',
      suggestion: 'fixed',
    });

    const res = await apiFetch(
      `/api/runs/${runId}/comments/${comment.id}/apply`,
      { method: 'POST' }
    );

    expect(res.status).toBe(200);
    expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('fixed\n');
  });

  it('409s when the anchor has drifted', async () => {
    const comment = await addComment({
      file: 'a.txt',
      line: 1,
      anchorText: 'something else',
      suggestion: 'fixed',
    });

    const res = await apiFetch(
      `/api/runs/${runId}/comments/${comment.id}/apply`,
      { method: 'POST' }
    );

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'anchor-drifted',
    });
  });

  it('400s for a comment with no suggestion', async () => {
    const comment = await addComment({
      file: 'a.txt',
      line: 1,
      anchorText: 'changed',
    });

    const res = await apiFetch(
      `/api/runs/${runId}/comments/${comment.id}/apply`,
      { method: 'POST' }
    );

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`cd packages/server && bun test test/reviewComments.test.ts -t "spliceSuggestion"`
Expected: FAIL — not exported.

- [ ] **Step 3: Write minimal implementation**

In `reviewComments.ts`:

```ts
/**
 * Replaces `startLine..line` (1-based, inclusive) with the suggestion's lines.
 * A suggestion may be a different length than what it replaces, which is why
 * this splices rather than assigning line by line.
 */
export function spliceSuggestion(
  fileLines: string[],
  comment: Pick<ReviewComment, 'line' | 'startLine'>,
  suggestion: string
): string[] {
  const start = (comment.startLine ?? comment.line) - 1;
  const count = comment.line - start;
  const next = [...fileLines];
  next.splice(start, count, ...suggestion.split('\n'));
  return next;
}
```

In `api.ts`, a handler that reads the file, calls `resolveAnchor`, returns
`409 anchor-drifted` unless the state is `exact`, splices, and then runs the
same write-stage-commit sequence as `applyRunEdit` with the message
`review: apply suggestion on <file>` plus the trailer. Extract that sequence
from Task 3 into a shared local function
`writeAndCommit(meta, file, contents, subject, runId)` and have both handlers
call it — do not duplicate the git steps.

Route:

```ts
if (
  segments.length === 5 &&
  segments[2] === 'comments' &&
  segments[4] === 'apply' &&
  method === 'POST'
) {
  return await applySuggestion(req, ctx, segments[1], segments[3]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`cd packages/server && bun test test/reviewComments.test.ts test/run-file-edits.test.ts`
Expected: PASS.

- [ ] **Step 5: Client binding and commit**

```ts
  /** Commits a comment's suggestion. Fails if the comment's anchor line has drifted. */
  applySuggestion(runId: string, commentId: string): Promise<{ commit: string }>;
```

```bash
bun run format && bun run lint
git add packages/server packages/client
git commit -m "feat(review): apply a comment's suggestion as a reviewer commit"
```

---

### Task 6: The editor factory and the contents loader

Frontend, no edit mode yet. This task alone fixes hunk expansion, which is
independently observable.

**Files:**

- Create: `apps/desktop/src/lib/pierreEditor.ts`
- Create: `apps/desktop/src/hooks/useRunFileContents.ts`
- Modify: `apps/desktop/src/components/runs/PierreReviewDiff.tsx`

**Interfaces:**

- Consumes: `fetchRunFile` from Task 2.
- Produces:
  - `createReviewEditor<T>(options: EditorOptions<T>): DiffsEditor<T>`
  - `useRunFileLoader(runId: string | undefined): { loadDiffFiles: FileDiffContentsLoader; ensureLoaded(file: string): Promise<{ contents: string; sha: string } | null> }`

- [ ] **Step 1: Write `pierreEditor.ts`**

```ts
import type { DiffsEditor } from '@pierre/diffs';
import type { EditorOptions } from '@pierre/diffs/edit';
import { Editor } from '@pierre/diffs/edit';

/**
 * The single place Pierre editor options are decided, so every editable surface
 * behaves the same. `persistState` keeps each file's caret and undo stack while
 * the reviewer moves between files, which needs a stable `cacheKey` per file —
 * the item builder uses the file path.
 */
export function createReviewEditor<T>(
  options: EditorOptions<T>
): DiffsEditor<T> {
  return new Editor<T>({
    ...options,
    persistState: true,
    matchBrackets: true,
    roundedSelection: true,
  });
}
```

- [ ] **Step 2: Write `useRunFileContents.ts`**

A hook holding a `Map<string, { contents: string; sha: string }>` per side, an
`ensureLoaded(file)` that fetches both sides and caches them, and a
`loadDiffFiles` matching Pierre's `FileDiffContentsLoader` signature —
`(fileDiff) => Promise<{ oldFile, newFile }>` — returning
`{ name: fileDiff.name, contents }` for each side. A side that 404s (added or
deleted file) resolves to `null` for that side, which is what Pierre's
`FileDiffLoadedFiles` expects.

- [ ] **Step 3: Wire the loader into `PierreReviewDiff`**

Pass `loadDiffFiles` through the existing `options` memo (line 91), which
already merges `toDiffRenderOptions(diffDisplay)`. Take a new optional `runId`
prop and thread it from `RunReviewView`.

- [ ] **Step 4: Verify expansion works**

Run the desktop app against a project with a terminal run and open its review.
Expand an unchanged region. Before this task there were no expand controls at
all; now they appear and reach the rest of the file. This is the observable
proof the loader is wired.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run lint && bun run ws desktop tsc
git add apps/desktop/src
git commit -m "feat(desktop): supply Pierre's contents loader so diffs can expand"
```

---

### Task 7: Edit mode and Apply

**Files:**

- Modify: `apps/desktop/src/components/runs/PierreReviewDiff.tsx`
- Test: `apps/desktop/src/components/runs/PierreReviewDiff.test.tsx` (create)

**Interfaces:**

- Consumes: `createReviewEditor`, `useRunFileLoader`, `applyRunEdit`.

- [ ] **Step 1: Write the failing test — the load gate**

This is the most important test in the plan: the spike proved an editor attached
to an unloaded item holds an _empty document_, so setting `edit` before contents
resolve would let a save erase the file.

```tsx
it('does not put a file into edit mode before its contents load', () => {
  const items = buildItems({
    files: [fileDiff('a.ts')],
    editing: 'a.ts',
    loaded: new Set(), // nothing resolved yet
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
```

Extract the item construction from the component into an exported pure
`buildItems(...)` so it is testable without a DOM. Keep the component calling it
from its existing `useMemo`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && bun test src/components/runs/PierreReviewDiff.test.tsx`
Expected: FAIL — `buildItems` is not exported.

- [ ] **Step 3: Implement**

- Extract `buildItems` and give it `editing` and `loaded` parameters;
  `edit: editing === id && loaded.has(id)`.
- Wrap `CodeView` in `<EditProvider createEditor={createReviewEditor}>`.
- Add a pencil via `renderHeaderMetadata(item)`. Clicking it calls
  `ensureLoaded(item.id)` first, sets a pending state, and only sets `editing`
  once contents resolve. On failure it clears the pending state and shows
  "Couldn't load this file."
- While `editing === item.id`, `renderGutterUtility` returns `null` for that
  item.
- `onItemEditComplete` posts `applyRunEdit({ file, contents, baseSha })` using
  the cached sha, then invalidates the run-diff query and clears `editing`.
- Map each 409 `error` to its sentence from the spec's error table.

- [ ] **Step 4: Run tests**

Run: `cd apps/desktop && bun test src/components/runs/` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run lint && bun run ws desktop tsc
git add apps/desktop/src
git commit -m "feat(desktop): edit a run's diff and commit the fix"
```

---

### Task 8: The suggestion composer

**Files:**

- Create: `apps/desktop/src/lib/suggestionRange.ts` + test
- Modify: `apps/desktop/src/components/runs/ReviewThread.tsx`

**Interfaces:**

- Produces:
  `seedFromRange(contents: string, startLine: number, endLine: number): string`

- [ ] **Step 1: Write the failing test**

```ts
it('seeds a single line', () => {
  expect(seedFromRange('a\nb\nc\n', 2, 2)).toBe('b');
});

it('seeds an inclusive range', () => {
  expect(seedFromRange('a\nb\nc\nd\n', 2, 3)).toBe('b\nc');
});

it('clamps a range that runs past the end of the file', () => {
  expect(seedFromRange('a\nb\n', 2, 9)).toBe('b');
});
```

- [ ] **Step 2: Run it, watch it fail, implement, run it again**

Run: `cd apps/desktop && bun test src/lib/suggestionRange.test.ts`

```ts
/** The text a suggestion editor starts from: lines `startLine..endLine`, inclusive
 *  and 1-based, clamped to the file so a stale range cannot read past the end. */
export function seedFromRange(
  contents: string,
  startLine: number,
  endLine: number
): string {
  const lines = contents.replace(/\n$/, '').split('\n');
  return lines
    .slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine))
    .join('\n');
}
```

- [ ] **Step 3: Add the editor to the composer**

In `ReviewComposer`, beneath the existing textarea, render a nested `CodeView`
holding a single `CodeViewFileItem` with `edit: true`,
`file: { name: <the diff file's name>, contents: seedFromRange(...), cacheKey: <file>:<start>-<end> }`.
Naming the item after the real file is what gets Shiki to highlight it as that
language.

Submit with `suggestion` set only when the edited text differs from the seed.
Add an `Apply now` action that saves the comment and then calls
`applySuggestion`.

- [ ] **Step 4: Add the thread action**

In `ReviewThread`, when `comment.suggestion` is present, render an `Apply`
button that calls `applySuggestion`. On `409 anchor-drifted`, disable it and
show the reason.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run lint && bun run ws desktop tsc
git add apps/desktop/src
git commit -m "feat(desktop): write suggestions in a real code editor"
```

---

### Task 9: End-to-end and final verification

**Files:**

- Modify: `apps/desktop/e2e/` — one new spec

- [ ] **Step 1: Write the e2e spec**

One path only: open a terminal run's review, click the pencil, wait for edit
mode, type, save, assert the diff re-renders with the new text. Follow the
existing specs in `apps/desktop/e2e/` for the fixture and auth harness. The
storefront fixture is gitignored and keyed by `sha256(rootDir)`, so a fresh
worktree regenerates it — that is expected. Do not regenerate PNG baselines
locally.

- [ ] **Step 2: Run the full verification baseline**

```bash
export AGENT=1
bun run format
bun run lint            # expect 0 errors; baseline is 159 warnings
bun run tsc             # expect all 7 packages clean
bun run ws server test  # ~390s — pass an explicit timeout
bun run ws client test
bun run ws desktop test
```

- [ ] **Step 3: Delete the spike**

```bash
rm -rf .agents/ignore/pierre-edit-spike
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e
git commit -m "test(desktop): cover editing a run's diff end to end"
```

---

## Self-Review Notes

- **Spec coverage.** Layer 1 → Tasks 1–3, 5. Layer 2 → Task 6, 7. Layer 3 →
  Tasks 7, 8. Data model → Task 4. Error table → Task 3 (server strings) and
  Task 7 (the sentences). Testing section → each task's own tests plus Task 9.
- **The load gate is the highest-value test in the plan** (Task 7, Step 1). It
  encodes the one thing the spike found that the design would otherwise have got
  wrong.
- **Shared write path.** Task 5 extracts `writeAndCommit` from Task 3 rather
  than duplicating the git sequence. If Task 5 is implemented first for any
  reason, that extraction still belongs with whichever lands second.
- **Not covered here, on purpose:** conflict resolution, working-tree editing on
  the Git page, and auto-applying suggestions on send-back. All are out of scope
  per the spec's closing section.
