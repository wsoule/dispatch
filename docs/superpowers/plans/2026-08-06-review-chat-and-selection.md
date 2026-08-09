# Selection Actions and Review Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select code in any diff, attach it to a message, and hold a
conversation about it with either the agent that wrote it or a read-only side
agent — with all of it reusable outside the review surface.

**Architecture:** Three modules with hard boundaries — a diff-agnostic selection
overlay, a target-agnostic snippet composer, and a conversation store keyed by
subject rather than by run — plus a thin wiring layer per surface. The three
diff renderers consolidate onto one `DiffSurface` built on `CodeView` so the
gesture lands once instead of three times.

**Tech Stack:** Bun, TypeScript, React 19, `@pierre/diffs@1.3.1`, Tauri.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-06-review-chat-and-selection-design.md`.
  Read it before Task 1.
- `export AGENT=1` at the start of every session.
- `bun` only. Never `npm`/`pnpm`/`npx`.
- Package scripts take the **directory** name: `bun run ws server test`,
  `bun run ws desktop tsc`.
- **`bun run lint` must report 0 warnings AND 0 errors.**
- **`bun run lint:deadcode` (knip) must pass.** Suppressions are forbidden in
  this project — no ignore comments, no config exclusions. Fix by not exporting.
- Never add a dependency version to a package `package.json`; the root
  `workspaces.catalog` owns versions. Do not bump `@pierre/diffs` —
  `bunfig.toml` enforces a 7-day `minimumReleaseAge`.
- Preserve trailing newlines. Comments 1–2 lines, explain WHY, terse.
- `packages/server` tests take ~350s — run only the file you touched while
  iterating, with an explicit timeout.
- **Modules 1–3 must not import `PierreReviewDiff` or anything that reaches
  `PierreWorkerPool`.** That pulls the Vite-only
  `@pierre/diffs/worker/worker.js?worker&url` specifier, which `bun test` cannot
  resolve, making the module unrenderable in tests. This is a design
  requirement, not a preference.

## Deviation from the spec, decided here

The spec proposed `GET /api/conversations/:subject`. A `SubjectRef` contains `:`
and, for `worktree:` subjects, `/` — which cannot live in a single path segment
without double-encoding that every client would have to get right. **Subject
travels as a query parameter on GET and in the body on POST**, matching how
`readRunFile` already takes `?path=`. Everything else in the spec is unchanged.

## File Structure

**Created — server**

- `packages/server/src/conversations.ts` — `ConversationStore`, `SubjectRef`,
  `ChatMessage`, `isSubjectRef`. Mirrors `reviewComments.ts`.
- `packages/server/test/conversations.test.ts`
- `packages/server/test/conversations-api.test.ts`

**Created — desktop**

- `apps/desktop/src/components/chat/SnippetComposer.tsx` — chips, input, target
  picker. No fetching, no persistence.
- `apps/desktop/src/components/chat/SnippetComposer.test.tsx`
- `apps/desktop/src/components/code/SelectionActions.tsx` — floating action bar.
  Actions supplied as data.
- `apps/desktop/src/components/code/SelectionActions.test.tsx`
- `apps/desktop/src/components/code/useShadowSelectionRect.ts` — the only piece
  that knows Pierre renders into shadow DOM.
- `apps/desktop/src/lib/conversation.ts` — pure helpers (`subjectForRun`,
  `snippetLabel`). Testable without a DOM.
- `apps/desktop/src/lib/conversation.test.ts`
- `apps/desktop/src/components/runs/ReviewChatPanel.tsx` — the thin wiring:
  composes the three modules, supplies run-specific targets and subject.
- `apps/desktop/src/components/code/DiffSurface.tsx` — the shared renderer the
  three surfaces collapse into.

**Modified**

- `packages/server/src/orchestrator/paths.ts` — add `conversationPath`.
- `packages/server/src/api.ts` — three routes.
- `packages/client/src/api.ts` — types and bindings.
- `apps/desktop/src/components/runs/RunDiffView.tsx`,
  `apps/desktop/src/components/git/GitDiffPane.tsx` — become thin callers of
  `DiffSurface`.
- `apps/desktop/src/components/runs/PierreReviewDiff.tsx` — adopts
  `DiffSurface`, keeps its review-specific annotations and edit wiring.

---

### Task 1: `ConversationStore`

**Files:**

- Create: `packages/server/src/conversations.ts`
- Modify: `packages/server/src/orchestrator/paths.ts`
- Test: `packages/server/test/conversations.test.ts`

**Interfaces:**

- Produces:
  - `type SubjectRef = \`run:${string}\` | \`worktree:${string}\` |
    \`pr:${string}\``
  - `isSubjectRef(value: unknown): value is SubjectRef`
  - `interface Snippet { file: string; startLine: number; endLine: number; text: string }`
  - `interface ChatMessage { id: string; role: 'human' | 'agent'; body: string; snippets: Snippet[]; target?: string; created: string }`
  - `class ConversationStore { constructor(rootDir: string); list(subject: SubjectRef): ChatMessage[]; add(subject: SubjectRef, input: AddMessageInput, now?: string): ChatMessage; remove(subject: SubjectRef, messageId: string): void }`
  - `conversationPath(rootDir: string, subject: SubjectRef): string`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore, isSubjectRef } from '../src/conversations';

