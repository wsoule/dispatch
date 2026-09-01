# Selection actions, review chat, and one diff surface

Dispatch renders diffs in four places, three of them on `@pierre/diffs`, each
wired independently. None of them lets you select code and do something with it.
This spec adds a selection gesture and a working conversation about code, and
consolidates the renderers so both land once rather than three times.

The reference is Pierre's own agent-UI demo: select code, get a floating action,
"Add to chat", the snippet becomes a chip above a composer, ask the agent about
it.

## Why this cannot be lifted from Pierre's site

`@pierre/diffs` is Apache-2.0, so adapting it is permitted — that is not the
blocker. The blocker is that the pieces in question are not in the published
package. `AUI_DIFF_OPTIONS`, `AgentUi.tsx` and `agent-ui.css` live in their
`apps/docs` Next.js app, run on generated mock data
(`scripts/generate-aui-mock-data.ts`), and depend on server-rendered
`prerenderedHTML` that a Tauri SPA has no equivalent for. Their editable surface
is also `<File>`, not `<FileDiff>`. What is portable is the interaction design,
rebuilt against Dispatch's own data.

## Scope

**In:** the selection gesture, the chat with snippet attachments, subject-keyed
persistence, and the renderer consolidation that lets all of it land once.

**Out, deliberately:** `@mention` file completion, slash-commands, and the model
picker in the composer — additive once the pipe exists, and each is its own
decision. Also out: the visual pass (tab strip, type scale, density). That is
independent of everything here and can land any time.

## Modularity is the point

These components will be reused outside review, so nothing below may know what a
"run" is except the thin wiring layer. Three modules, each usable on its own:

### 1. `SelectionActions` — a diff-agnostic overlay

`apps/desktop/src/components/code/SelectionActions.tsx`

```ts
interface CodeSelection {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

interface SelectionAction {
  id: string;
  label: string;
  icon: ReactNode;
  onInvoke(selection: CodeSelection): void;
}

interface SelectionActionsProps {
  containerRef: RefObject<HTMLElement | null>;
  selection: CodeSelection | null;
  actions: SelectionAction[];
}
```

Renders a floating bar positioned against the live selection. Its actions are
**data supplied by the caller** — it knows nothing about chat, comments, runs,
or Dispatch. Dropping it over any future code surface with a different action
set requires no change to it.

Pierre's own selection popover (`enabledSelectionAction` /
`renderSelectionAction`) is an `EditorOptions` field — it only exists inside an
_attached editor_, which a read-only diff does not have. So this is ours.

**Geometry is separated out.** Pierre renders diff content into shadow DOM, so
measuring a selection means resolving a range across a shadow boundary. That
lives in `useShadowSelectionRect(containerRef)`, the one piece that knows about
Pierre, keeping the overlay itself generic.

### 2. `SnippetComposer` — a chat input that knows nothing about targets

`apps/desktop/src/components/chat/SnippetComposer.tsx`

```ts
interface Snippet {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

interface ChatTarget {
  id: string;
  label: string;
  /** Whether this target can modify the branch. Shown to the user, not just enforced. */
  canAct: boolean;
  hint?: string;
}

interface SnippetComposerProps {
  targets: ChatTarget[];
  attachments: Snippet[];
  onRemoveAttachment(index: number): void;
  onSend(body: string, attachments: Snippet[], targetId: string): Promise<void>;
}
```

Chips, textarea, target picker, send. Fully controlled: it never fetches, never
persists, and never learns what a target actually is. It renders in a test with
no server, no run, and no Pierre — which is the boundary test this design is
held to, and is also what makes it coverable at all (see Testing).

### 3. `ConversationStore` — keyed by subject, not by run

`packages/server/src/conversations.ts`, mirroring `reviewComments.ts`.

```ts
/** What a conversation is attached to. Not every surface has a run. */
type SubjectRef = `run:${string}` | `worktree:${string}` | `pr:${string}`;

interface ChatMessage {
  id: string;
  role: 'human' | 'agent';
  body: string;
  snippets: Snippet[];
  /** Which target this was sent to; absent on an agent reply. */
  target?: string;
  created: string;
}
```

Routes: `GET /api/conversations/:subject`, `POST /api/conversations/:subject`,
`DELETE /api/conversations/:subject/:messageId`. One JSON file per subject under
`DISPATCH_HOME`, exactly as review comments are stored.

Keying by `runId` would have been the natural choice and would have been wrong:
the Git page has no run, and neither does a PR. `SubjectRef` costs nothing now
and is expensive to retrofit.