let fakeHome: string;
const original = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});
afterEach(() => {
  if (original === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = original;
  rmSync(fakeHome, { recursive: true, force: true });
});

function root(): string {
  return mkdtempSync(join(tmpdir(), 'dispatch-conv-'));
}

describe('isSubjectRef', () => {
  test('accepts the three subject kinds', () => {
    expect(isSubjectRef('run:r-abc123')).toBe(true);
    expect(isSubjectRef('worktree:/Users/x/proj')).toBe(true);
    expect(isSubjectRef('pr:42')).toBe(true);
  });

  test('rejects anything else, including a bare id', () => {
    expect(isSubjectRef('r-abc123')).toBe(false);
    expect(isSubjectRef('session:1')).toBe(false);
    expect(isSubjectRef('run:')).toBe(false);
    expect(isSubjectRef(42)).toBe(false);
  });
});

describe('ConversationStore', () => {
  test('adds and reads back across instances', () => {
    const dir = root();
    new ConversationStore(dir).add('run:r-1', {
      role: 'human',
      body: 'why this?',
      snippets: [
        { file: 'a.ts', startLine: 2, endLine: 3, text: 'const a = 1;' },
      ],
      target: 'run-agent',
    });
    const all = new ConversationStore(dir).list('run:r-1');
    expect(all).toHaveLength(1);
    expect(all[0]?.body).toBe('why this?');
    expect(all[0]?.snippets[0]?.file).toBe('a.ts');
  });

  // The whole reason subjects exist rather than run ids: the Git page and a PR have no run,
  // and their conversations must not bleed into each other.
  test('subjects are isolated from one another', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    store.add('run:r-1', { role: 'human', body: 'run one', snippets: [] });
    expect(store.list('worktree:/tmp/p')).toEqual([]);
    expect(store.list('pr:42')).toEqual([]);
    expect(store.list('run:r-2')).toEqual([]);
  });

  // A worktree subject contains slashes; the filename must not try to be a path.
  test('a worktree subject with slashes round-trips', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    store.add('worktree:/Users/x/deep/nested', {
      role: 'human',
      body: 'hi',
      snippets: [],
    });
    expect(store.list('worktree:/Users/x/deep/nested')).toHaveLength(1);
  });

  test('remove drops just that message', () => {
    const dir = root();
    const store = new ConversationStore(dir);
    const a = store.add('run:r-1', { role: 'human', body: 'a', snippets: [] });
    store.add('run:r-1', { role: 'human', body: 'b', snippets: [] });
    store.remove('run:r-1', a.id);
    expect(store.list('run:r-1').map((m) => m.body)).toEqual(['b']);
  });

  test('a subject with no conversation reads as empty, not an error', () => {
    expect(new ConversationStore(root()).list('run:r-never')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/conversations.test.ts` Expected: FAIL
— cannot resolve `../src/conversations`.

- [ ] **Step 3: Add the path helper**

In `packages/server/src/orchestrator/paths.ts`, after `reviewCommentsPath`:

```ts
// Where a conversation lives, keyed by subject rather than by run: the Git page and a GitHub PR
// have no run to key on. The subject is hashed because it contains `:` and, for a worktree, `/`
// — neither of which belongs in a filename.
export function conversationPath(rootDir: string, subject: string): string {
  const key = createHash('sha256')
    .update(subject, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return join(runsDir(rootDir), `${key}.conversation.json`);
}
```

Add `import { createHash } from 'node:crypto';` at the top if absent.

- [ ] **Step 4: Write `conversations.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { conversationPath } from './orchestrator/paths.js';

/** What a conversation is attached to. Not every surface has a run. */
export type SubjectRef =
  | `run:${string}`
  | `worktree:${string}`
  | `pr:${string}`;

const SUBJECT_PREFIXES = ['run:', 'worktree:', 'pr:'] as const;

export function isSubjectRef(value: unknown): value is SubjectRef {
  if (typeof value !== 'string') return false;
  return SUBJECT_PREFIXES.some(
    (prefix) => value.startsWith(prefix) && value.length > prefix.length
  );
}

export interface Snippet {
  file: string;
  startLine: number;
  endLine: number;
  /** The code as it read when attached, so the message survives the branch moving. */
  text: string;
}

export interface ChatMessage {
  id: string;
  role: 'human' | 'agent';
  body: string;
  snippets: Snippet[];
  /** Which target a human message was sent to; absent on an agent reply. */
  target?: string;
  created: string;
}

export interface AddMessageInput {
  role: 'human' | 'agent';
  body: string;
  snippets: Snippet[];
  target?: string;
}

/**
 * A working conversation about code, stored per subject.
 *
 * Deliberately separate from ReviewCommentStore: comments are the review record — batched until
 * submit and carried to the agent by formatCommentsForAgent — while this is immediate and never
 * reaches a send-back on its own. Collapsing them would cost reviews their batched-until-submit
 * property.
 */
export class ConversationStore {
  constructor(private readonly rootDir: string) {}

  private file(subject: SubjectRef): string {
    return conversationPath(this.rootDir, subject);
  }

  list(subject: SubjectRef): ChatMessage[] {
    const path = this.file(subject);
    if (!existsSync(path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
    } catch {
      // A corrupt file degrades to "no conversation" rather than taking the daemon down, the
      // same way every other per-run artifact here behaves.
      return [];
    }
  }

  private write(subject: SubjectRef, messages: ChatMessage[]): void {
    const path = this.file(subject);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`);
  }

  add(
    subject: SubjectRef,
    input: AddMessageInput,
    now = new Date().toISOString()
  ): ChatMessage {
    const message: ChatMessage = {
      id: `cm-${randomBytes(3).toString('hex')}`,
      role: input.role,
      body: input.body,
      snippets: input.snippets,
      ...(input.target !== undefined ? { target: input.target } : {}),
      created: now,
    };
    const all = this.list(subject);
    all.push(message);
    this.write(subject, all);
    return message;
  }

  remove(subject: SubjectRef, messageId: string): void {
    this.write(
      subject,
      this.list(subject).filter((m) => m.id !== messageId)
    );
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/server && bun test test/conversations.test.ts` Expected: PASS,
8 tests.

- [ ] **Step 6: Commit**

```bash
bun run format && bun run lint && bun run lint:deadcode
git add packages/server/src/conversations.ts packages/server/src/orchestrator/paths.ts packages/server/test/conversations.test.ts
git commit -m "feat(server): store conversations keyed by subject, not by run"
```

---

### Task 2: Conversation routes and client bindings

**Files:**

- Modify: `packages/server/src/api.ts`
- Modify: `packages/client/src/api.ts`
- Test: `packages/server/test/conversations-api.test.ts`

**Interfaces:**

- Consumes: `ConversationStore`, `isSubjectRef`, `SubjectRef`, `ChatMessage`,
  `Snippet` from Task 1.
- Produces:
  - `GET /api/conversations?subject=…` → `ChatMessage[]`
  - `POST /api/conversations` body `{ subject, role, body, snippets, target? }`
    → `ChatMessage` (201)
  - `DELETE /api/conversations/:messageId?subject=…` → 204
  - Client `fetchConversation(subject: string): Promise<ChatMessage[]>`
  - Client
    `addChatMessage(input: { subject: string; role: 'human' | 'agent'; body: string; snippets: Snippet[]; target?: string }): Promise<ChatMessage>`
  - `ctx.conversations: ConversationStore` on `ApiContext`

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/conversations-api.test.ts`, copying the server
bootstrap from the top of `packages/server/test/git-api.test.ts` (`startServer`,
`useTestAuth`, a fake `DISPATCH_HOME`, a local `apiFetch` helper), then:

```ts
describe('conversation routes', () => {
  it('round-trips a message for a run subject', async () => {
    const post = await apiFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        subject: 'run:r-1',
        role: 'human',
        body: 'why this?',
        snippets: [
          { file: 'a.ts', startLine: 1, endLine: 2, text: 'const a = 1;' },
        ],
        target: 'run-agent',
      }),
    });
    expect(post.status).toBe(201);

    const res = await apiFetch('/api/conversations?subject=run%3Ar-1');
    const all = (await res.json()) as { body: string }[];
    expect(all).toHaveLength(1);
    expect(all[0]?.body).toBe('why this?');
  });

  it('keeps a worktree subject separate from a run subject', async () => {
    await apiFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        subject: 'run:r-1',
        role: 'human',
        body: 'run',
        snippets: [],
      }),
    });
    const res = await apiFetch(
      `/api/conversations?subject=${encodeURIComponent('worktree:/tmp/p')}`
    );
    expect((await res.json()) as unknown[]).toEqual([]);
  });

  it('400s an unrecognised subject rather than inventing a namespace', async () => {
    const res = await apiFetch('/api/conversations?subject=session%3A1');
    expect(res.status).toBe(400);
  });

  it('400s a POST with no subject', async () => {
    const res = await apiFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ role: 'human', body: 'x', snippets: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('deletes one message and leaves the rest', async () => {
    const a = await (
      await apiFetch('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({
          subject: 'run:r-1',
          role: 'human',
          body: 'a',
          snippets: [],
        }),
      })
    ).json();
    await apiFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        subject: 'run:r-1',
        role: 'human',
        body: 'b',
        snippets: [],
      }),
    });

    const del = await apiFetch(
      `/api/conversations/${(a as { id: string }).id}?subject=run%3Ar-1`,
      { method: 'DELETE' }
    );
    expect(del.status).toBe(204);

    const rest = (await (
      await apiFetch('/api/conversations?subject=run%3Ar-1')
    ).json()) as {
      body: string;
    }[];
    expect(rest.map((m) => m.body)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/conversations-api.test.ts` Expected:
FAIL — the router 404s.

- [ ] **Step 3: Implement the handlers**

In `packages/server/src/api.ts`, add `conversations: ConversationStore` to
`ApiContext`, construct it in `packages/server/src/index.ts` next to
`reviewComments`, and add:

```ts
// GET /api/conversations?subject=… — every message on that subject.
function listConversation(req: Request, ctx: ApiContext): Response {
  const subject = new URL(req.url).searchParams.get('subject');
  if (!isSubjectRef(subject)) {
    return errorResponse(400, 'subject must be run:…, worktree:… or pr:…');
  }
  return jsonResponse(ctx.conversations.list(subject));
}

/**
 * POST /api/conversations — append a message.
 *
 * The subject travels in the body rather than the path because a worktree subject contains
 * slashes, which no single path segment can carry without double-encoding.
 */
async function addChatMessage(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    subject?: unknown;
    role?: unknown;
    body?: unknown;
    snippets?: unknown;
    target?: unknown;
  };
  if (!isSubjectRef(body.subject)) {
    return errorResponse(400, 'subject must be run:…, worktree:… or pr:…');
  }
  if (body.role !== 'human' && body.role !== 'agent') {
    return errorResponse(400, 'role must be human or agent');
  }
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return errorResponse(400, 'body is required');
  }
  const message = ctx.conversations.add(body.subject, {
    role: body.role,
    body: body.body.trim(),
    snippets: Array.isArray(body.snippets) ? (body.snippets as Snippet[]) : [],
    target: typeof body.target === 'string' ? body.target : undefined,
  });
  return jsonResponse(message, 201);
}

// DELETE /api/conversations/:messageId?subject=…
function deleteChatMessage(
  req: Request,
  ctx: ApiContext,
  messageId: string
): Response {
  const subject = new URL(req.url).searchParams.get('subject');
  if (!isSubjectRef(subject)) {
    return errorResponse(400, 'subject must be run:…, worktree:… or pr:…');
  }
  ctx.conversations.remove(subject, messageId);
  return new Response(null, { status: 204 });
}
```

Wire them in the router beside the existing `segments[0] === 'runs'` block:

```ts
if (segments[0] === 'conversations') {
  if (segments.length === 1 && method === 'GET') {
    return listConversation(req, ctx);
  }
  if (segments.length === 1 && method === 'POST') {
    return await addChatMessage(req, ctx);
  }
  if (segments.length === 2 && method === 'DELETE') {
    return deleteChatMessage(req, ctx, segments[1]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/conversations-api.test.ts` Expected:
PASS, 5 tests.

- [ ] **Step 5: Add client types and bindings**

In `packages/client/src/api.ts`, mirror `Snippet` and `ChatMessage`, then add to
the interface:

```ts
  /** Every message on a subject. `subject` is `run:…`, `worktree:…` or `pr:…`. */
  fetchConversation(subject: string): Promise<ChatMessage[]>;
  addChatMessage(input: {
    subject: string;
    role: 'human' | 'agent';
    body: string;
    snippets: Snippet[];
    target?: string;
  }): Promise<ChatMessage>;
```

And to the implementation object:

```ts
    fetchConversation: (subject) =>
      request(target, `/api/conversations?subject=${encodeURIComponent(subject)}`),
    addChatMessage: (input) =>
      request(target, '/api/conversations', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
```

- [ ] **Step 6: Commit**

```bash
bun run format && bun run lint && bun run lint:deadcode
bun run ws server tsc && bun run ws client tsc
git add packages/server packages/client
git commit -m "feat(server): serve conversations over subject-keyed routes"
```

---

### Task 3: `SnippetComposer`

The boundary test for this whole design: it must render with no server, no run,
and no Pierre.

**Files:**

- Create: `apps/desktop/src/components/chat/SnippetComposer.tsx`,
  `apps/desktop/src/lib/conversation.ts`
- Test: `apps/desktop/src/components/chat/SnippetComposer.test.tsx`,
  `apps/desktop/src/lib/conversation.test.ts`

**Interfaces:**

- Produces:
  - `snippetLabel(s: Snippet): string` — `"src/a.ts (2-4)"`, or `"src/a.ts (2)"`
    for a single line.
  - `subjectForRun(runId: string): string` — `` `run:${runId}` ``
  - `interface ChatTarget { id: string; label: string; canAct: boolean; hint?: string }`
  - `<SnippetComposer targets attachments onRemoveAttachment onSend />` per the
    spec.

- [ ] **Step 1: Write the failing pure-helper test**

`apps/desktop/src/lib/conversation.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { snippetLabel, subjectForRun } from './conversation';

describe('snippetLabel', () => {
  it('renders a range', () => {
    expect(
      snippetLabel({ file: 'src/a.ts', startLine: 2, endLine: 4, text: '' })
    ).toBe('src/a.ts (2-4)');
  });

  it('collapses a single line to one number', () => {
    expect(
      snippetLabel({ file: 'src/a.ts', startLine: 7, endLine: 7, text: '' })
    ).toBe('src/a.ts (7)');
  });
});

describe('subjectForRun', () => {
  it('namespaces a run id', () => {
    expect(subjectForRun('r-abc')).toBe('run:r-abc');
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `cd apps/desktop && bun test src/lib/conversation.test.ts` Expected: FAIL —
cannot resolve `./conversation`.

```ts
import type { Snippet } from '@dispatch/client';

/** How a snippet reads on its chip. A one-line range shows one number, not `7-7`. */
export function snippetLabel(snippet: Snippet): string {
  const range =
    snippet.startLine === snippet.endLine
      ? `${snippet.startLine}`
      : `${snippet.startLine}-${snippet.endLine}`;
  return `${snippet.file} (${range})`;
}

export function subjectForRun(runId: string): string {
  return `run:${runId}`;
}
```

- [ ] **Step 3: Write the failing component test**

`apps/desktop/src/components/chat/SnippetComposer.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';

import { SnippetComposer } from './SnippetComposer';

const TARGETS = [
  { id: 'run-agent', label: "This run's agent", canAct: true },
  { id: 'side', label: 'Side conversation', canAct: false },
];

const SNIPPET = {
  file: 'src/a.ts',
  startLine: 2,
  endLine: 4,
  text: 'const a = 1;',
};

describe('SnippetComposer', () => {
  it('renders a chip per attachment', () => {
    render(
      <SnippetComposer
        targets={TARGETS}
        attachments={[SNIPPET]}
        onRemoveAttachment={() => {}}
        onSend={async () => {}}
      />
    );
    expect(screen.getByText('src/a.ts (2-4)')).toBeTruthy();
  });

  it('removes the chip the reviewer dismissed, by index', () => {
    const onRemove = mock(() => {});
    render(
      <SnippetComposer
        targets={TARGETS}
        attachments={[SNIPPET, { ...SNIPPET, file: 'src/b.ts' }]}
        onRemoveAttachment={onRemove}
        onSend={async () => {}}
      />
    );
    fireEvent.click(screen.getByLabelText('Remove src/b.ts (2-4)'));
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it('sends the body, the attachments and the chosen target', async () => {
    const onSend = mock(async () => {});
    render(
      <SnippetComposer
        targets={TARGETS}
        attachments={[SNIPPET]}
        onRemoveAttachment={() => {}}
        onSend={onSend}
      />
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'why?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('why?', [SNIPPET], 'run-agent');
  });

  it('withholds send on an empty body, so an accidental click cannot post nothing', () => {
    render(
      <SnippetComposer
        targets={TARGETS}
        attachments={[]}
        onRemoveAttachment={() => {}}
        onSend={async () => {}}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')
    ).toBe(true);
  });

  // The only difference that matters when choosing a target is whether it can change the branch,
  // so it is stated rather than left for the reviewer to infer.
  it('says which target can act', () => {
    render(
      <SnippetComposer
        targets={TARGETS}
        attachments={[]}
        onRemoveAttachment={() => {}}
        onSend={async () => {}}
      />
    );
    expect(screen.getByText(/can edit this branch/i)).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run it, watch it fail, implement `SnippetComposer.tsx`**

Run: `cd apps/desktop && bun test src/components/chat/SnippetComposer.test.tsx`
Expected: FAIL — cannot resolve `./SnippetComposer`.

Implement a controlled component: chips from `attachments` (label via
`snippetLabel`, dismiss button labelled `Remove ${snippetLabel(s)}`), a
`Textarea` bound to local `body` state, a `<select>` of `targets` defaulting to
the first, and a Send button disabled while `body.trim() === ''` or a send is in
flight. Below the picker, render the selected target's capability — "can edit
this branch" when `canAct`, "read-only — explains, does not edit" otherwise.
Follow the styling of `apps/desktop/src/components/tasks/AiTaskComposer.tsx`.

**Do not import anything from `components/runs/`.** That reaches
`PierreWorkerPool` and makes this file unrenderable under `bun test`.

- [ ] **Step 5: Run tests, then commit**

Run:
`cd apps/desktop && bun test src/components/chat src/lib/conversation.test.ts`
Expected: PASS, 8 tests.

```bash
bun run format && bun run lint && bun run lint:deadcode && bun run ws desktop tsc
git add apps/desktop/src/components/chat apps/desktop/src/lib/conversation.ts apps/desktop/src/lib/conversation.test.ts
git commit -m "feat(desktop): add a target-agnostic snippet composer"
```

---

### Task 4: `SelectionActions` and `useShadowSelectionRect`

**Files:**

- Create: `apps/desktop/src/components/code/SelectionActions.tsx`,
  `apps/desktop/src/components/code/useShadowSelectionRect.ts`
- Test: `apps/desktop/src/components/code/SelectionActions.test.tsx`

**Interfaces:**

- Produces:
  - `interface CodeSelection { file: string; startLine: number; endLine: number; text: string }`
  - `interface SelectionAction { id: string; label: string; icon: ReactNode; onInvoke(selection: CodeSelection): void }`
  - `<SelectionActions containerRef selection actions />`
  - `useShadowSelectionRect(containerRef): DOMRect | null`

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';
import { createRef } from 'react';

import { SelectionActions } from './SelectionActions';

const SELECTION = {
  file: 'src/a.ts',
  startLine: 2,
  endLine: 4,
  text: 'const a = 1;',
};

describe('SelectionActions', () => {
  it('renders nothing when there is no selection', () => {
    const { container } = render(
      <SelectionActions
        containerRef={createRef<HTMLElement>()}
        selection={null}
        actions={[
          { id: 'chat', label: 'Add to chat', icon: null, onInvoke: () => {} },
        ]}
      />
    );
    expect(container.textContent).toBe('');
  });

  it('renders one control per action', () => {
    render(
      <SelectionActions
        containerRef={createRef<HTMLElement>()}
        selection={SELECTION}
        actions={[
          { id: 'chat', label: 'Add to chat', icon: null, onInvoke: () => {} },
          { id: 'copy', label: 'Copy', icon: null, onInvoke: () => {} },
        ]}
      />
    );
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('hands the live selection to the invoked action', () => {
    const onInvoke = mock(() => {});
    render(
      <SelectionActions
        containerRef={createRef<HTMLElement>()}
        selection={SELECTION}
        actions={[{ id: 'chat', label: 'Add to chat', icon: null, onInvoke }]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect(onInvoke).toHaveBeenCalledWith(SELECTION);
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `cd apps/desktop && bun test src/components/code/SelectionActions.test.tsx`
Expected: FAIL — cannot resolve `./SelectionActions`.

`SelectionActions.tsx` returns `null` when `selection === null`; otherwise
renders an absolutely positioned bar of buttons, each calling
`action.onInvoke(selection)`. Position comes from
`useShadowSelectionRect(containerRef)`; when that returns `null` (no measurable
rect, as under happy-dom) the bar still renders, just unpositioned — which is
what makes the component testable without a browser.

`useShadowSelectionRect.ts` reads `window.getSelection()`, and when the anchor
node sits inside a shadow root it walks up through `getRootNode()` host elements
to produce a viewport rect, then converts to the container's coordinate space.
Comment it as the one Pierre-aware piece.

- [ ] **Step 3: Run tests, then commit**

Run: `cd apps/desktop && bun test src/components/code/` Expected: PASS, 3 tests.

```bash
bun run format && bun run lint && bun run lint:deadcode && bun run ws desktop tsc
git add apps/desktop/src/components/code
git commit -m "feat(desktop): add a diff-agnostic selection action bar"
```

**Note for the reviewer:** `useShadowSelectionRect` cannot be unit tested —
shadow-DOM range geometry needs a real browser. It gets a browser pass in
Task 8. That limitation is why it is a separate hook rather than inlined.

---

### Task 5: `DiffSurface` — one renderer

**Files:**

- Create: `apps/desktop/src/components/code/DiffSurface.tsx`
- Modify: `apps/desktop/src/components/runs/RunDiffView.tsx`,
  `apps/desktop/src/components/git/GitDiffPane.tsx`
- Test: `apps/desktop/src/components/code/DiffSurface.test.tsx`

**Interfaces:**

- Produces:
  `<DiffSurface patch loading? only? emptyLabel? items? renderAnnotation? renderGutterUtility? renderHeaderMetadata? onSelectedLinesChange? options? />`
  — the shared shell around `CodeView`.

- [ ] **Step 1: Read both call sites and extract what they share**

`RunDiffView` and `GitDiffPane` both do: `splitPatchFiles` →
`useDiffDisplaySettings` → `toDiffRenderOptions` → `PierreWorkerPool` →
`ErrorBoundary` → render. `DiffSurface` owns all of that plus the loading,
parse-error and empty states, and renders a single `CodeView` rather than a
`FileDiff` stack.

- [ ] **Step 2: Write the failing test**

Test that `DiffSurface` renders the empty label for an empty patch, renders the
parse-error state for an unparseable one, and filters to `only` when given. Stub
`PierreWorkerPool` with `mock.module` the way `PierreReviewDiff.test.tsx`
already does.

- [ ] **Step 3: Implement, then convert both call sites**

`RunDiffView` and `GitDiffPane` become thin: they pass `patch`, `loading`,
`only` and their own empty label, and nothing else.

- [ ] **Step 4: Verify no regression**

Run: `bun run ws desktop test` Expected: PASS with no fewer tests than before.

**Watch for:** both surfaces move from a `FileDiff` stack to one virtualized
`CodeView`, which changes scroll and layout behaviour. That is the main risk in
this task and needs the browser pass in Task 8.

- [ ] **Step 5: Commit**

```bash
bun run format && bun run lint && bun run lint:deadcode && bun run ws desktop tsc
git add apps/desktop/src
git commit -m "refactor(desktop): render every diff through one CodeView surface"
```

---

### Task 6: `PierreReviewDiff` adopts `DiffSurface`

**Files:**

- Modify: `apps/desktop/src/components/runs/PierreReviewDiff.tsx`

- [ ] **Step 1: Replace its own shell with `DiffSurface`**

`PierreReviewDiff` keeps everything review-specific — `buildItems`, annotations,
the gutter utility, edit mode, the pencil gate — and hands the shell (worker
pool, error boundary, display settings, parse) to `DiffSurface`.

- [ ] **Step 2: Run the full desktop suite**

Run: `bun run ws desktop test` Expected: PASS, no regressions. This file has the
most tests on the branch; none should change.

- [ ] **Step 3: Commit**

```bash
bun run format && bun run lint && bun run lint:deadcode && bun run ws desktop tsc
git add apps/desktop/src/components/runs/PierreReviewDiff.tsx
git commit -m "refactor(desktop): review diff builds on the shared surface"
```

---

### Task 7: `ReviewChatPanel` — the wiring

**Files:**

- Create: `apps/desktop/src/components/runs/ReviewChatPanel.tsx`
- Modify: `apps/desktop/src/views/ReviewView.tsx`,
  `apps/desktop/src/hooks/useDispatchProject.ts`

**Interfaces:**

- Consumes: `SnippetComposer`, `SelectionActions`, `fetchConversation`,
  `addChatMessage`, `subjectForRun`.

- [ ] **Step 1: Compose the three modules**

`ReviewChatPanel` takes `{ client, runId, canResumeAgent }`, fetches the
conversation with React Query keyed on the subject, renders the message list
plus `SnippetComposer`, and supplies the two targets:

```ts
const targets: ChatTarget[] = [
  {
    id: 'run-agent',
    label: "This run's agent",
    canAct: true,
    hint: 'Resumes the session on this branch — it can edit the code.',
  },
  {
    id: 'side',
    label: 'Side conversation',
    canAct: false,
    hint: 'A fresh agent with the diff as context. It explains; it does not edit.',
  },
];
```

Pending attachments live here as `useState<Snippet[]>`; `SelectionActions`'s
**Add to chat** pushes onto it, and a successful send clears it.

- [ ] **Step 2: Dock it under the diff in `ReviewView`**

Collapsed to a single input row until used. Do not put it in the right rail —
that is the thread index.

- [ ] **Step 3: Wire the selection actions into `DiffSurface`'s consumers**

Add to chat, Copy, Comment. `Comment` reuses the existing composer path.

- [ ] **Step 4: Commit**

```bash
bun run format && bun run lint && bun run lint:deadcode && bun run ws desktop tsc && bun run ws desktop test
git add apps/desktop/src
git commit -m "feat(desktop): dock a review chat under the diff"
```

---

### Task 8: Verification

- [ ] **Step 1: Full baseline**

```bash
export AGENT=1
bun run format
bun run lint            # 0 warnings, 0 errors
bun run lint:deadcode   # knip clean
bun run tsc             # all packages
bun run ws server test  # ~350s, explicit timeout
bun run ws client test
bun run ws desktop test
```

- [ ] **Step 2: Browser pass — hand to a human**

Playwright cannot launch in an agent shell here, and `useShadowSelectionRect`
cannot be unit tested at all. A human must confirm, in the running app:

1. Selecting code in the review diff shows the action bar, positioned against
   the selection.
2. **Add to chat** produces a chip with the right file and line range.
3. Sending posts the message and it survives a reload.
4. The same gesture works on the **Git page**, proving the modules are genuinely
   surface-agnostic.
5. `RunDiffView` and `GitDiffPane` still scroll and lay out correctly after
   moving to `CodeView` — the main risk in Task 5.

Use `.agents/ignore/edit-repro.sh` (from the editable-review-diff work) to start
the daemon and dev server; it prints an authenticated URL.

- [ ] **Step 3: Commit any fixes, then hand off**

## Self-Review Notes

- **Spec coverage:** module 1 → Task 4; module 2 → Task 3; module 3 → Tasks 1–2;
  wiring → Task 7; the consolidation → Tasks 5–6; testing → each task plus
  Task 8.
- **Deliberate deviation:** subject travels as a query parameter and in the
  body, not as a path segment — a `worktree:` subject contains slashes. Recorded
  above.
- **Out of scope, per the spec:** `@mention` completion, slash-commands, the
  model picker, and the visual pass.
- **The riskiest task is 5**, not the chat — moving two working surfaces from a
  `FileDiff` stack to a virtualized `CodeView` changes layout behaviour that no
  unit test covers.