### 4. The wiring — thin, per surface

`ReviewChatPanel` composes 1 + 2 + 3 and supplies only what is run-specific: the
two targets and
`subject = \`run:${runId}\``. The Git page's equivalent supplies different targets and
`worktree:${path}`,
reusing everything else unchanged.

## The gesture

Select code in any diff → a floating bar appears with **Add to chat**, **Copy**,
**Comment**.

`Comment` invokes the composer that already exists (`PierreReviewDiff` already
tracks ranges via `onSelectedLinesChange` for range comments), so the overlay is
a second entry point to an existing affordance rather than a parallel one.
`Add to chat` is the new path: it pushes a `Snippet` onto the composer's pending
attachments.

## The dock

The chat is a **bottom dock beneath the diff**, collapsed to a single input row
until used. Not the right rail — that is the thread index, and the two would
compete for the same space and the same attention.

A snippet renders as a chip above the input: `src/search.ts (22-24)` with a
dismiss control. Multiple chips are allowed; they are that message's attachments
and clear on send.

The **target picker** offers:

- **This run's agent** — resumes the session on the same branch and worktree,
  the path `orchestrator.ts`'s `requestChanges` already takes. `canAct: true`;
  it can change the branch.
- **Side conversation** — a fresh agent with the diff and snippet as context.
  `canAct: false`; it explains, it does not edit.

The picker states which one can act, because that is the only difference that
matters to the person choosing.

## Chat and review comments are separate channels

Comments are the **review record**: durable, resolvable, batched until submit,
and they travel with the verdict through `formatCommentsForAgent`. Chat is a
**working conversation**: immediate, for understanding code while reading it.

Chat is therefore **excluded from `formatCommentsForAgent`**. Any agent message
offers **Turn into review comment**, which is the one bridge between the two —
and the only way chat content reaches a send-back. Without that exclusion the
two channels collapse into one and the batched-until-submit property of reviews
is lost.

## One diff surface

Today:

| Component                      | Renderer            | Extras                 |
| ------------------------------ | ------------------- | ---------------------- |
| `PierreReviewDiff` (643 lines) | `CodeView`          | annotations, edit mode |
| `RunDiffView` (208 lines)      | `FileDiff` per file | —                      |
| `GitDiffPane` (88 lines)       | `FileDiff` per file | —                      |

`RunDiffView` and `GitDiffPane` are near-duplicates: both do `splitPatchFiles` →
`useDiffDisplaySettings` → `toDiffRenderOptions` → `PierreWorkerPool` →
`ErrorBoundary` → a `FileDiff` stack. Same six imports, same shape, two copies.

They consolidate into one `DiffSurface` built on `CodeView` — the same renderer
the review diff uses. `CodeView` is the virtualized path and the only one
supporting annotations, so unifying on it means selection actions, chat,
annotations and edit mode are wired **once** and every surface inherits them.

`DiffSurface` owns the shared shell: display settings → render options, the
worker pool, the error boundary, patch splitting, and the empty/error states all
three currently repeat. `PierreReviewDiff` becomes `DiffSurface` plus
review-specific annotations and edit wiring.

`DiffModal` is untouched — it does not render Pierre at all (it fetches through
`getFileDiffForSessionFile`), so it is not part of this duplication.

**Risk, stated plainly:** `RunDiffView` and `GitDiffPane` are working code, and
moving them from a `FileDiff` stack to a single virtualized `CodeView` changes
their scroll and layout behaviour. That is the main thing to watch when
verifying.

## Testing

**Server** — `ConversationStore` round-trips, subject-key isolation (a `run:`
conversation and a `worktree:` one never see each other), route validation, and
that a chat message never appears in `formatCommentsForAgent` output.

**Desktop** — `SnippetComposer` and `SelectionActions` get real render tests,
which is possible precisely because neither imports `PierreReviewDiff`. Anything
in that import graph pulls the Vite-only `?worker&url` specifier and cannot be
rendered under `bun test` at all; keeping these two modules out of it is a
design requirement, not an accident.

`useShadowSelectionRect` cannot be unit tested — shadow-DOM range geometry needs
a real browser. It gets a browser verification pass instead, and that limitation
is why it is isolated in its own hook rather than embedded in the overlay.

**Browser** — the gesture end to end on each of the three surfaces: select, Add
to chat, send, reply, promote to comment.

## What this does not depend on

Edit mode. The added/deleted-file editing bug documented in
`docs/pierre-editable-diff-bug.md` blocks that feature upstream but has no
bearing on anything here — different code path entirely.
