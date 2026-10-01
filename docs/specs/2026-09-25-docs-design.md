# Docs

Status: **v0 and v1 built**; v1.1 and v2 designed, not built. v0 also carries
v1's task 11, the A2A rules (Staging). Paragraphs marked "As built (v0)" record
where the code departs from the design below, which was revised 2026-09-26 after
a feasibility and consistency critique. Fourth of the six sub-projects in
`docs/specs/2026-09-23-messaging-core-design.md` (:21-30; row 4, :28: "Docs —
team documents beside tasks", FSL, depending on #2). This file replaces the
2026-09-25 draft, which followed the first options draft.

Binding input: `.agents/ignore/specs/2026-09-25-docs-options.md` ("options"),
revised 2026-09-26. Its recommendation, option B, and the recommended answer to
all 18 of its owner questions are adopted on the owner's behalf, as is every
choice this spec adds, including the ones the critique forced (see "Decisions
adopted on the owner's behalf"). "Critic responses" at the end says how each of
the critique's 40 issues was handled, and which parts were declined.

Citations: "messaging" is the messaging core spec above (working-tree copy);
"memory", "a2a", "fed" and "#6" are the memory, A2A bridge, federation and
published-spec designs in `.agents/ignore/specs/`; "decisions" is
`.agents/ignore/specs/2026-09-25-subprojects-2-3-decisions.md`. The federation
and published-spec designs were being revised while this was written, so they
are cited by section name, C-change label and task number, which fed itself asks
for ("This spec refers to its own parts by section name"); memory and a2a lines
are as of their 2026-09-25 17:14 text. Code references are to
`claude/agent-communication-platform-abb9af` at `f6870ed0`, re-read on
2026-09-26. Phase 3 is still committing, so lines in `api.ts`, `orchestrator/*`
and `messaging/*` can drift. Measurements were taken on this machine on
2026-09-26 with the pinned Bun 1.3.14 (`.prototools:1`).

## Why

Dispatch has nowhere to keep a long document that agents and humans share.

- **Specs and plans live in gitignored scratch.** AGENTS.md "Agent Artifacts"
  (:82-95) sends them to `.agents/ignore/`, which `.gitignore:39` ignores. On
  the morning of 2026-09-26 the main checkout and 26 worktrees held 92 such
  files: 49 names, 60 distinct contents, the Linear parity spec in 16 identical
  copies (options §1). By 17:00 the worktrees were down to 13 and the count was
  61 files, 47 names, 58 distinct contents, 3,358,550 bytes. A dispatched run
  never sees them, because its worktree is a plain `git worktree add -b` from
  the base branch (`packages/server/src/orchestrator/worktree.ts:100-127`). This
  workflow is the case in point: the #2 to #6 specs and plans were written into
  one worktree's scratch directory, and every run that implements them needs a
  copy placed by hand.
- **Committed docs cost a PR per edit.** A run's edit reaches other runs only
  after it lands, and two runs editing one spec conflict at merge. The desktop
  edits them with `POST /api/files/write`: operator tier (`api.ts:4249`), a
  blind overwrite with no base check (`api/files.ts:218-252`).
- **Task bodies stand in for documents.** This repo's `dispatch.db` has 15 task
  bodies over 8 KiB, the largest 60,363 characters (options §1). A body is
  replaced wholesale with no base check (`packages/core/src/store.ts:109-113`),
  and board sync merges bodies last-writer-wins per `##` section
  (`team/boardSync/engine.ts:9-14`, `:198-235`), so an agent and a human editing
  one section lose one edit silently. Nothing links to a section, and history is
  Activity lines.
- **Attachments are opaque and per machine** (`store.ts:314-327`); board sync
  carries only their names (`engine.ts:178`).
- **Memory is deliberately not a document store.** Entries stop at 8 KiB,
  "long-form belongs to #4" (memory :427), and ingest truncates with "long-form
  belongs in Docs" (memory :1403-1406).
- **Messages are traffic,** 64 KiB bodies in `messages.db` (messaging :144,
  :203-205). A thread is a conversation, not a living document.
- **A team arriving from Linear loses its specs.** Linear documents attach to
  "projects, initiatives, teams, issues, or cycles", with version history and
  live cursors ([Linear](https://linear.app/docs/documents)); the schema also
  gives them a release parent (`Document.release`). The parity plan syncs
  containers as tasks and never mentions documents (options §1).

Docs must (options §1): **(N1)** link to tasks of any kind, runs, threads,
memory entries and other docs; **(N2)** reach Claude, Codex, CLI-executor and
external MCP agents at a bounded prompt cost, without a file path; **(N3)** take
agent and human writes without either silently losing the other's; **(N4)** have
personal and team scopes; **(N5)** keep history, attribution and revert;
**(N6)** be searchable and exportable as markdown readable outside Dispatch
(`docs/TEAM-SERVER.md` §4, :102-112).

This spec adds `docs.db`: a daemon-owned store of long, linked, versioned
markdown documents, with anchored agent edits, a deterministic and bounded
three-way merge, a `doc` gate for accepted documents, and a budgeted prompt
index.

## Architecture

```text
┌────────────────────────────────────────────────────────────┐
│ MIT                                                        │
│  @dispatch/protocol  Ref type 'doc' · GateData 'doc'       │
│  @dispatch/protocol/federation  the DocBody type (v2)      │
│  @dispatch/core      doc wire types and limits, DocsConfig,│
│                      PolicyGate 'doc', NotificationKind    │
│                      'doc', DISPATCH_MCP_TOOLS entries,    │
│                      untrustedVerbatim                     │
│  @dispatch/mcp (doc_* tools) · @dispatch/client · CLI      │
└──────────────────────────────▲─────────────────────────────┘
                               │ HTTP
┌──────────────────────────────┴─────────────────────────────┐
│ dispatchd (FSL)  packages/server/src/docs/                 │
│  store.ts     DocStore + SqliteDocStore (docs.db, FTS5)    │
│  sections.ts  outline, anchors, [[slug]] mentions          │
│  merge.ts     bounded line diff and diff3, deterministic   │
│  ops.ts       anchored edit ops                            │
│  service.ts   scopes, namespaces, open revisions, links    │
│  review.ts    the unreviewed state                         │
│  gate.ts      proposals and the doc gate                   │
│  routes.ts    /api/docs*, doc.changed                      │
│  prompt.ts    the ## Docs section                          │
│  notices.ts   live-run digest lines                        │
│  receipts.ts  receipts step and restore                    │
│  transfer.ts  staged import and export                     │
│  publish.ts   publish task and worktree seed (v1)          │
│  assets.ts    images (v1)                                  │
│  linear.ts    Linear documents adapter (v2)                │
│ team/federation/docs.ts  signed `doc` op fold (ELv2, v2)   │
└────────────────────────────────────────────────────────────┘
```

- **No new workspace package.** Memory put its engine in an MIT package so
  another product can embed it (memory :107-124). Docs has no such use; the
  sub-project is FSL (messaging :28), and the MIT packages get only what they
  must share (Licensing). `scripts/check-licenses.ts` is unchanged.
- **No new dependency.** `merge.ts` carries its own line diff (Merge), so
  nothing waits at the 7-day release gate (`pnpm-workspace.yaml:8`). The earlier
  draft's `diff@9.0.0` is dropped: measured, it blocks the daemon for seconds on
  bodies this size.
- **One storage seam.** `DocStore` is an interface, as `TaskStore` is the
  storage seam for tasks (`docs/TEAM-SERVER.md:69-74`). `SqliteDocStore` over
  `docs.db` is its one implementation; a hosted backend for team projects can
  replace it without touching the service, routes or tools.
- **Why not the alternatives** (options §2-§3): docs as tasks would need a
  `kind` sweep across 19 `kind === 'epic'` sites, has no personal scope and
  loses concurrent edits; CRDT co-editing is the largest build, needs new
  dependencies behind the 7-day gate, and merges an agent's offline section
  rewrite into prose nobody wrote. It stays the hosted tier's upgrade (Staging,
  v2 item 22). Repo markdown reverses TEAM-SERVER §3 (:84-87) and survives only
  as publish (Publish to repo).

### Files on disk

```text
$DISPATCH_HOME/.dispatch/runs/<projectKey>/docs.db                team and personal docs of this project
$DISPATCH_HOME/.dispatch/runs/<projectKey>/docs-assets/<docId>/   pasted images (v1)
$DISPATCH_HOME/.dispatch/runs/<projectKey>/docs-restore/          staged receipt files awaiting restore (v1)
```

- `<projectKey>` is `sha256(rootDir)[:12]` (`orchestrator/paths.ts:27-33`).
  `docs.db` sits beside `messages.db` (`messaging/service.ts:94-96`) and
  `memory.db` (memory :126-141). It works on both task backends and is never
  committed.
- `docs.db`, `-wal` and `-shm` are 0600; `docs-assets/` and `docs-restore/`
  are 0700. Modes are set at creation and re-applied at open, as memory does
  (memory :142-146).
- `openDocsDb` calls `openSqliteDb` (WAL, `synchronous = NORMAL`,
  `packages/core/src/sqliteDb.ts:357-366`) and adds
  `PRAGMA busy_timeout = 5000`.
- `PRAGMA user_version` stamps the schema (`DOCS_DB_VERSION = 1`), and a build
  refuses a newer file, as `openMessagesDb` does
  (`packages/protocol/src/sqliteStore.ts:62-75`). The installed app and a dev
  build take turns on one root (#6, "Unknown gate types fail open across
  versions"; a2a :466-469), so an older build finding a newer `docs.db` is a
  normal state, not a rare one. It runs in the unavailable mode (Failure
  handling), in which nothing under `.dispatch/docs/` is touched, doc gates stay
  unapplied until a build that can open the file boots, and prompts carry no
  docs section. Memory could not use the refusal rule because every daemon under
  one home opens personal memory files at once (memory :150-165); `docs.db`
  belongs to one project and has one writer at a time.
- Personal docs live in this project's `docs.db`, not in memory's per-identity
  files, because they belong to one project (Q3). Their owner is a memory
  identity (memory :167-208), so a reused handle never inherits someone else's
  docs.

### Boot order

`docs.db` must be open before the boot receipt export, and the `doc` gate
handler must be registered before messaging replays unapplied gate effects:

1. **`openDocs`** runs after the task stores open and before
   `receiptsScheduler.exportNow()` (`packages/server/src/index.ts:1054`). It
   opens `docs.db`, applies any staged restore in `docs-restore/` (Receipts),
   and runs the boot seal sweep. It needs nothing from messaging.
2. **The receipts docs step** is registered when the scheduler is built
   (`index.ts:1037-1048`), so the boot export already includes docs, restored
   ones among them.
3. **Messaging binding.** Right after `openMessaging` (`index.ts:1250`), the
   daemon binds the docs host's messaging members (`raiseGate`, `closeGate`,
   `notice`, `recordPolicyApproval`) and calls
   `messaging.gates.register('doc', …)` (the registry is exposed at
   `messaging/service.ts:70`, `:497`). That happens before
   `await messaging.recover()` (`index.ts:1288`), so a replayed doc gate finds
   its handler.
4. **Reconcile** after `recover()`: raise gates for open proposals that have
   none, and close gates whose proposal is no longer open.

Steps 2 to 4 happen whether or not `docs.db` opened. In the unavailable mode the
docs step and the gate handler behave as Failure handling says.

### DocStore and DocsHost

```ts
// Persistence only; every rule lives in the service. Each write is one
// BEGIN IMMEDIATE transaction.
interface DocStore {
  doc(ref: string, ns: DocNamespace): DocRecord | null; // id, handle or retired slug in ns
  list(filter: DocFilter): DocRecord[];
  revision(doc: string, rev: string | number): DocRevision | null; // id or n
  body(rev: string): string;
  revisions(
    doc: string,
    page: { before?: number; limit: number }
  ): DocRevision[]; // n not null
  links(filter: { doc?: string; target?: LinkTarget }): DocLink[];
  proposals(filter: {
    doc?: string;
    state?: ProposalState[];
    author?: string;
  }): DocProposal[];
  reviews(doc: string): DocReview[];
  search(query: DocSearch): DocHit[];
  apply(tx: DocTx): void; // revisions, head, status, links, sections, FTS, proposals, reviews, tombstones
}

// How the service reaches the rest of the daemon, so its tests run against a
// recording fake. Members marked (late) are bound at boot step 3.
interface DocsHost {
  operatorOf(principal: Principal): Operator | null; // memory :257-290; null before memory v1
  taskOfPrincipal(principal: Principal): string | null; // an execute run's task
  runKind(principal: Principal): 'execute' | 'review' | 'verify' | null; // null: not a run
  canDecide(address: Address): boolean; // a human's tier now (teammate registry)
  task(id: string): {
    title: string;
    body: string;
    parent: string | null;
    risk: TaskRisk;
    labels: string[];
  } | null;
  a2aOrigin(taskId: string): boolean; // fails closed; see Principals
  exists(target: LinkTarget): boolean; // task, run, thread root, memory entry
  memoryScope(id: string): 'personal' | 'project' | 'team' | null; // memory v1; null before
  liveExecuteRuns(): {
    runId: string;
    taskId: string;
    operator: Operator | null;
  }[];
  notifyRun(runId: string, line: string): void; // orchestrator.notifyRun
  rule(risk: TaskRisk | undefined): PolicyRuling; // consultProjectPolicy(rootDir, 'doc', risk)
  raiseGate(proposal: DocProposal): Promise<string>; // (late) the gate id; an open one is reused
  closeGate(gate: string, reason: string): boolean; // (late) messaging/gates.ts:37-48
  notice(to: Address, replyTo: string | null, body: string): void; // (late) a system notice
  recordPolicyApproval(proposal: DocProposal, ruling: AutoRuling): void; // (late)
  changed(change: DocChange): void; // doc.changed, receipts scheduler, notices
  now(): Date;
}
```

`Principal` is messaging's (`messaging/principal.ts:9-13`) and `Operator` is
memory's (memory :215-224). `rule` wraps `consultProjectPolicy`
(`policyEngine.ts:56-66`), which reads policy per use and fails closed to
`block` when the config does not parse (`:61-65`).

### Principals

Every docs route and tool resolves its caller with `resolvePrincipal`
(`messaging/principal.ts:29-51`) before any handler runs.

| Principal                                                       | Acts for                                       | On docs                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| human at decide tier or above (a teammate token, the app token) | itself                                         | everything the scope, lifecycle and link tables allow a decide-tier human                                    |
| human at request tier                                           | itself                                         | read; write drafts; propose edits to accepted docs; links that displace nothing accepted                     |
| execute run                                                     | its task and its operator (`RunMeta.operator`) | read; write drafts; propose edits to accepted docs; links only to its own task, run and threads, and to docs |
| review or verify run                                            | its operator                                   | read only                                                                                                    |
| approved agent `agent:<op>/<name>`                              | `human:<op>`                                   | read; write drafts; propose edits to accepted docs; `context` links                                          |
| the owner's overseer                                            | the owner                                      | read only, through its status tools                                                                          |
| a run of a task with A2A provenance                             | nobody                                         | read team docs linked to its own task; nothing else                                                          |
| an agent whose name starts with `a2a.`                          | nobody                                         | refused on every docs route and tool (403)                                                                   |
| the shared `agentToken`                                         | nobody                                         | refused (403), as on messaging routes (`principal.ts:42-51`)                                                 |

- Review and verify runs judge work against the spec, so they must not move it.
- A run with no operator (memory :279-282) has no personal scope.
- A2A-provenance runs follow memory's rule that their output may leave the
  machine (memory :471-474; a2a decision Q12), so they see only what their own
  task links, and write nothing.
- **`a2aOrigin` fails closed.** It is true when `a2a.db` links the task
  (`tasks.dispatch_task`, a2a :1236-1246). If `a2a.db` cannot be opened, the
  bridge stays down (a2a :567-569), and `a2aOrigin` is then true for every task
  labelled `a2a` or whose body carries the bridge's provenance line
  `Requested over A2A by <client> (message m-…)` (a2a :1245-1246), which is the
  bridge's own crash-recovery lookup (a2a :1905-1906, :2271-2274). It never
  answers false because `a2a.db` is down. Adding the label to a task only makes
  its runs more restricted.

## Data model

### Doc, revision, link, proposal, review

```ts
type DocScope = 'personal' | 'team';
type DocNamespace = 'team' | `p:${string}`; // p:<owner identity>
type DocStatus = 'draft' | 'accepted' | 'archived';
type RevisionCause =
  | 'create'
  | 'save'
  | 'edit'
  | 'merge'
  | 'revert'
  | 'import'
  | 'restore'
  | 'proposal'
  | 'approve'
  | 'reject'
  | 'sync';

interface DocRecord {
  id: string; // doc-<ulid>
  ns: DocNamespace;
  slug: string; // the claimed slug in ns (replicated for team docs in v2)
  handle: string; // the effective slug in ns; equals slug unless a v2 sync claim lost
  title: string; // the head revision's title
  scope: DocScope;
  owner: { human: Address; identity: string } | null; // personal only
  status: DocStatus;
  archivedFrom: 'draft' | 'accepted' | null; // what restore returns to
  restored: { status: DocStatus; at: string } | null; // set by a receipts restore until accepted again
  head: { id: string; n: number; hash: string; bytes: number; sealed: boolean };
  reviewedRev: string | null; // the newest reviewed revision, for display
  unreviewed: boolean; // derived (Review state)
  conflicted: boolean; // the head carries conflict markers (v2 sync, Linear)
  origin: string | null; // import:<slug> | memory:<mem-id> | promoted:<doc-id> | linear:<id>
  published: {
    path: string;
    rev: string;
    task: string;
    commit: string | null;
  } | null;
  createdBy: Address;
  createdAt: string;
  updatedBy: Address;
  updatedAt: string;
}

interface DocRevision {
  id: string; // rev-<ulid>; a v2 sync merge has a hashed id (Team sync)
  doc: string;
  n: number | null; // per-doc ordinal on this daemon, "rev 12"; null for a proposal not approved
  parents: string[]; // [] for the first; two for merge, approve, reject, sync
  title: string;
  author: Address;
  cause: RevisionCause;
  summary: string; // one line, at most 200 bytes: 'replaced "## API"; appended to "## Risks"'
  approval: { by: Address; policy?: { rung: number } } | null; // approve revisions only
  hash: string; // sha256 of the body
  bytes: number;
  conflicted: boolean;
  sealed: boolean;
  unreviewed: boolean; // fixed at creation (Review state)
  provisional: boolean; // restored from receipts and not yet confirmed (Team sync)
  via: string | null; // the replica it arrived from (v2)
  createdAt: string;
  updatedAt: string; // last amend
}

interface DocLink {
  doc: string;
  target: LinkTarget; // { type: 'task' | 'run' | 'thread' | 'memory' | 'doc'; id: string }
  rel: 'spec' | 'plan' | 'context';
  source: 'manual' | 'mention';
  createdBy: Address;
  createdAt: string;
}

interface DocProposal {
  rev: string; // the proposal revision, rev-<ulid>
  doc: string;
  base: string; // the head it was made against
  author: Address;
  operator: Address | null; // visibility, as memory's proposals (memory :388)
  runId: string | null;
  taskId: string | null; // its risk decides policy
  origin: 'local' | `sync:${string}` | `linear:${string}`;
  gate: string | null; // the gate message deciding it
  state: 'open' | 'approved' | 'rejected' | 'expired' | 'withdrawn' | 'failed';
  decidedBy: Address | null;
  decidedByPolicy: { rung: number; authorizedBy: 'rung' | 'override' } | null;
  reason: string | null; // reject reason, or why it failed, expired or was withdrawn
  result: string | null; // the approve or reject revision
  createdAt: string;
  decidedAt: string | null;
}

interface DocReview {
  rev: string; // the revision reviewed; always sealed
  by: Address; // a decide-tier human (team), the owner (personal), or remote (v2)
  at: string;
}
```

- **Ids.** `doc-<ulid>` and `rev-<ulid>`, from `createUlidFactory`
  (`packages/protocol/src/ulid.ts:31`). `d-` is taken by task drafts
  (`packages/core/src/ids.ts:58-69`), and neither prefix can match
  `TASK_ID_PATTERN` (`ids.ts:103`). Ids are canonical; after v2 sync two
  replicas may number one revision differently, so every route and tool that
  takes a revision accepts `n` or the id, and nothing hashed or synced depends
  on `n`.
- **Links.** `spec` is "the document this task implements": target type `task`
  only, at most one team spec per task, and at most one personal spec per task
  and owner. `plan` is a plan for a task, any number. `context` links a doc to
  any target. A `thread` target is the root message id (`m-<ulid>`), a `memory`
  target `mem-<ulid>`, a `run` target `r-<hex>`. Tasks include epics and, after
  Linear parity P1, containers, since those are tasks. `source: 'mention'` rows
  are derived (Links and mentions) and are never set by hand.
- **Line endings.** Every write turns CRLF and lone CR into LF and strips a
  leading BOM, so merges and hashes never see two spellings of one line.

`@dispatch/protocol`'s `REF_TYPES` (`envelope.ts:24`) gains `'doc'`. A doc ref
is `{ type: 'doc', id: 'doc-…', at?: '<anchor>' }`: always the id, since a slug
can change and a personal handle means nothing to another reader, with `at`
naming a section. The comment on `at` (`envelope.ts:28`) becomes "a commit sha
for `file` refs; a section anchor for `doc` refs". Validation is unchanged
(`envelope.ts:234-241`), and threads render it through the existing `type:id@at`
form (`packages/protocol/src/render.ts:8`). Memory entries, whose refs are
protocol refs, can then cite a doc section.

### Handles and namespaces

- **Two kinds of namespace.** Team docs share the `team` namespace. Each owner's
  personal docs have their own, `p:<owner identity>`.
- **Handles.** A team doc is written `slug`; a personal doc is written `~slug`,
  and `~slug` resolves only among the personal docs of the caller's operator
  (for a human, their own). `~` is not a slug character, so the two forms never
  overlap, and a bare slug never resolves to a personal doc.
- **Uniqueness is per namespace.** The `-2` suffix, the 409 on an explicit slug,
  and the rule that a retired slug is never reused all apply within one
  namespace. A team create or rename never collides with a personal doc, so no
  write reveals that another human's personal doc exists or what it is called.
  Personal handles never enter team text: a team doc's `[[slug]]` and a task
  body's `[[slug]]` resolve team docs only, and `[[~slug]]` is resolved only in
  a personal doc, against its owner's own namespace.
- **Resolution** of a `doc` argument: `doc-…` is the doc by id; `~slug` the
  operator's personal doc by handle, then by retired slug; anything else the
  team doc by handle, then by retired slug. A doc the caller may not see is 404.

### Sections and anchors

- The outline is the ATX headings of levels 1 to 3 (`#`, `##`, `###`) outside
  fenced code blocks (` ``` ` or `~~~` fences). Deeper headings and setext
  headings are text inside their section.
- A section runs from its heading line to the next heading of the same or a
  higher level. Text before the first heading is the preamble, which is indexed
  but is not an edit anchor.
- Anchors follow GitHub's rule: lowercase; drop characters other than letters,
  digits, spaces, `-` and `_`; spaces become `-`; duplicates get `-1`, `-2`.
- A section reference is the heading text as written (trimmed, without the `#`
  run) or `#<anchor>`. Heading text that matches two sections is ambiguous, and
  the error lists their anchors.

### Validation and limits

`validateDocInput` rejects the following. Every failure is a `DocsError` whose
`field` names the bad input and whose `code` maps to a status as
`MessagingError`'s does (messaging :150-152): `invalid` 400, `forbidden` 403,
`not-found` 404, `conflict` 409, `limited` 429, plus `unavailable` 503 when
`docs.db` cannot be opened (as memory, memory :433-435).

| Input             | Rule                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | 1–200 bytes UTF-8, one line                                                                                                                                                           |
| `slug`            | 1–64 characters of `[a-z0-9-]`, starting with a letter or digit, not starting `doc-` or `rev-`; a leading `~` in a reference marks the personal namespace and is not part of the slug |
| reserved slugs    | `search`, `index`, `links`, `proposals`, `imports`, `health` (route segments)                                                                                                         |
| `body`            | at most 768 KiB UTF-8 (Q15), no NUL, and at most 960 KiB once JSON-escaped, so one revision fits a 1 MiB federation op (fed FederatedOp, "Size")                                      |
| computed bodies   | a merge, approval or Linear pull result is held to the `body` rule too (Merge); a v2 fold takes the oversize form                                                                     |
| links per doc     | 200                                                                                                                                                                                   |
| ops per call      | 50; `find` 1 byte to 8 KiB; the resulting body within the body limit                                                                                                                  |
| search `query`    | 500 bytes                                                                                                                                                                             |
| a `doc_read` page | 32 KiB                                                                                                                                                                                |
| creates           | `docs.createsPerHour` per run or agent (humans exempt)                                                                                                                                |
| proposals         | `docs.proposalsPerHour` per run or agent; `docs.maxOpenProposals` per project                                                                                                         |
| request body      | read with a 2 MiB bound before parsing, 413 past it; import contents 8 MiB each (Import); images 25 MiB                                                                               |
| an image (v1)     | PNG, JPEG, GIF or WebP by magic bytes, whatever the declared type; at most 25 MiB (`packages/core/src/attachments.ts:7`); never SVG                                                   |

- **The cap and this repo.** The largest file here is the A2A plan,
  `.agents/ignore/plans/2026-09-25-a2a-bridge.md`: 753,682 bytes raw and 771,559
  JSON-escaped at 17:00 on 2026-09-26. That is 95.8% of the raw cap and 78% of
  the escaped one, and 120 KB more than the critique measured that morning
  (options §1 recorded 433 KB). The memory plan's largest copy is 579,229 bytes.
  A direct write over the cap is refused with the hint "split it into linked
  docs"; import splits an over-cap file instead of refusing it, so its parity
  identities still hold (Import). A higher cap needs revisions that span several
  federation ops (Q15).
- The escaped-size rule matters only for bodies made mostly of quotes,
  backslashes, newlines or control characters, which JSON writes as two or six
  bytes.
- A new doc's slug defaults to `docSlug(title)`: lowercase, runs of `[^a-z0-9]`
  become `-`, trimmed of `-`, cut at 64 characters on a `-` where possible, and
  suffixed `-2`, `-3` on a clash in its namespace. (`slugify` in
  `packages/core/src/slug.ts:1-8` cuts at 40, too short for dated names.)
- A retired slug keeps resolving to its doc and is never given to another doc of
  its namespace.
- **As built (v0): titles.** A title also refuses C0, DEL and C1 control
  characters (a tab is allowed), and is stored trimmed. `set_title` and import
  apply the same check; an import heading that fails it falls back to the slug.

### Scopes and status

| Scope and status | Read                                                                                                 | Write directly                                                            | Accept, reopen, archive, restore, delete, mark reviewed |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| personal         | the owner; runs whose operator is the owner; agents registered under the owner; the owner's overseer | the owner; execute runs and agents acting for the owner                   | the owner, as a human                                   |
| team, `draft`    | every principal of the project (Principals)                                                          | humans; execute runs; approved agents                                     | decide tier                                             |
| team, `accepted` | the same                                                                                             | decide-tier humans; everyone else proposes (Proposals and the `doc` gate) | decide tier                                             |
| team, `archived` | the same, with `includeArchived`                                                                     | nobody until restored                                                     | decide tier                                             |

- **Status is team-only in meaning.** A personal doc can be marked `accepted` or
  `archived` as a label; only the owner's principals write it either way, and
  nothing is gated.
- **Scope never changes in place.** Promote (v1) copies a personal doc into a
  new team `draft` (new id, the current body, `origin: 'promoted:<id>'`, no
  history, a team slug from its title). Only its owner does it, as a human. Team
  docs never become personal.
- **A team doc never links to or mentions a personal doc or a personal memory
  entry.** A link row is visible to every reader of its doc and would reveal
  that the personal item exists.
- **v0 is team-only.** Personal scope needs memory v1's identities and
  `RunMeta.operator` (memory :2061-2063); until then a personal request answers
  403 "personal docs need memory v1". v0 has `draft` and `archived`; `accepted`
  and the gate arrive in v1.

### Who sees what

One rule, applied to list, read, search, links, the index, notices, exports and
receipts:

| Object             | Runs and agents                                              | Humans below decide tier               | Decide-tier humans              |
| ------------------ | ------------------------------------------------------------ | -------------------------------------- | ------------------------------- |
| team docs          | yes; A2A-provenance runs only those linked to their own task | yes                                    | yes                             |
| archived team docs | with `includeArchived`, marked                               | same                                   | same                            |
| personal docs      | those whose owner is their operator                          | their own                              | their own; 403 on anyone else's |
| open proposals     | their author, and the author's operator                      | their own, and their runs' and agents' | all                             |
| decided proposals  | their author                                                 | their own, and their runs' and agents' | all                             |

- **Proposal revisions follow their proposal.** A revision fetch, a diff, a
  `doc_read(rev)` or a mergeability read naming a proposal revision is allowed
  only to those the proposal rows allow; anyone else gets 404.
  `GET /api/docs/:ref/revisions` lists only revisions with an `n`, so unapproved
  proposal ids never appear in history. An approved proposal gets an `n` and
  joins history; a rejected, expired, withdrawn or failed one never does.
- A doc the caller may not see answers 404, so its existence is not revealed.
  The exception is a decide-tier human asking for another human's personal doc
  by id, who gets 403 with the reason, as memory does (memory :1675-1678).
  `a2a.` agents see nothing.

### Review state

`unreviewed` tells a reader that agent text in the head has not been checked by
a human. It is computed from the revision DAG, so no write can clear it by
accident.

- **Tainted revisions.** A revision is tainted when its author is not a human;
  when it carries a policy approval; when it arrived by sync from a publisher
  that cannot speak for its author (`via`); or when it was restored from
  receipts, whose frontmatter authorship is a claim, not evidence (memory
  :1017-1023).
- **Each revision's `unreviewed` is fixed at creation:** it is tainted, or a
  parent is `unreviewed` and has no review. Some causes differ:
  - `merge` and `sync` revisions add no taint of their own, though a sync fold
    is authored `agent:dispatch`: the fold is mechanical, so its flag is set
    only when a parent's is;
  - a human's approval revision takes only its head parent's state, since the
    approver saw the proposal's diff against its base;
  - a policy approval is always `unreviewed`, since a rung is not a review
    (memory :937);
  - a `revert` also carries the flag of the revision it restores, since it
    brings that text back.
- **A doc is `unreviewed`** when its head's flag is set and the head has no
  review. `reviewedRev` shows the newest review.
- **Only a review clears it,** as memory requires a human act on the revision
  (memory :483-486). A decide-tier human's "Mark reviewed" or accept on a team
  doc, or the owner's on a personal doc, adds a `reviews` row for the head,
  sealing it first. A human's save does not clear the flag. Neither does a clean
  merge of a human's stale buffer with an agent's edit: the merge's parent
  carries the flag.
- A doc that only humans ever wrote is never `unreviewed`.

### Tables (`docs.db`)

```sql
docs         (id PK, ns, slug, handle, title, scope, owner_identity NULL, owner_human NULL,
              status, archived_from NULL, restored_status NULL, restored_at NULL,
              head_id, reviewed_rev NULL, unreviewed, conflicted,
              origin UNIQUE NULL, published_path NULL, published_rev NULL,
              published_task NULL, published_commit NULL,
              created_by, created_at, updated_by, updated_at,
              meta_hlc_json NULL,                  -- v2: per-field clocks
              UNIQUE (ns, handle))
revisions    (id PK, doc_id, n NULL, parents_json, restored_parents_json NULL, title, body,
              hash, bytes, author, cause, summary, approval_json NULL, conflicted,
              sealed, unreviewed, provisional, via NULL, created_at, updated_at,
              UNIQUE (doc_id, n))
reviews      (doc_id, rev_id, by, at, PRIMARY KEY (doc_id, rev_id, by))
proposals    (rev_id PK, doc_id, base_rev, author, operator NULL, run_id NULL,
              task_id NULL, origin, gate NULL, state, decided_by NULL,
              decided_by_policy_json NULL, reason NULL, result_rev NULL,
              created_at, decided_at NULL)
sections     (doc_id, ord, level, heading, anchor, start_byte, end_byte,
              PRIMARY KEY (doc_id, ord))           -- the indexed head; ord 0 is the preamble
sections_fts USING fts5(doc_id UNINDEXED, ord UNINDEXED, title, heading, text,
              tokenize = 'porter unicode61')
links        (doc_id, doc_ns, target_type, target_id, rel, source, created_by, created_at,
              PRIMARY KEY (doc_id, target_type, target_id))
              -- CREATE UNIQUE INDEX links_one_spec ON links (target_type, target_id, doc_ns) WHERE rel = 'spec'
              -- CREATE INDEX links_target ON links (target_type, target_id)
slug_aliases (ns, slug, doc_id, retired_at, PRIMARY KEY (ns, slug, doc_id))  -- old slugs resolve; never reused
publishes    (task_id PK, doc_id, rev_id, path, state, commit NULL, created_at)  -- v1
assets       (doc_id, name, bytes, mime, created_by, created_at,
              PRIMARY KEY (doc_id, name))           -- v1; files under docs-assets/; mime from magic bytes
imported     (ns, slug, hash, doc_id, at, PRIMARY KEY (ns, slug, hash))  -- original contents imported
import_sessions (id PK, created_by, created_at, touched_at, manifest_json, link NULL)
import_contents (import_id, hash, body, PRIMARY KEY (import_id, hash))
tombstones   (doc_id PK, ns, slug, origin NULL, deleted_by, at, hlc NULL)
sync_missing (rev_id, doc_id, replica, seq, dropped_at, PRIMARY KEY (rev_id, replica, seq))  -- v2
linear_docs  (doc_id PK, document_id UNIQUE, base_rev, remote_updated_at)  -- v2
meta         (key PK, value)                        -- root, last sweep, last import and restore reports
```

- **`links_one_spec` is per namespace:** `doc_ns` copies the linked doc's
  namespace, so a personal spec never blocks a team spec, and each owner has at
  most one personal spec per task.
- **FTS is an ordinary FTS5 table, not external-content.** Memory found that an
  external-content table whose column names differ from its content table breaks
  `snippet()` (memory :576-581). Section text is stored twice, and only heads
  are indexed.
- **Search fallback.** If creating the virtual table fails
  (`no such module: fts5`), the store opens in fallback mode: search ANDs the
  terms as `LIKE` over title, heading and text, ranks by recency, and snippets
  are the first 160 bytes of the section. `GET /api/docs/health` reports
  `search: 'like'` (memory :592-602).
- **One transaction per write:** the revision, the head, sections and FTS rows
  when they are rebuilt, derived links and any proposal row. A crash leaves the
  doc as it was or as it became.
- **Every sealed revision keeps its full body** (Q9). `GET /api/docs/health`
  reports the file size and warns above 100 MB, Q9's revisit trigger. Delta
  storage waits for a doc with 500 revisions (options §4.8).

### Configuration

Every key lives under `docs:` in `.dispatch/config.yml` and is read per use, as
memory's are (memory :606-609). An invalid value falls back to its default, with
a warning in `GET /api/docs/health`. `DocsConfig` joins `@dispatch/core`'s
config types, and `parseDocsConfig`, like `a2a:`'s, never throws from
`loadConfig` (a2a :604-613).

| Key                | Default | Allowed          | Meaning                                                |
| ------------------ | ------- | ---------------- | ------------------------------------------------------ |
| `indexTokens`      | 400     | integer 150–2000 | budget of the `## Docs` prompt section                 |
| `inlineSpecBytes`  | 16384   | integer 0–65536  | spec body inlined for executors without the MCP server |
| `coalesceMinutes`  | 10      | integer 0–60     | idle window of an open revision; 0 seals every write   |
| `noticeMinutes`    | 10      | integer 1–120    | at most one live notice per doc per run in this window |
| `createsPerHour`   | 20      | integer 1–200    | doc creates per run or agent                           |
| `proposalsPerHour` | 10      | integer 1–100    | proposals per run or agent (memory's default)          |
| `maxOpenProposals` | 50      | integer 1–500    | open proposals per project                             |
| `proposalTtlDays`  | 14      | integer 1–90     | an open proposal older than this expires               |

## Writing

### Bases

Every read returns the head as `{ id, n, hash }`. A write names its base:

- `baseRev`: the revision the writer started from, as `n` or id.
- `baseHash`: the body hash the writer holds. The desktop and CLI always send
  it. The MCP server remembers the `(rev id, hash)` it last returned for each
  doc and sends the hash whenever the agent's `baseRev` is that revision.

A `baseRev` that is not a revision of this doc is `invalid`. A `baseHash` that
does not match the base's current body is 409 `base-changed`, which happens only
when one principal edits in two places at once (Open revisions).

### The write path

For principal P writing doc D:

1. **Authorize** (Principals, Scopes and status, Links and mentions) and
   validate. An archived doc answers 409 "archived; restore it first".
2. **Route.** D is a team `accepted` doc and P is not a decide-tier human: the
   proposal path (below). Otherwise the direct path.
3. **Compute the new body**: anchored ops applied to the head, or a whole body
   merged against the head (below). The result must meet the body limits.
4. **Nothing changed** (the body and title equal the head's): no revision; the
   result says `unchanged: true`.
5. **Store**: amend P's open head in place, or add a revision (Open revisions),
   with its `unreviewed` flag (Review state). Then `host.changed`.

**As built (v0): the result.** A write answers one `status`: `saved`, `amended`,
`merged`, `proposed` (v1) or `unchanged`, in place of the `unchanged: true`,
`amended: true` and `merged: true` flags this section, Open revisions and
Whole-body saves name. A stale whole-body save that leaves the head's text as it
was is not always step 4's `unchanged`; Whole-body saves says what it does.

### Anchored edits

`POST /api/docs/:ref/edit` and `doc_save(doc, ops)` take `{ ops, baseRev? }` and
apply the ops **to the head**, not the base, so an agent's edit re-applies over
a human's newer text instead of conflicting with it (Q4):

| Op                                  | Effect                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `replace_section { section, text }` | replaces everything after the heading line through the section's end, subsections included                       |
| `replace { find, text }`            | replaces `find`, which must occur exactly once in the body, like the Edit tool                                   |
| `insert { before, text }`           | inserts `text` directly above the heading line of section `before`                                               |
| `append { text, section? }`         | appends at the end of `section`, before the next heading of the same or a higher level, or at the end of the doc |
| `set_title { title }`               | sets the title                                                                                                   |

- `text` in `replace_section`, `insert` and `append` is whole lines: a missing
  final newline is added. `replace` is exact.
- Ops apply in order, each to the body the previous one produced. The call is
  atomic: if op 3 fails, nothing changes, and the error names `ops[2]`, the
  section or `find` text, and why (`not found`, `found 2 times`,
  `ambiguous: #api, #api-1`).
- When `baseRev` is given and the head has moved past it, the result carries
  `rebased: { since: [{ n, author, summary }] }`, so the agent knows it edited
  text newer than it read.
- The revision summary lists the ops
  (`replaced "## API"; appended to "## Risks"`), cut to 200 bytes.
- `doc_read` returns text exactly as stored (MCP tools), so a `find` copied from
  it matches.
- **As built (v0): two more refusals.** One call's outlining and `find` scans
  are priced against a fixed work budget, about 50 section ops on a cap-sized
  prose doc; the op that passes it is refused with "these ops scan too much of a
  long doc; send fewer section ops, or save the whole body". A heading-shaped
  line is priced as a heading even inside fenced code, so a long doc of fenced
  `#` comments admits only a few section ops per call. And the body limit is
  checked after every op, so an op that takes the body over 768 KiB is refused
  even when a later op would bring it back under.

### Whole-body saves

`PUT /api/docs/:ref/body` and `doc_save(doc, body, baseRev)` take
`{ baseRev, baseHash?, body, title? }`:

- **Base is the head:** the new body applies (amend or new revision).
- **The head has moved:** a three-way merge of base, head and the new body
  (Merge). The head is sealed first if it is open.
  - **Clean:** two revisions in one transaction. The writer's text is stored as
    a sealed revision X with parent `base` and cause `save`, so history keeps
    what the writer wrote. A merge revision M with parents `[head, X]`, cause
    `merge`, authored by the writer and summarized "merged with rev N by
    \<author>", becomes the head. The result says `merged: true`. A merged body
    over the limits is `invalid` ("the merged body is over the limit; split the
    doc"), and nothing is stored.
  - **Conflict:** nothing is stored, and the answer is 409:

    ```ts
    interface DocConflict {
      code: 'conflict';
      reason: 'merge-conflict' | 'base-changed';
      head: {
        id: string;
        n: number;
        hash: string;
        body: string;
        author: Address;
      };
      base: { id: string; n: number } | null;
      hunks: { line: number; base: string[]; head: string[]; mine: string[] }[];
      marked: string; // the merged body with diff3 markers at each hunk, local labels
    }
    ```

    `base-changed` carries no hunks, and `marked` is the head's body.

- A title changed on one side of a merge wins. Changed on both, the writer's
  wins: it is one line and visible in the result.
- **As built (v0): `mine`.** A `merged` result also carries
  `mine: { id, n, hash }`, the revision holding the text the writer sent (X, or
  its base when it sent the base unchanged). An editor still typing bases its
  next save on `mine` and reloads the merged head only once its buffer is clean:
  basing on the merge would drop the other side's edit on that next save.
  `doc_save` prints it as "your text is rev N".
- **As built (v0): a stale save that adds nothing to the head.** When the merged
  body and title equal the head's:
  - a body equal to the head's answers `unchanged`, with the head as `rev`, and
    stores nothing;
  - a body equal to the base's (the writer changed nothing) answers `merged`,
    with the head as `rev` and the base as `mine`, and stores nothing. Here
    `merged` means the writer's base is behind, not that a merge revision was
    stored; the desktop reloads the head on it;
  - any other body (the head already holds the writer's changes) still stores X
    and M, with M's body and title equal to the head's. History gains two
    revisions whose diff from the old head is empty, and M takes X's flag, so
    such a save by an agent or a run marks the doc `unreviewed` although its
    text did not change. X is kept because an editor still typing bases its next
    save on it (`mine` above).

### Open revisions

A 600 ms autosave, or an agent's run of small edits, would otherwise make
hundreds of full-body revisions. An author's consecutive writes extend one
**open** revision (options §4.1), and only sealed revisions are merge bases,
receipts or sync.

- The head R is **open to P** when R's author is P, its cause is `create`,
  `save` or `edit`, and it is not sealed.
- A write by P whose base is R **amends R in place**: body, hash, bytes, title,
  summary (appended, cut to 200 bytes) and `updated_at`. The id and `n` stay.
  The result says `amended: true`.
- R is **sealed**, and never amended again, when any of these happens:
  - `coalesceMinutes` pass with no amend, or R is 60 minutes old;
  - anyone other than P writes the doc, or a merge needs R as a base;
  - anyone other than P receives R's body: a read with the body, a `doc_read`
    page, a revision fetch, a diff or an export. Index lines and search snippets
    do not count;
  - P presses "Save version" (`POST /api/docs/:ref/seal`), or runs
    `dispatch docs edit`, which seals on save;
  - a review, status change, link change, revert, publish or promote touches the
    doc.
- A sweep every 60 s seals expired open revisions and runs once at boot.
- Because only P can have read R before it seals, nobody else can hold an
  amended body as a base. P's own second editor is caught by `baseHash` (409
  `base-changed`).
- Receipts and v2 sync carry only sealed revisions. For a doc whose head is
  open, they use its newest sealed ancestor, so an exported revision never
  changes after export.
- **The section index follows the head:** sections and FTS rows are rebuilt in
  the write transaction when a new revision becomes head or a revision seals,
  and by the 60 s sweep for a head amended since. Search lags an open head by at
  most a minute.

### Proposals and the `doc` gate

An edit to a team `accepted` doc by anyone but a decide-tier human is a
**proposal**: an unmerged revision on the head it was made against (Q5).
Proposal content reaches no other run until it is approved.

1. **Compute** the body as on the direct path: ops apply to the head; a whole
   body with a stale base is merged first, and a conflict is a 409 with no
   proposal.
2. **Extend or create.** P has at most one open proposal per doc. If one is
   open, the write applies to the proposal's body instead of the head (ops
   against it, or a whole body whose `baseRev` is the proposal), amending it in
   place; its gate stays. Otherwise a new proposal revision (cause `proposal`,
   `n` null, parent the head) and a `proposals` row. A body equal to the head is
   `unchanged`. One equal to another open proposal's is a `conflict` naming it
   when the caller may see that proposal; otherwise it is stored as its own
   proposal, so the answer reveals nothing.
3. **Rate limit:** `docs.proposalsPerHour` per run or agent, and
   `docs.maxOpenProposals` per project, as memory (memory :807-813).
   Sync-arrived and Linear proposals are exempt.
4. **Consult policy** outside the transaction: `host.rule(risk)`, where `risk`
   is the proposal's source task's risk. A proposal with no task (an external
   agent, a request-tier human, Linear) reads as `elevated`, which caps the rung
   at 3 (`RISK_RUNG_CAPS`, `packages/core/src/policy.ts:82-86`), so a human
   always decides it (memory :814-820).
5. **On `auto`**, the proposal is approved at once (Effect, below) as the system
   with `decidedByPolicy` set, and `host.recordPolicyApproval` writes the ledger
   receipt. No gate is sent. The tool result says `status: 'saved'`.
6. **On `block`**, `host.raiseGate` sends the gate as `agent:dispatch` to the
   project owner, reusing an open gate whose `data.proposal` matches
   (`openBlocking`, `packages/protocol/src/store.ts:76`). The result says
   `status: 'proposed'` with the proposal and gate ids.

A crash between storing the proposal and raising its gate leaves an open
proposal with no gate id; boot reconcile calls `raiseGate` for it, which finds a
gate sent before the crash rather than sending another (memory :846-851).

**The gate.** A new `GateData` variant
(`packages/protocol/src/envelope.ts:73-97`), also added to `GATE_TYPES`
(`:66-72`) and the desktop's gate set (`apps/desktop/src/lib/gates.ts:34-40`):

```ts
| { type: 'doc'; doc: string; proposal: string; taskId?: string; runId?: string }
// doc-<ulid>, rev-<ulid>; the proposal's source task and run, when it has them
```

- **No content in the message.** Title, body and diff stay in `docs.db`; the
  card reads them through `GET /api/docs/proposals/:rev` (Who sees what). The
  body is one line:
  `run:r-9f2c01 proposes an edit to an accepted doc. Review it in Needs you.`
- **Shape:** exactly `kind: 'question'`, `blocking: true`,
  `choices: ['approve', 'reject']`; `refs` name the doc, the task and the run.
  Answering needs the `decide` tier, like every gate (messaging :391-395;
  `envelope.ts:274-281`).
- **The decision feed** shows a doc gate's task and run. `gateItems` takes the
  run from `gate.runId` only for tool approvals and otherwise from a `run:`
  sender (`packages/server/src/decisionFeed.ts:432-435`), and a doc gate's
  sender is `agent:dispatch`. It gains the `doc` case: run from `gate.runId`,
  task from `gate.taskId`.
- **Only the system's own doc gates act.** `validateGate` lets the system or any
  deciding human raise any gate but `scope` (`envelope.ts:149-151`, `:186-192`),
  so today a human can send a question shaped like a doc gate. #6 registers
  `doc` as system-only (#6 Registries §11), and its C5 makes `validateGate`
  enforce that through `GATE_RAISERS`. Until C5 lands, and for rows older builds
  stored, what makes a forged one harmless is the handler, and that check is
  load-bearing: it acts only when the question's `from` is `agent:dispatch`, the
  proposal is `open`, and the proposal's recorded gate id is this question's id.
- **Only a deciding human's or the system's answer acts.** A build that predates
  the `doc` type sees a plain question that any participant may answer, and a
  newer build's `recover()` would replay that answer (#6, "Unknown gate types
  fail open across versions"). #6's C1 (unknown gate types fail closed), C2
  (answers from neither a human nor the system are voided and the gate reopens)
  and C5 (deciding principals and raise authority) close that hole in the
  protocol, and task 12 waits for them (#6 Staging task 7a, which lists "#4's
  gate task" among what it must precede). C2 checks only for a `human:` address,
  not the tier, so the handler also checks the tier itself: an answer from a
  human for whom `host.canDecide` does not hold now (a row a pre-C1 build
  accepted from a request-tier teammate) is ignored. The proposal stays open,
  its gate id is cleared so reconcile raises a fresh gate that records its own
  id, and the system sends that answer's author a notice as C2 does.
- **Autonomy ladder** (`packages/core/src/policy.ts`): `PolicyGate` and
  `POLICY_GATES` (`:13-27`) gain `'doc'`; `GATE_RUNGS.doc = 4` (`:67-73`), the
  rung the owner set for memory, because an accepted doc reaches every run that
  links it (decisions :4). Per-gate pins and risk caps apply unchanged.
  - **Precondition: unknown gate keys must not throw.** `parsePolicyConfig`
    throws `unknown policy gate` for any key outside `POLICY_GATES`
    (`packages/core/src/config.ts:896-900`), inside `loadConfig` (`:1401`), and
    the Settings write path repeats it (`:1791-1795`). `config.yml` is
    committed, so a `policy.gates.doc` pin would break every `loadConfig` caller
    on a teammate's older build or on the installed app alternating with a dev
    build (a2a :609-611 counts 53 such callers). `consultProjectPolicy` masks
    this only for the policy engine (`policyEngine.ts:61-65`). So
    `parsePolicyConfig` first learns to skip an unknown gate key with a warning,
    and that change ships at least one release before task 12. A `gates.doc` pin
    needs that minimum version, and Settings writes `gates.doc` only when a
    human sets it explicitly. Memory's `memory` gate has the same hazard
    (Changes to other specs).
- **Effect.** `gates.register('doc', …)` (`messaging/gates.ts:18-34`) at boot
  step 3, always, even when `docs.db` did not open. A type with no handler is
  ignored and then marked applied (`gates.ts:25-33`;
  `packages/protocol/src/engine.ts:360-379`), which would lose a human's
  decision. In the unavailable mode the handler throws
  `DocsError('unavailable')`, so `applyGate` leaves the effect unapplied and the
  next boot's `recover()` (`engine.ts:426-455`, `index.ts:1288`) applies it once
  `docs.db` opens. The handler is idempotent under replay because of the checks
  above.
  - **approve:** an `approve` revision A with parents `[head, proposal]`,
    authored by the approving human (or `agent:dispatch` with `approval.policy`
    for a policy approval), body `diff3(proposal.parent, head, proposal)`. When
    the head has not moved, A's body is the proposal's. The proposal gets `n`,
    becomes `approved`, and A becomes the head, sealed. A's `unreviewed` follows
    Review state: a human approval adds no taint, a policy approval does.
    Approval never fast-forwards to the proposal itself, so every approved
    change carries its approver into history and into sync (Team sync).
  - **approve that conflicts** (the head moved over the same lines), or whose
    result is over the body limits: nothing is stored, the proposal becomes
    `failed` with "conflicts with rev N" or "merged body over the limit", the
    system replies in the gate thread with a `notice` to the approver, and the
    author's live run gets a digest line. The card shows mergeability before the
    choice (below), so this is rare.
  - **approve on a doc archived since:** the proposal becomes `failed` with "the
    doc was archived", with the same notice. (Archive withdraws open proposals,
    so only a race reaches this.)
  - **reject:** the proposal becomes `rejected`, the answer's body is its
    reason, and nothing changes. The author's live run gets a digest line.
  - **an answer to a proposal no longer open** (expired, withdrawn): nothing
    changes, and the system replies with a notice naming its state.
- **Receipts.** A policy approval writes the ledger receipt the policy engine
  writes for every auto-decision: a `decision` titled
  `Doc edit approved: <doc id>`, detail
  `proposal rev-… from run:r-… — auto-decided by policy rung 4 (doc gate)`, and
  a `[policy]` Activity line on the source task (memory :942-951). The "(doc
  gate)" wording is memory's change to `describePolicyAuthorization`
  (`policy.ts:261`; memory :897-903), which task 12 depends on. Human decisions
  write none; the gate thread is the record.
- **Expiry.** The sweep marks proposals older than `docs.proposalTtlDays`
  `expired` in `docs.db` first, then calls
  `host.closeGate(gate, 'proposal expired')`. `engine.close` writes an
  `x-closed` answer with no choice and applies no effect (`engine.ts:575-612`,
  `:798-801`), which is why `docs.db` moves first. A crash between the two
  leaves a dead open gate that reconcile closes.
- **Notifications.** `NotificationKind`
  (`packages/core/src/configTypes.ts:343-348`) gains `'doc'`, on by default;
  `notificationKindForMessage` (`:358-372`) returns it for doc gates.
- **Desktop copy.** The policy table
  (`components/settings/PolicySection.tsx:61-82`) gains "Edits to accepted docs:
  an agent's edit to an accepted team doc applies without review, and every run
  that links the doc reads it." Memory relabels rung 4 for its gate (memory
  :891-903); that relabel is extended to cover docs (Changes to other specs):
  core's label (`policy.ts:50`) "Auto-merge on green and accept agents' team
  memory and doc edits", the slider's (`PolicySection.tsx:56`) "Merge and accept
  memory and doc edits on their own", rung 4's description (`:48`) gaining
  "Agents' edits to accepted docs apply without review", and rung 3's (`:47`)
  ending "Merging, shared memory and accepted docs still wait." The core stop
  keeps its name `auto-merge`.

### Lifecycle

| Action        | Route                                       | Who (team doc)                   | Effect                                                                                      |
| ------------- | ------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| accept (v1)   | `POST /status {status:'accepted'}`          | decide tier                      | seals the head and reviews it; clears `restored`                                            |
| reopen (v1)   | `POST /status {status:'draft'}`             | decide tier                      | withdraws open proposals (below)                                                            |
| archive       | `POST /status {status:'archived'}`          | decide tier                      | withdraws open proposals; leaves the index, default list and search; keeps links; read-only |
| restore       | `POST /status {status:'draft'\|'accepted'}` | decide tier                      | back to `archivedFrom` or the named status                                                  |
| mark reviewed | `POST /reviewed`                            | decide tier                      | reviews the head, sealing it (Review state)                                                 |
| save version  | `POST /seal`                                | the head's author                | seals the open head                                                                         |
| revert        | `POST /revert {rev}`                        | writers (a proposal on accepted) | a new revision with that revision's title and body, cause `revert`                          |
| rename        | `PATCH {slug}`                              | request tier and above           | old slug into `slug_aliases`; `[[old]]` and `doc_read("old")` resolve                       |
| hard delete   | `DELETE`                                    | decide tier                      | closes open gates, then removes every row of the doc; tombstone (id, ns, slug, origin)      |

- **Withdrawal.** Reopen and archive mark each open proposal `withdrawn` in
  `docs.db` ("the doc was reopened as a draft; write to it directly" or "the doc
  was archived"), then `host.closeGate` its gate, and each author's live run
  gets a digest line. The content stays readable by its author as `rev-…`. A
  draft has no gate, so no proposal outlives a reopen.
- **Hard delete** closes each open gate first, so Needs you keeps no gate
  pointing at a doc that is gone. A replayed answer then finds no proposal and
  does nothing.
- Personal docs: the owner, as a human, does all of these. Imports skip a
  tombstoned origin, and v2 sync does not resurrect a deleted doc from older
  ops.

### Links and mentions

- `POST /api/docs/:ref/links { target, rel, replace? }` adds or changes a link,
  and `DELETE /api/docs/:ref/links/:type/:id` removes one. The target must exist
  (`host.exists`) and be visible to the caller. Personal docs: the owner's
  principals, on the owner's visible targets. Team docs:

  | Link change                                                      | Who                                                                                                         |
  | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
  | `context` to a doc, run, thread or memory entry                  | anyone who may write the doc's drafts; a run only to its own run and threads it takes part in, besides docs |
  | `context` to a task                                              | humans and approved agents who may write the doc's drafts; an execute run only to its own task              |
  | `spec` or `plan` to a task, displacing no accepted doc           | humans; an execute run only on its own task                                                                 |
  | replacing or removing a `spec` or `plan` link to an accepted doc | decide-tier humans                                                                                          |
  | any link to a task of A2A origin (`host.a2aOrigin`)              | decide-tier humans                                                                                          |

- A `spec` link to a task that already has a team spec answers 409 naming it.
  `replace: true` moves it only when the caller could write the displaced doc
  directly (a team draft), or is decide tier.
- **Why links are gated this way.** Link rows are not content, so they are not
  proposals, but they decide what a run implements: the index puts the task's
  `spec` first. Without these rows an agent could write an ungated draft and
  repoint a task's accepted spec at it, or link its draft as `spec` to a
  teammate's task, and the premise of Q5, that a team doc reaches only runs
  whose task links it (options §4.2 :194-197), would fail. With them an agent
  can add a plan or a context link, which the index marks `unreviewed`, and
  never displace an accepted spec or plan.
- **Doc bodies:** when a revision seals, its doc's `mention` links are rebuilt
  from `[[slug]]` and `[[slug#anchor]]` outside fenced code, as `context` links
  (and, in a personal doc, from `[[~slug]]`). Only docs the revision's author
  can see are linked, and a team doc never mentions a personal one (the text
  stays; no link is made).
- **Task bodies:** `[[slug]]` in a task body is resolved at read time by the
  prompt index and the task page, as a team `context` link. Nothing is stored,
  so no task write path (API, MCP, board sync, Linear) needs a hook. Mentions in
  the body of a task of A2A origin are ignored: its body is client text (a2a
  :1236-1246), and the acceptance criteria sit outside the untrusted fence.
- The task page, the thread view and the memory entry view list docs that link
  to them (`GET /api/docs/links?target=task:t-4a8cce`). The task page also lists
  docs linked to its ancestors, marked "from parent".
- `task_get` (`packages/mcp/src/tools.ts:963`) gains an optional
  `docs: string[]` output field: the task's index lines from
  `GET /api/docs/index?taskId=`. The MCP task tools authenticate with
  `daemonAuth`, which sends the shared agentToken
  (`packages/mcp/src/daemon.ts:98-107`), and docs routes refuse it
  (`principal.ts:42-51`). So this one fetch uses the caller's messaging
  credential, the run token or the registered agent's token, through
  `messagingCredential` (`packages/mcp/src/identity.ts:231`), as the `doc_*`
  tools do. The field is omitted when the daemon or `docs.db` is unavailable,
  and a 403 there is a bug, not an omission (Testing).

## Merge

`packages/server/src/docs/merge.ts` is pure: three strings and their revision
ids in, a result out. It carries its own line diff.

- **Why not jsdiff.** jsdiff removed its `merge` in 8.0.0 (#596,
  [release notes](https://github.com/kpdecker/jsdiff/blob/master/release-notes.md)),
  so diff3 is ours either way, and its `diffArrays` is too slow for the daemon's
  one thread at this body cap. Every docs route, MCP call and health probe is
  served by one `Bun.serve` process (`packages/server/src/index.ts:1790`).
  Measured with `diff@9.0.0` from the lockfile against the A2A plan as it stood
  during the run (758,751 bytes, 15,747 lines): moving a 2,000-line block took
  4.6 s with `maxEditLength: 20000`; swapping the two halves took 43.4 s; 2,000
  scattered one-line edits took 4.8 s. Lowering the bound only makes it give up,
  slowly: at 2,000 it spent about 1.05 s before returning `undefined` on all
  three, and at 1,000 about 240 ms, since its cost grows with the square of the
  bound.
- **The line diff:**
  1. Split each body into lines, each keeping its newline, and map each distinct
     line to an integer for this call, so the diff compares integers.
  2. Trim the common prefix and suffix.
  3. Anchor on lines that occur exactly once on each side of the range, keep the
     longest run of anchors in the same order on both sides (a longest
     increasing subsequence), and recurse into the gaps between anchors. This is
     patience diff, as `git diff --patience`
     ([git](https://git-scm.com/docs/git-diff#Documentation/git-diff.txt---patience)).
  4. A gap with no such line gets a linear-space Myers diff, the middle-snake
     form ([Myers 1986](http://www.xmailserver.org/diff2.pdf)), over the integer
     arrays.
  5. One work counter per diff counts each line visited in step 3 and each
     diagonal step and snake comparison in step 4. Once it passes
     `DIFF_WORK = 2_000_000`, every range not yet resolved becomes one changed
     chunk.

  The result is always a valid diff: applied to the old side it gives the new
  side. A spent budget only makes chunks coarser, so conflicts become likelier;
  a merge is never wrong. Unlike jsdiff's `timeout`, the counter depends only on
  the inputs.

- **Measured** with a prototype of these steps on a 793,682-byte body of 15,957
  lines, just over the cap, built from the A2A plan: a 2,000-line block move
  took 5 ms; swapped halves 7 ms; 2,000 scattered edits 8 ms; every third line
  blanked 9 ms; every `##` section in reverse order 49 ms (budget spent); every
  line rewritten 59 ms (budget spent). A merge runs two diffs, so it costs at
  most about 120 ms. It runs on the request thread; no worker is added, and a
  per-call Worker would leak descriptors under the pinned Bun 1.3.14 in any
  case.
- **diff3** walks the two diffs over the base into stable and unstable chunks,
  as diff3 does
  ([Khanna, Kunal and Pierce](https://www.cis.upenn.edu/~bcpierce/papers/diff3-short.pdf)):
  - a chunk changed on one side takes that side;
  - a chunk changed identically on both sides is taken once;
  - a chunk changed differently on both sides is a conflict hunk; insertions by
    both sides at one base position conflict unless identical, as
    `git merge-file` treats them
    ([git](https://git-scm.com/docs/git-merge-file)).
- **Markers** use git's diff3 style. A body that is stored, hashed or synced
  labels its sides by revision id only, fixed by `MERGE_ALGO`:
  `<<<<<<< rev-<first parent>`, `||||||| rev-<base>`, `=======`,
  `>>>>>>> rev-<second parent>`, with parents sorted by id. Only the `marked`
  body of a 409, which is never stored, uses local labels:
  `<<<<<<< head (rev 13, human:wyat)`, `||||||| base (rev 12)`, `=======`,
  `>>>>>>> yours`. The desktop's merge view shows "rev N by X" for an id.
- **Results obey the body limits** (Validation): a clean whole-body merge over
  them is `invalid`, an approval over them fails its proposal, and a v2 fold
  over them takes the oversize form (Team sync).
- **Determinism.** The result depends only on the three bodies, their ids and
  the constant `MERGE_ALGO = 'diff3-patience/1'`. Equal inputs give equal bytes
  on every replica.
- **Where it runs, and the cache.** A whole-body save or an approval runs one
  merge. `GET /api/docs/:ref/diff` runs one diff. The proposal card's "merges
  cleanly" runs one merge per (proposal revision, head id) pair, cached in an
  LRU of 256 entries, so re-rendering a card never recomputes it. v2 folds run
  one merge per pair of heads. `doc_read`, index lines and search never diff.

## Reaching agents

### The `## Docs` prompt index

`buildTaskPrompt` (`orchestrator/prompt.ts:41-53`) gains a trailing
`docsSection: string | null = null` argument, rendered after the memory section
(which replaces the ledger section at `:75-76`, memory :690-693), or after the
ledger section before memory lands. `promptForTask`
(`orchestrator/orchestrator.ts:4937-4958`) asks the docs service for it inside a
`try`: a failure costs the section, never the dispatch, as orientation's does
(`:4960-4965`). From v1 it passes the run's operator.

- **Candidates:** non-archived docs the run may see, in rank order, each once at
  its best rank:
  1. the task's `spec`;
  2. ancestors' `spec` links, nearest first, walking `parent` at most 8 levels;
  3. the task's `plan` links, then ancestors' `plan` links, nearest first;
  4. the task's `context` links and the `[[slug]]` mentions in its body, newest
     update first;
  5. ancestors' `context` links, nearest first, then newest update;
  6. ties by id.
- **A2A-provenance runs** get only team docs linked to their own task: no
  ancestors' links, no body mentions, no personal docs.
- **Lines:**
  `- <tag> · <handle> · <status>[ · unreviewed][ · conflicted][ · you] · rev <n> · <size> KB: <title>: <summary>`
  - Tags: `spec`, `plan`, `context` for the task's own links; `parent …` for the
    direct parent's; `ancestor …` above it.
  - `unreviewed` follows Review state, as memory marks agent trust (memory
    :486-488). `you` marks a personal doc of the run's operator, whose handle is
    written `~slug`.
  - Title cut to 80 characters; summary the first 120 bytes of the first
    paragraph that is not a heading, cut on a character boundary. Both pass
    through `untrustedInline` (`packages/core/src/untrusted.ts:18-20`).
- **Budget:** `docs.indexTokens`, estimated as `ceil(utf8Bytes / 3)` (memory
  :663-665). Lines are added in rank order until the next would cross the
  budget, reserving room for the header and the overflow line
  `(N more linked docs; doc_list() lists them)`. The spec line always shows.
- **No docs, no section.** Bodies are never inlined for runs that have the
  tools.

```text
## Docs
Documents linked to this task and its parents, one line each. Read one with
doc_read("<slug>"), or one section with doc_read("<slug>", section: "<heading>");
doc_search searches every doc you can see. Change a doc with doc_save; an edit
to an accepted doc is proposed for review. "unreviewed" docs hold agent text no
human has reviewed.
- spec · auth-refactor · accepted · rev 12 · 18 KB: Auth refactor: Replace session cookies with signed tokens; the /sessions …
- plan · auth-refactor-plan · draft · unreviewed · rev 4 · 31 KB: Auth refactor plan: Five tasks, stacked …
- parent spec · open-core-plan · accepted · rev 40 · 92 KB: Open-core plan: The epic splits into four waves …
(2 more linked docs; doc_list() lists them)
```

**Executors without the dispatch MCP server**
(`ExecutorProfile.dispatchMcp: false`, `orchestrator/types.ts:201-203`;
`prompt.ts:48-50`) cannot call `doc_read`. Their variant drops the tool
sentences and the overflow hint, keeps the lines, and inlines one body: the
task's spec, else the nearest ancestor's (for an A2A-provenance run only the
task's own spec, never an ancestor's), as
`untrustedVerbatim('doc <handle> rev <n>', body)` (MCP tools), cut at
`docs.inlineSpecBytes` on a line boundary with
`[cut by Dispatch at 16 KiB of N bytes; the rest is in Dispatch]`. The fence
gives a 16 KiB body a visible end. The inline does not count against
`indexTokens`.

Review, verify, planner, enrich and draft prompts get no docs section until
v1.1, when review and verify prompts gain the task's spec line (O1; Staging task
23).

### MCP tools

Five tools, the same for runs and external agents, in `packages/mcp` beside the
messaging tools (`registerMessagingTools`, `packages/mcp/src/messaging.ts:572`).
They authenticate like `msg_*`, through `identity.ts`.

| Tool                                                                   | Returns                                                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `doc_list(task?, scope?, status?, query?, includeArchived?, limit?)`   | visible docs: handle, title, scope, status, rev, size, updated by and at, rel to the task                       |
| `doc_read(doc, section?, rev?, offset?)`                               | header, outline with anchors and sizes, and one page of at most 32 KiB, fenced                                  |
| `doc_search(query, scope?, limit?)`                                    | section hits: handle, anchor, heading, snippet                                                                  |
| `doc_save(doc?, ops?, body?, baseRev?, title?, slug?, scope?, links?)` | `{ doc, handle, rev, status: saved \| amended \| merged \| proposed \| unchanged, rebased?, proposal?, gate? }` |
| `doc_link(doc, target, rel?, remove?, replace?)`                       | the doc's links                                                                                                 |

- `doc` is an id or handle, optionally `handle#anchor`. `target` is written
  `task:t-…`, `run:r-…`, `thread:m-…`, `memory:mem-…` or `doc:<handle or id>`.
- **Text other principals wrote never reaches the agent unmarked.**
  - The page is fenced with `untrustedVerbatim('doc <handle> rev <n>', text)`, a
    new `@dispatch/core` helper. `untrustedFenced` escapes every line holding
    four or more tildes with a backslash (`untrusted.ts:10`, `:34-37`), so a doc
    read through it and saved back whole would gain backslashes, and a `find`
    copied from it would not match. `untrustedVerbatim` uses the same labelled
    fence, widens the bar until it is longer than the longest tilde run in the
    text, and alters no line.
  - Everything outside the page passes through `untrustedInline`: the header's
    title, author and summary, every outline heading, link titles, `doc_list`
    titles, and `doc_search` headings and snippets.
  - A `doc_save` conflict's rendered hunks (at most 16 KiB) sit inside one
    `untrustedVerbatim('conflict hunks', …)` fence.
- **`doc_list`** from a run with no `task` lists its own task's docs in index
  rank order. From an external agent with no `task`, the most recently updated
  visible docs (default 20, at most 100).
- **`doc_read`** pages: `offset` is a byte offset on a line boundary; the result
  gives the next one while more remains. `section` pages within that section.
  The header carries the head `{ id, n }`, `unreviewed`, the links, and the
  caller's own open proposal, if any, as `rev-…` to read with `rev`.
- **`doc_search`** returns at most `limit` hits (default 10, at most 50),
  grouped by doc, at most 3 sections per doc, ranked by `bm25` with weights
  title 5, heading 3, text 1. Each query term is double-quoted, so FTS syntax
  cannot change the query (memory :637-641).
- **`doc_save`** has three modes, one per call:
  - no `doc`: create, with `title` and `body` (ops are invalid here); `scope`
    defaults to `team` (`personal` means the caller's operator); for a run,
    `links` defaults to `[{ target: 'task:<its task>', rel: 'context' }]`;
  - `doc` and `ops`: anchored edits (Anchored edits);
  - `doc`, `body` and `baseRev`: a whole-body save (Whole-body saves). A
    conflict is a tool error with the fenced hunks and "Re-read with doc_read
    and edit with ops, or save against rev N."
  - `ops` with `body` is invalid.
- **Descriptions** say: edit with ops so edits survive a human's concurrent
  edit; every revision is attributed and can be reverted; edits to accepted docs
  are proposed for review.
- **Retries.** Writes send an `Idempotency-Key` and retry a dropped connection
  once, like `msg_send` (messaging :498).
- **Registration.** `DISPATCH_MCP_TOOLS`
  (`packages/core/src/dispatchMcpTools.ts:3-21`) gains the five, so Codex runs
  pre-approve them by name (messaging :513-515).
- **Overseer.** Two in-process status tools, `docsTool` (list and search) and
  `docReadTool`, join `OVERSEER_STATUS_TOOLS`
  (`orchestrator/overseerTools.ts:425-433`), acting for the owner. The overseer
  does not write docs.

### Live notices

While a run is live, a change to a **team** doc it cares about reaches it in one
line (Q7):

- **Which runs:** live execute runs that may see the doc, other than the
  change's author, where the doc is linked to the run's task or an ancestor, or
  the run has read it with `doc_read` since it started. Those reads are kept in
  process per run and dropped when the run ends.
- **Never for personal docs.** `notifyRun` appends the line to the run's
  transcript and broadcasts it as a `run.log` event to every socket
  (`orchestrator/orchestrator.ts:586-599`), teammates' sockets included on a
  shared host. A personal doc's handle comes from its title, so a notice would
  publish it, against `doc.changed`'s rule of no id for personal docs (Events)
  and memory's rule that personal memory makes no notices (memory :722, :1607).
  A run reading its operator's personal doc sees changes on its next `doc_read`.
- **When:** when a revision by someone else seals or becomes a sealed head: a
  sealed edit, merge, approve, revert, restore or sync. At most one per doc per
  run every `docs.noticeMinutes`; a change inside the window sets a pending
  flag, and one trailing notice goes out when it closes if the head still
  differs from the last notified. Proposal decisions, expiry and withdrawal
  reach the proposing run at once.
- **How:** `orchestrator.notifyRun(runId, line)`, the path messaging's channel
  digests and memory's live notify take (memory :720-734). It is never stored in
  `messages.db`, held or retried. `notifyRun` throws for a run that is not live,
  is stopping, or cannot take mid-run input (`requireDeliverableRun`, `:521`);
  the notice is dropped, and a later run sees the current revision in its index.

```text
📄 doc · auth-refactor rev 13 by human:wyat: replaced "## API" (doc_read to see)
📄 doc · auth-refactor: your proposal was rejected by human:wyat: keep the v1 shape
```

Handle, author, summary and reason pass through `untrustedInline`; the line is
cut to 160 characters.

## Search

- `GET /api/docs/search?q=&scope=&includeArchived=&limit=` searches section text
  of visible heads, as `doc_search` does, returning
  `{ doc, handle, title, anchor, heading, snippet, score }`.
- Snippets are FTS5 `snippet()` over `text`, at most 24 tokens; rank is `bm25()`
  ([SQLite FTS5](https://www.sqlite.org/fts5.html)); the tokenizer is memory's
  `porter unicode61` (memory :544-545).
- Visibility is a join on `docs`, so personal docs appear only to their owner's
  principals.
- The ⌘K palette (`components/shell/CommandPalette.tsx:57-65`) gains a Docs
  section in `lib/paletteSections.ts` (`:24-40`), after Tasks.

## The boundary with memory

|                  | Memory (#2)                                     | Docs                                    |
| ---------------- | ----------------------------------------------- | --------------------------------------- |
| Purpose          | Recall: lessons, constraints, preferences       | Reference: specs, plans, ADRs, runbooks |
| Size             | ≤ 8 KiB (memory :427)                           | ≤ 768 KiB, sectioned                    |
| Reaches a prompt | Ranked into every run's index                   | One line, only where the task links it  |
| Lifetime         | Stale at 60 days, retired at 180 (decisions :9) | Kept until archived                     |

- A memory entry may ref a doc section, `{ type: 'doc', id, at }`: the lesson in
  the entry, the detail in the doc. A shared entry never refs a personal doc.
- Docs never enter the memory index, and memory never inlines a doc.
- **Overflow (v1, Q14), for project-keyed personal entries only.** When memory's
  Claude ingest or import would cut a body at 8 KiB (memory :1403-1406) and the
  entry is personal with a `projectKey` equal to this project (memory :319,
  :453-457), the full text becomes a personal doc owned by the entry's human,
  `origin: 'memory:<mem-id>'`. The entry refs it by id, and the cut line becomes
  `[truncated by Dispatch: N bytes; full text in doc doc-… of project <projectKey>]`.
  It names the id and project, never a slug, since a slug can change and names
  nothing in another project.
- **Every other truncation stays plain truncation:**
  - cross-project personal entries (`projectKey` null, the default, decisions :9
    Q2): a doc in one project's `docs.db` is unreachable from the others;
  - project and team entries, including the `supersede` proposals ingest makes
    for them (memory :1414-1419): a shared entry must not point at text only one
    human can read (Scopes and status);
  - ledger import rows, which are team entries often authored `agent:dispatch`
    and have no entry human (memory :1004-1016).
- **`memory_save` over 8 KiB** is refused with the hint "long-form belongs in a
  doc: doc_save it, then ref it from a short entry".
- The ledger's `decision` rows go to memory (decisions :9, Q1); a decision's
  long rationale is an ADR doc its entry refs. The brain-dump inbox stays
  capture-to-task (memory :1767).

## Durability and the repo

### Receipts (v1, Q11)

The receipt log is the git-versioned projection of the daemon's state
(`docs/TEAM-SERVER.md:102-112`), and its restore is "the executable form of the
promise that this log is enough on its own"
(`packages/core/src/receipts.ts:580-588`). Docs are authored content, so they go
in and come back out.

- **Export.** `ReceiptsExporter` (`packages/server/src/receipts/exporter.ts`)
  gains optional extra steps, each `(dir) => { changed; removed; problems }`,
  run after `materializeReceipts` (`:138`) and before `git add -A` (`:158`),
  with their counts added to the pass result. The docs step writes
  `.dispatch/docs/<handle>.md` for every **team** doc (draft, accepted,
  archived) from its newest sealed head revision; the file is named by handle,
  which is unique in the team namespace even after a v2 slug claim. Personal
  docs never go in, since receipts can be pushed to a remote
  (`packages/core/src/configTypes.ts:100-126`).
- **The step never deletes the only copy.** `git add -A` stages a missing file
  as a deletion, and a pushed log carries it to the remote, so the step is
  conservative, as `materializeReceipts` keeps a task's file when its row cannot
  be read (`receipts.ts:283-288`):
  - **Docs not open** (the unavailable mode, a newer schema, an older build's
    turn): the step touches nothing under `.dispatch/docs/` and records one
    problem, "docs store unavailable; .dispatch/docs left as it was". It never
    throws, so the tasks' pass goes on (`exporter.ts:120-134`).
  - **A staged restore not fully applied** (files left in `docs-restore/`): it
    writes the docs it holds and removes nothing, with a problem naming the
    pending files.
  - **Otherwise** it removes only files of docs `docs.db` knows: renamed ones
    (the old handle's file), personal ones, and tombstoned ones. A file whose
    `id` `docs.db` does not know at all is kept, with a problem: "receipt file
    for unknown doc \<id>; run dispatch receipts restore, or delete the file". A
    fresh or recreated `docs.db` therefore never prunes the log.
- **Older builds leave the files alone.** A build without the docs step never
  deletes `.dispatch/docs/`: `materializeReceipts` prunes only `.dispatch/tasks`
  and `.dispatch/evidence` (`receipts.ts:49-52`, `:313`, `:387`), and untouched
  files stage nothing.
- **Boot.** `openDocs` runs, and applies `docs-restore/`, before the boot export
  (Boot order), so a restored machine's first pass already writes its docs.
- **File format.** YAML frontmatter whose values are JSON scalars and arrays
  (valid YAML 1.2, so they round-trip exactly): `id`, `slug`, `title`, `status`,
  `rev` (id), `n`, `parents`, `author`, `cause`, `createdAt`, `hash`, `links`
  (the doc's team-visible links), `authors` (distinct authors of the head's
  ancestry, at most 20), `updatedAt`. Then the body, with `asset:` image links
  left as references; the images themselves stay on the machine.
- **When.** Team doc seals, reviews, status, link, rename and delete call
  `ReceiptsScheduler.notifyChanged()` (`receipts/scheduler.ts:130`). Receipts
  exist only on the database backend (`receipts.ts:108-118`); files-backend
  projects use `dispatch docs export` (O4).
- The core README string (`receipts.ts:212-252`) gains the line
  `.dispatch/docs/<handle>.md  team documents, their head revision` and a note
  that docs come back through `dispatch receipts restore`.
- **Restore.** `dispatch receipts restore`
  (`packages/cli/src/commands/receipts.ts:43-105`) runs with the daemon stopped.
  Before it removes its clone, it copies the clone's `.dispatch/docs/` into
  `docs-restore/` under the project's run-state directory (the CLI's
  `daemonHome` and `daemonFileKey`, `packages/cli/src/commands/daemon.ts:51-57`)
  and prints the count. When the docs service next opens (Boot order), it
  restores each staged file:
  - a doc whose id is held, or tombstoned, is skipped, the rule the task restore
    already follows (`packages/cli/src/commands/receipts.ts:79-80`);
  - a file whose `hash` does not match its body is a problem;
  - otherwise the doc is created with one head revision that keeps its revision
    id and recorded parents, cause `restore`, and `provisional` set.
- **A restored doc is not trusted as reviewed or accepted.** The frontmatter
  comes from a git-pulled file that says whatever its writer put there, as
  memory says of ledger lines (memory :1017-1023):
  - the revision is tainted, so the doc is `unreviewed` until a decide-tier
    human reviews it;
  - its author is shown "as recorded in the receipt log";
  - a file that says `accepted` comes back as a `draft` with
    `restored: { status: 'accepted' }`. The doc page offers "Accept again", and
    `dispatch docs accept --restored` accepts every such doc at once, both
    decide tier. `archived` comes back archived.
- **Provisional revisions** wait for sync to confirm or adopt them (Team sync).
  On a project that never syncs they stay provisional harmlessly: nothing reads
  the flag but sync.
- The report goes to `meta` and `GET /api/docs/health`. The staging directory is
  removed when every file restored or was skipped, and kept while any failed.
  Earlier revisions stay in the receipt log's git history.

### Export

`dispatch docs export <dir>` writes every doc the caller can see as
`<dir>/<handle>.md` (personal docs under `<dir>/personal/`) in the receipts file
format, readable outside Dispatch (N6). Images a doc links are copied to
`<dir>/assets/<doc id>/`, and `asset:` links are rewritten to those relative
paths. `--rev-history` adds `<dir>/.history/<handle>/<n>.md` for every sealed
revision.

### Publish to repo (v1, Q12)

A doc reaches the repo only as an ordinary task and run, so it lands by PR and a
human's merge, and the repo copy is never read back.

1. `POST /api/docs/:ref/publish { path, dispatch? }`, from a human at request
   tier or above, on a **team** doc (a personal doc is 403) that is `accepted`,
   or whose head is not `unreviewed`. An unreviewed draft is 409 "review it
   first", so agent text no human checked never heads for the repo.
2. **Path rules.** `path` must be repo-relative POSIX, end in `.md`, stay inside
   `rootDir` with no `..` and no symlinked component, and not lie under `.git/`,
   `.dispatch/`, `.agents/`, `.claude/` or `.github/`. A file named `AGENTS.md`
   or `CLAUDE.md` anywhere, in any case, is refused: those files instruct every
   future run, and CI workflows run code, so they change through ordinary tasks.
   The last path is remembered.
3. The route seals the head and creates a task titled
   `Publish doc <slug> (rev <n>) to <path>`, with `writes: [path]` (plus
   `<path without .md>.assets/` when the doc has images), **risk `elevated`**,
   the doc linked `context`, and a body saying what the run does. Risk
   `elevated` caps the rung at 3 (`policy.ts:82-86`), and `merge` is a rung-4
   gate (`:67-73`), so a human always merges a publish, even at rung 4. It
   records a `publishes` row. With `dispatch: true` (the desktop's default) it
   dispatches at once. A second publish while one is open answers 409 naming its
   task.
4. `Orchestrator.dispatch` gains an optional `worktreeSeed(task, wtPath)` hook,
   called right after `this.worktrees.add` (`orchestrator/orchestrator.ts:814`).
   The docs service sets it; for a publish task it re-checks the path against
   `<wtPath>` (each existing component resolved with `realpath` must stay under
   `<wtPath>`, and none may be a symlink), then writes the recorded revision's
   body there through a temporary file and a rename. Referenced images are
   copied to `<path without .md>.assets/<sha256>.<ext>`, and their `asset:`
   links rewritten to those relative paths. If the seed throws, the worktree is
   removed and the dispatch fails with the reason, as a failed `add` does.
5. The run formats and lints the file with the repo's own tools, fixes only
   formatting, and commits `docs: publish <slug> rev <n>`. No model copies a
   long document by hand.
6. When the task becomes `landed`, the service records
   `published: { path, rev, task, commit }`, with `commit` from
   `git log -1 --format=%H <base> -- <path>`; `dropped` marks the row dropped.
   The doc page then shows "published rev N to `<path>`; head is rev M" while
   the copy is behind.

### Import (v0, Q13)

Existing markdown comes in only by an explicit command with a count-parity
report, the owner's migration rule. It is a staged session, because this repo's
own specs and plans are larger than one request: 3,325,417 bytes of distinct
content at 17:00 on 2026-09-26, against the 2 MiB request bound.

- `dispatch docs import <files…> [--link task:t-…] [--dry-run]` reads the files
  on the caller's machine, so the daemon never reads arbitrary paths. It needs a
  **decide-tier human**: import backdates `createdAt`, bypasses
  `createsPerHour`, and writes history under the importer's name. Memory's
  ledger import is decide tier for the same reason (memory :1668).
  1. `POST /api/docs/imports {files: [{path, name, mtime, bytes, hash}], link?}`
     opens a session and answers `{ id, need: [hash…] }`: the contents not
     already imported and not yet uploaded.
  2. `PUT /api/docs/imports/:id/contents/:hash` uploads one content per request,
     read with its own 8 MiB bound; the daemon checks its sha256. A file over 8
     MiB is not uploaded and counts as a `too-large` error.
  3. `POST /api/docs/imports/:id/commit?dryRun=1` computes the parity report.
     Without `dryRun` it runs the checks and every write in one
     `BEGIN IMMEDIATE` transaction and closes the session. `--dry-run` commits
     with `dryRun=1` and then deletes the session
     (`DELETE /api/docs/imports/:id`).

  Sessions live in `import_sessions` and `import_contents`, at most 64 MiB of
  contents each and one open per human; the sweep removes sessions idle for 24
  hours.

- **Slug** is the file name without `.md` through `docSlug`, keeping the date
  prefix (`2026-09-25-memory-design`), so distinct names stay distinct docs.
  **Title** is the newest content's first `#` heading, else the slug.
- **Copies.** Files of one name with identical content collapse into one. Files
  of one name with different content become revisions of one doc in mtime order,
  cause `import`, `createdAt` the mtime, author the importing human; the newest
  is the head. Nothing is lost.
- **Over the cap: split, not refused.** A content over the body limits is cut
  before the last `##` heading outside code fences that keeps the part within
  them, else the last `###` one, else the last blank line, else the last line
  break. Part 1 keeps the name's slug and title; part k is `<slug>-part-<k>`,
  titled `<title> (part k of n)`, with `origin` `import:<slug>/part-<k>`. Each
  part links the previous and the next as `context`, and nothing is added to the
  text. A drifted copy of the same name splits the same way, and its parts
  become revisions of the same part docs.
- **Re-import** of a name adds only contents whose original hash is not in
  `imported`, so a split content is recognized by the hash of the file, not of
  its parts. `origin` is `import:<slug>`; a tombstoned origin is skipped.
- **Parity report:** files, names, distinct contents, docs created, docs
  existing, part docs created, contents imported, split contents, revisions
  created, duplicates skipped, already present, tombstoned, and errors, each
  named with its reason (`invalid`, `too-large`, `not UTF-8`). Two identities
  are checked:
  - files = duplicates + contents imported + already present + tombstoned +
    errors, where a duplicate is a file whose name and content repeat an earlier
    file's;
  - names = docs created + docs existing + tombstoned names + names whose every
    file failed.

  Part docs are reported but counted in neither identity. A mismatch rolls the
  transaction back and exits non-zero.

- `--link` links every imported doc as `context`, subject to the link rules.
- **As built (v0).**
  - A name is keyed by its file name without `.md`, not by its slug, so
    `Design Notes.md` and `design-notes.md` stay two docs: `origin` is
    `import:<name>` and `import:<name>/part-<k>`, and the `imported` rows hold
    the name (their column is still called `slug`). The slug is still
    `docSlug(name)`, suffixed on a clash.
  - Two more error reasons: `archived`, for a new content of a name whose doc is
    archived ("restore it first"), and `missing`, for a content never uploaded
    or a path the CLI could not read. Both count as errors in the identities.
  - Only part 1's archive refuses. A re-import that fills an archived part k > 1
    writes its new head and restores it: an import owns its part docs' status.
  - When the newest content needs fewer parts than an earlier one, the parts
    past it are archived and unlinked from the last live part. The walk stops at
    the first part number with no doc, so a part past a deleted one stays live.
  - "The newest is the head" holds within one session. An older drifted copy
    imported in a later session becomes the head, and the part docs follow it.

After v1, AGENTS.md "Agent Artifacts" sends agents' plans and specs to Docs
through `doc_save` (the MCP tool), linked to their task, and keeps
`.agents/ignore/` for scripts, logs and downloaded data. It does not tell agents
to use `dispatch docs new`: the CLI authenticates only with `--token`,
`DISPATCH_APP_TOKEN` or a teammate token, and deliberately never reads a token
an agent could reach (`packages/cli/src/commands/appToken.ts:21-23`), so the
command is for humans. This repo's specs are then imported, dry run first. The
corpus changes as worktrees come and go (92 files, 49 names and 60 contents on
the morning of 2026-09-26; 61 files, 47 names and 58 contents by 17:00), so the
report must match a read-only count taken the same day.

## Team sync (v2, ELv2, Q10)

A shared host needs nothing: teammates' tokens reach one daemon and one
`docs.db` (`team/teammates.ts:20-32`). Synced boards replicate team docs over
federation's signed `doc` op, which federation already defines: `OpType`
includes `'doc'` (fed FederatedOp), the op table routes it to every replica from
F3 (fed Op types), and fed decision 36 leaves its body and fold to this spec.
Federation's task 20 supplies the op's routing, Speaks for and parking (fed
Staging; Team memory and docs (F3)); this spec's task 20 builds the rest on it.
It never ships unsigned.

```ts
// @dispatch/protocol/federation (MIT; fed Plain bodies, Licensing): FederatedOp.body for type 'doc'
interface DocBody {
  doc: string; // doc-<ulid>
  kind: 'put' | 'remove';
  by: Address; // who made this change
  revision?: {
    id: string;
    parents: string[];
    title: string;
    body: string;
    hash: string;
    author: Address;
    cause: RevisionCause;
    summary: string;
    createdAt: string;
    approval?: { by: Address; policy?: { rung: number } };
    task?: string; // a proposal's source task, for local policy
  };
  meta?: {
    slug?: string; // the claimed slug in the team namespace
    aliases?: string[]; // retired slugs; a grow-only set
    title?: string;
    status?: DocStatus;
    links?: { target: LinkTarget; rel: DocLink['rel'] }[];
  };
  review?: { rev: string }; // `by` reviewed that revision
}
```

- **What travels:** team docs only; every grounded sealed revision reachable
  from a team doc's head, including the proposal revisions approve and reject
  revisions name, and every sync merge (below); `meta` fields, last writer wins
  per field on the op's clock, like task fields, except `aliases`, which merge
  as a union; reviews, as a grow-only set; `remove` with a tombstone clock,
  where a later revision revives the doc, as a later edit revives a task
  (`team/boardSync/engine.ts:20-23`).
- **What never travels:** personal docs, open revisions, provisional revisions
  until confirmed or adopted (below), open or rejected local proposals, notices,
  publishes, and assets (a reference travels; elsewhere the preview says "image
  not on this machine"). Links to runs and threads travel as ids and show "not
  on this machine" where they do not resolve.
- **Signed authorship.** A revision's `author`, and `by`, are checked with
  federation's Speaks for (fed Speaks for) through its
  `speaksFor(replica, address)` export (fed Team memory and docs (F3)). One the
  publisher cannot speak for is kept, marked `via <replica>`, and tainted
  (Review state). A `status` or `review` whose `by` is not a human the publisher
  speaks for is dropped with a sync problem, since only humans make them. So is
  a `meta.links` change that the link rules reserve for decide-tier humans
  (displacing an accepted `spec` or `plan`, or linking an A2A-origin task): a
  remote principal's tier cannot be checked across daemons (fed Speaks for, "No
  deciding across daemons"), so it counts only from a human the publisher speaks
  for.
- **Revisions are immutable,** so replicas take the union. One whose parents
  have not arrived waits in `fed_parked` under federation's retention rule (fed
  Speaks for, "Checks that wait"): retried every pass with no time limit, and
  dropped with a problem only when its publisher is revoked below it or has more
  than 10,000 parked ops. Doc ops are board ops, kept on the branch and the
  relay for the team's life (fed The sync branch; Relay (F4), "Retention"), so
  an overflow drop is recoverable: the docs module records the dropped op's
  `(replica, seq)` in `sync_missing`, and when a later op names the missing
  revision as a parent, or `dispatch docs sync repair` runs, it asks federation
  to re-read those ops (`rereadOps`, a hook this spec adds to federation;
  Changes to other specs). A drop for revocation is final. One whose id is
  already stored with a different hash keeps the stored one and is recorded as a
  sync problem, unless the stored one is provisional (below).
- **Grounded revisions.** A revision is grounded when it is not provisional and
  every parent is stored and grounded; a root (`parents: []`) is grounded. Only
  grounded revisions are folded, used as merge bases, or published. An
  ungrounded head stays the local head for local writes but is not folded with
  other heads or published until it is grounded, and the doc page says "waiting
  for history from teammates". So a replica with incomplete ancestry never
  computes a different base for a pair than a replica with all of it.
- **Restored revisions** (Receipts) are provisional:
  - a signed revision arriving with the same id replaces it: author, parents and
    body come from the op, and the flag clears. If the bodies differ, the doc
    gets a sync problem, and local revisions built on the restored one keep
    their own bodies;
  - otherwise, after the first complete federation pass that follows the
    restore, it is adopted: the recorded parents that no replica's log supplied
    are dropped from its parent list (kept in `restored_parents` for the history
    view), and it becomes grounded. Only this replica holds it, so the rewrite
    conflicts with nobody. It and its descendants are then published.
- **Converging heads.** The heads are the grounded stored revisions with no
  stored children, leaving out revisions held back (below). With more than one,
  the replica sorts them by id and folds them pairwise.
  - A pair's base is their common ancestor with the latest `createdAt`, ties by
    id; with no common ancestor, the empty body, whose id is written `-`.
  - The merge revision's id is `rev-` plus the first 26 Crockford base32
    characters of
    `sha256(MERGE_ALGO + '\n' + baseId + '\n' + sortedParents.join('\n'))`. Its
    author is `agent:dispatch`, its cause `sync`, its `createdAt` the later
    parent's, and its markers carry revision ids only (Merge). The id names the
    base, both parents and the algorithm, and the merge depends on nothing else,
    so one id always means one body.
  - **Every sync merge is published.** A replica that computed the same id reads
    the arrival as a duplicate, and a replica that folded in a different order
    never has to recompute an unpublished merge from its id.
  - **Oversize folds.** When a fold's body would exceed the body limits, the
    fold stores the body of the parent with the lower id with one marker block
    of at most 512 bytes before it:

    ```text
    <<<<<<< rev-<kept parent>
    =======
    >>>>>>> rev-<other parent> (too large to merge; read it with doc_read(rev: "rev-<other parent>"))
    ```

    It is flagged `conflicted`. Since the kept body met the limits, the result
    stays within one op, and every replica builds the same bytes whatever the
    arrival order.

- **A conflicting sync merge still becomes the head,** with the marked body and
  `conflicted` set; the desktop Inbox shows a derived item for it (not a gate),
  the index marks it, and a human's save clears it.
- **Slug claims.** `meta.slug` is a doc's claimed slug. When two team docs claim
  one slug (concurrent creates or renames, or one replica reusing a slug another
  retired), the doc with the lower id keeps it as its handle. The other doc's
  handle becomes
  `<slug cut to 57>-<the last 6 characters of its id, lowercase>`, lengthened to
  12 characters and then the whole id if that too is taken. A live claim beats
  an alias; among aliases, the lowest id resolves. Handles are recomputed in the
  apply transaction for the docs involved and are never published, so every
  replica holding the same docs holds the same handles, and applying an op never
  fails on uniqueness. The losing doc's page says "slug taken by \<other>;
  renamed here". Local creates and renames still check uniqueness as before.
- **Accepted docs keep their gate across replicas** (options §4.9; memory's
  counterpart is fed Team memory and docs (F3), "Local policy still applies").
  When the doc is `accepted` here, an arriving non-sync revision R that is not
  an ancestor of the head is **covered** when its author is a human the
  publisher speaks for; or an arriving `approve` revision descending from R has
  `approval.by` a human the publisher speaks for; or that approve revision
  carries `approval.policy` and this daemon's own `doc` policy, for R's `task`
  risk, also rules `auto`. An uncovered R, and the revisions descending from it,
  are **held back**: out of the head, as one open `doc` proposal with
  `origin: 'sync:<replica>'`, gated here as a local proposal is. Its tip is the
  one held-back revision with no held-back children; if they branch, the
  branches are folded first by the rule above.
  - **Approve here:** an `approve` revision with parents `[head, tip]`, as a
    local approval.
  - **Reject here:** a `reject` revision with parents `[head, tip]` whose body
    is this head's body, authored by the rejecting human. It travels, and every
    replica's next fold, whose base for that pair is the tip, removes the
    rejected change for everyone. The gate card says "rejecting removes this
    change for every teammate" and lists the held revisions with their authors
    (O2).
  - While held back, this replica's head differs from the publisher's. That is
    the point of the gate, and it converges on the decision. A concurrent
    approve on one replica and reject on another converge on the reject.
- **Seats.** Replication pauses past the seats, as for every op type (fed
  Seats).
- **Files-backend projects do not sync docs:** federation runs on the database
  backend with `sync.enabled` (fed Scope; Architecture, "Nothing changes until a
  team is founded").

## Linear documents (v2, after parity P2, Q16)

Linear's `Document` has `content`, "The document's content in markdown format",
and a parent among project, initiative, issue, cycle, team and release
(`Document.release`, with `releaseId` on `DocumentCreateInput` and
`DocumentUpdateInput`); `contentState` is "[Internal]" Yjs state and is ignored.
`documentCreate` and `documentUpdate` take `content` as markdown;
`DocumentCreateInput` takes `projectId` and `issueId`, and `initiativeId` and
`cycleId` only as "[Internal]"
([schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql),
fetched 2026-09-26).

- **Pull.** The P2 sync pass (`packages/server/src/linear/sync.ts`) also queries
  documents updated since its cursor. A new one becomes a team draft,
  `origin: 'linear:<documentId>'`, slug from its title, linked `context` to the
  task its parent maps to (containers are tasks after parity P1); a cycle, team
  or release parent maps to no task, and the doc is unlinked.
- **Merge.** `linear_docs` keeps the last synced revision as the base. An
  incoming change is merged against the local head with the same diff3, authored
  by the Linear user mapped through the people registry, else `agent:dispatch`
  (tainted either way: Linear authorship is not a Dispatch human's). Clean is a
  revision (cause `sync`); a conflict is a conflicted head; a result over the
  limits is a conflicted head in the oversize form. A change to an **accepted**
  doc is a `doc` proposal (`origin: 'linear:<documentId>'`), since Linear's
  editors are not decide-tier Dispatch humans.
- **Push.** `documentUpdate(id, input)` replaces `content`, and
  `DocumentUpdateInput` has no base version or `updatedAt` precondition, so a
  push cannot be conditional and a check-then-write can overwrite a Linear edit.
  The adapter narrows the window and then detects what it could not prevent:
  1. Immediately before writing, it re-reads `updatedAt` and `content`. If
     either moved since the base, it pulls first (the merge above) instead of
     pushing.
  2. It sends `documentUpdate` with the sealed head's markdown.
  3. It re-reads `content`, `updatedAt` and `documentContentHistory(id)`.
     - If the content differs from what it sent, that is a Linear edit made
       after the write: it is merged in as an incoming change against the pushed
       content (a revision, or a proposal on an accepted doc), and the base
       advances to what was pushed.
     - If the history entry the write created snapshots a state newer than the
       `updatedAt` read in step 1 (`contentDataSnapshotAt`, with `actorIds`
       naming someone other than the integration's user), a Linear edit landed
       between the read and the write and was overwritten. The doc gets a sync
       problem and a derived Inbox item naming the Linear user and time and
       pointing at Linear's version history. The overwritten text is not merged
       back automatically: the history API returns that version as
       `contentData`, "[Internal]" ProseMirror JSON, beside an unspecified
       `metadata` object "including content diffs"
       (`DocumentContentHistoryType`), and neither is a contract to build a
       merge on.
- **Only docs that came from Linear push back.** "Share to Linear" (a
  decide-tier human, on a doc linked to a task mapped to a Linear project or
  issue) calls `documentCreate` with that `projectId` or `issueId` and makes the
  doc Linear-origin. Team docs do not leak to Linear by default.
- Echo suppression and the rate-limit pause are P2's own.

## Transport

### Routes

Daemon routes (FSL). Every one joins `SELF_AUTHENTICATED_ROUTES`
(`api.ts:4336-4361`): the caller is resolved to a principal (Principals) before
any handler runs. `:ref` is a doc id or handle (`~slug` URL-encoded for a
personal doc).

```text
GET    /api/docs?taskId=&scope=&status=&unreviewed=&conflicted=&q=&limit=   visible docs (default 50, at most 200)
POST   /api/docs                                  create {title, body, slug?, scope?, links?}
GET    /api/docs/search?q=&scope=&includeArchived=&limit=
GET    /api/docs/index?taskId=                    the ## Docs lines a run of that task would get, the caller as operator
GET    /api/docs/links?target=<type>:<id>         docs linking to a target
GET    /api/docs/proposals?state=&doc=            proposals the caller may see (Who sees what)
GET    /api/docs/proposals/:rev                   content, diff against its base, mergeable against the head (cached)
GET    /api/docs/health                           humans: store, search mode, size, config warnings, sweep; decide tier also: restore report, orphans
POST   /api/docs/imports                          decide tier: open an import {files:[…], link?} → {id, need}
PUT    /api/docs/imports/:id/contents/:hash       one content, 8 MiB bound
POST   /api/docs/imports/:id/commit?dryRun=1      the parity report; commits without dryRun
DELETE /api/docs/imports/:id
GET    /api/docs/:ref?rev=&section=&offset=       doc, links, outline, and the body or one page of it
PUT    /api/docs/:ref/body                        {baseRev, baseHash?, body, title?}: 200, or 409 DocConflict
POST   /api/docs/:ref/edit                        {ops, baseRev?}
PATCH  /api/docs/:ref                             {slug}
POST   /api/docs/:ref/status                      {status}
POST   /api/docs/:ref/reviewed                    decide tier (team); review the head
POST   /api/docs/:ref/seal                        save version
POST   /api/docs/:ref/revert                      {rev}
GET    /api/docs/:ref/revisions?limit=&before=    history without bodies, revisions with an n only (default 50, at most 200)
GET    /api/docs/:ref/revisions/:rev              one revision with its body; proposal revisions per Who sees what
GET    /api/docs/:ref/diff?from=&to=              a line diff between two revisions, same visibility
POST   /api/docs/:ref/links                       {target, rel, replace?}
DELETE /api/docs/:ref/links/:type/:id
POST   /api/docs/:ref/promote                     personal → team copy (v1)
POST   /api/docs/:ref/publish                     {path, dispatch?} (v1)
POST   /api/docs/:ref/share-linear                (v2)
POST   /api/docs/:ref/assets                      upload an image, raw body (v1)
GET    /api/docs/:ref/assets/:name                an image (v1)
DELETE /api/docs/:ref                             hard delete; tombstone
```

- Write routes return the same `{ doc, rev, status, … }` result as `doc_save`.
- Create, save, edit, link, revert and status accept `Idempotency-Key`, cached
  per daemon as messaging does (`messaging/routes.ts:313-327`).
- Request bodies are read with a 2 MiB bound (413), except import contents (8
  MiB) and images (25 MiB).
- **Health.** Runs and agents get 403. The orphan list names absolute paths of
  other projects' run-state directories on this host, so it is decide tier only,
  as is the restore report.
- **Assets.**
  - Upload: anyone who may write the doc's drafts or propose to it. The type
    comes from the bytes' magic number (PNG, JPEG, GIF, WebP), never from the
    request; anything else, SVG included, is 400. The stored name is
    `<sha256>.<ext>` from the sniffed type.
  - Read: anyone who can see the doc, with the bearer like every docs route. The
    response carries the sniffed `Content-Type`,
    `X-Content-Type-Options: nosniff`,
    `Content-Disposition: inline; filename="<name>"`,
    `Content-Security-Policy: default-src 'none'; sandbox` and
    `Cache-Control: private, max-age=3600`.
  - An `<img>` cannot send a bearer, so the desktop fetches the image through
    the client and renders a blob URL (Desktop UI).
- `@dispatch/client`, the CLI's own `ApiClient`
  (`packages/cli/src/apiClient.ts`) and its test fakes mirror every route
  (messaging :517-519).

### Events

`doc.changed`, typed
`{ type: 'doc.changed'; scope: 'team' | 'personal'; id?: string }`, joins
`ServerEvent` (`events.ts:21`) as a bare refetch signal. `id` is never set for
`personal`, as memory's `memory.changed` does (memory :1690-1694). Amends are
debounced to one event per doc per 2 s. Like messaging's events it reaches any
request-tier socket (messaging :479-483), so it carries no content.

### CLI

`dispatch docs` (MIT) is for humans. It authenticates with `--token` or
`DISPATCH_APP_TOKEN` through `resolveAppToken`
(`packages/cli/src/commands/appToken.ts:23`), or a teammate token, since docs
routes refuse the daemon file's agent token. Agents use the MCP tools.

| Command                                                                     | Does                                                                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `list [--task t-…] [--scope] [--status] [--archived]`                       | visible docs                                                                                    |
| `show <ref> [--rev] [--section]`, `cat <ref> [--rev]`                       | header and outline with the body; the raw body to stdout                                        |
| `new <title> [--file f] [--slug] [--scope] [--link …]`                      | create; the body from `--file` or stdin                                                         |
| `edit <ref>`                                                                | opens `$VISUAL`, else `$EDITOR`, else `vi` on a temp copy; saves with base and hash, then seals |
| `link <ref> <target> [--rel] [--remove]`                                    | links                                                                                           |
| `history <ref>`, `diff <ref> <from> <to>`, `revert <ref> <rev>`             | history                                                                                         |
| `accept [--restored]`, `reopen`, `archive`, `restore`, `reviewed`, `delete` | lifecycle; `accept --restored` accepts every doc restored as a former accepted doc              |
| `proposals [--doc]`                                                         | proposals the caller may see                                                                    |
| `import <files…> [--link …] [--dry-run]`, `export <dir>`                    | Import, Export                                                                                  |
| `publish <ref> --path <p>`, `promote <ref>` (v1)                            | Publish to repo, Scopes and status                                                              |
| `sync repair [<ref>]` (v2)                                                  | re-reads dropped parked revisions (Team sync)                                                   |

`edit` on a 409 writes `marked` into the temp file under a comment line naming
the head revision, reopens the editor, and saves against the head. An empty file
aborts without writing. On an accepted doc, a request-tier caller's save becomes
a proposal and the command prints its gate.

**As built (v0).** On `base-changed` after the caller typed, the file holds one
marked block, the head's body against the caller's text
(`<<<<<<< head (rev N, author)` to `>>>>>>> yours`), instead of the head's body
alone, so nothing typed is lost. Any difference from the text last written
counts as typing, so an editor that only adds a final newline also gets the
two-sided block.

## Desktop UI

### v0

- **Docs view:** a new `ProjectView` `'docs'`
  (`apps/desktop/src/lib/appNav.ts:12-43`) on the Sidebar rail after `files`.
  The left pane lists docs with scope, status, unreviewed and search filters. A
  doc page shows title, handle, badges (scope, status, unreviewed, conflicted,
  restored), a links rail (tasks, runs, threads, memory, docs, each clickable),
  and a markdown source editor with a preview toggle (Q8).
  - The editor is a `textarea`, as the Files view's is, for native undo, IME and
    accessibility (`views/FilesView.tsx:211-215`). The preview is
    `components/runs/Markdown.tsx` (`react-markdown` with `remark-gfm`,
    `apps/desktop/package.json:38-39`).
  - Autosave waits `AUTOSAVE_DEBOUNCE_MS` (600 ms, `lib/editorBuffer.ts:106`)
    with the in-flight-text rule (`:1-24`), and sends `baseRev` and `baseHash`;
    the buffer state gains the base. "Save version" seals.
  - On `doc.changed`, a clean buffer reloads; a dirty one keeps typing, and its
    next save merges on the server. That merge keeps the doc `unreviewed` if the
    other side was (Review state).
  - A 409 loads `marked` into the editor under a banner, "Rev N by X changed the
    same lines. Resolve the marked blocks, then save", and the next save goes
    against the head.
  - **As built (v0).** A `base-changed` answer, or typing while the refused save
    was out, loads one marked block of the head's body against the buffer's text
    instead, so nothing typed is lost. Text that still has marker lines
    autosaves only after 5 s idle, and the banner stays until they are gone.
    Failed saves back off, doubling to about 40 s; a 4xx refusal waits for the
    next keystroke. Leaving a doc waits out the save in flight and sends what is
    held, and "Save version" refuses while text is unsaved or marked. A `merged`
    answer reloads the merged head when nothing was typed since, and otherwise
    bases the next save on `mine` (Whole-body saves).
  - "Mark reviewed", for decide-tier humans, on an unreviewed doc: it first
    lists the revisions since the last review with their authors (v1 adds the
    diff). Archive and restore.
- **Task page** (`components/tasks/page/TaskPage.tsx`): a Docs block after the
  attachments row (`:826`), listing the spec first, then plans, context links
  and docs from parents (marked), with "New spec" (a team doc linked `spec`) and
  "Link doc", offered as the link rules allow.
- **Palette:** a Docs section (Search). **Threads:** `doc:` refs open the doc at
  their section.

### v1

- **History panel:** revisions with author, cause and summary; a diff of any two
  on `@pierre/diffs` (`apps/desktop/package.json:26`); Restore (revert).
- **Three-pane merge view** on `@pierre/diffs` for a 409 and for a conflicting
  proposal: base, head and yours, per hunk, with take-head, take-yours and edit.
  It reads both marker styles (Merge). `@pierre/diffs` cannot render in
  happy-dom, so the hunk layout is a pure function with unit tests and the click
  path is handed to the owner.
- **Doc gate card**, wherever gate cards render: title, proposer, the diff
  against its base, and "merges cleanly" or "conflicts with rev N" (cached). A
  conflicting proposal offers "Open merge view", where a decide-tier human saves
  the resolution directly and then rejects the gate as resolved.
- Accept and reopen; "Accept again" on a doc restored from an accepted one; a
  personal/team toggle on create; Promote.
- **Publish** dialog, and the "published rev N; head is rev M" line.
- **Inbox:** a derived item per conflicted team doc
  (`GET /api/docs?conflicted=1`).
- **Images:** paste or drop uploads to `POST /api/docs/:ref/assets` and inserts
  `![alt](asset:<sha256>.<ext>)`. react-markdown's default URL transform empties
  any URL whose protocol is not http(s), irc(s), mailto or xmpp
  (`react-markdown@9.0.1` `lib/index.js:102`, `:298-320`; pinned at
  `pnpm-workspace.yaml:168`), and `Markdown.tsx` passes no `urlTransform`
  (`:119-121`). So the docs preview passes a `urlTransform` that keeps `asset:`
  URLs and otherwise defers to the default, and an `img` component that resolves
  `asset:` through `client.fetchDocAsset` into a blob URL, revoked on unmount,
  as `AttachmentsRow` does for attachments (`AttachmentsRow.tsx:141-142`).
  Export and publish rewrite `asset:` links (Export, Publish to repo); receipts
  keep them as references. Assets stay on this machine (options §4.1).
- The memory entry view lists docs that link to the entry.

## Licensing

| Code                                                                                                                                                                                                                  | License |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `@dispatch/protocol`: the `doc` ref type and `doc` `GateData`                                                                                                                                                         | MIT     |
| `@dispatch/protocol/federation`: the `DocBody` type (fed Plain bodies and Licensing; #6 App. F)                                                                                                                       | MIT     |
| `@dispatch/core`: doc wire types and limits, `DocsConfig`, `PolicyGate` `'doc'`, `NotificationKind` `'doc'`, `DISPATCH_MCP_TOOLS` entries, `untrustedVerbatim`, lenient policy-gate parsing, the receipts README line | MIT     |
| `@dispatch/mcp` tools, `@dispatch/client`, CLI `dispatch docs` and the receipts-restore staging step                                                                                                                  | MIT     |
| `packages/server/src/docs/**`, the orchestrator hooks, the overseer tools, the exporter step, the decision-feed case, the Linear adapter; `apps/desktop`                                                              | FSL     |
| `packages/server/src/team/federation/docs.ts`: the fold, grounding, hold-back, slug claims and `sync_missing`                                                                                                         | ELv2    |
| A hosted `DocStore` backend and the CRDT tier (Staging item 22), built with the hosted server                                                                                                                         | private |

No workspace package is added, so `scripts/check-licenses.ts` is unchanged.
`LICENSING.md`'s MIT row lists core, client, cli and mcp (`LICENSING.md:12`) but
not `packages/protocol`, which `scripts/check-licenses.ts:23` maps to MIT;
federation's task 19 adds it (fed Licensing, "Docs (task 19)"), and docs adds no
row of its own. The business direction and federation's table mark hosted pieces
private (fed Licensing, the relay row), which is why the hosted backend is
listed.

## Failure handling

- **`docs.db` will not open** (a newer schema, corruption, permissions): the
  daemon starts in the unavailable mode. Prompts carry no docs section, routes
  and tools answer 503 with the reason, the Docs view shows it, dispatch is
  never blocked, the receipts step touches nothing, and the `doc` gate handler
  throws so answered doc gates wait, unapplied, for a build that can open the
  file.
- **No FTS5:** the `LIKE` fallback (Tables).
- **A merge conflict:** 409 with hunks, nothing stored. A spent diff budget
  makes coarser hunks, never a wrong merge.
- **A merge result over the limits:** `invalid` on a save; `failed` on an
  approval; the oversize form on a sync fold.
- **A stale `baseHash`:** 409 `base-changed` with the head.
- **A missing or ambiguous anchor:** `invalid` naming the op and the candidates;
  nothing changes.
- **A write to an archived doc:** 409 "archived; restore it first".
- **The gate cannot be sent:** the proposal stays open with no gate id, and boot
  reconcile retries `raiseGate`.
- **A doc gate answered by someone who may not decide** (a row from an older
  build): ignored, the proposal stays open, a fresh gate is raised, and the
  answerer is told.
- **An approval that conflicts, or on a doc archived since:** the proposal
  becomes `failed`; notices to the approver and the author's run.
- **A notice cannot be delivered:** dropped.
- **The daemon dies mid-write:** the write's one transaction committed or did
  not. Boot seals expired open revisions and reconciles gates both ways.
- **The publish seed fails** (including a path that became a symlink): the
  dispatch fails with the reason before the run starts; the `publishes` row
  becomes `failed`.
- **The receipts step fails for one doc:** that doc is a problem in the pass,
  and the rest export. A file of an unknown doc is kept.
- **A staged restore file fails validation or its hash:** a problem in the
  report; the staging directory stays until the file is fixed or removed, and
  the receipts step prunes nothing meanwhile.
- **Import:** a file that fails validation is reported and the rest import; an
  over-cap content is split; a parity mismatch rolls back the whole commit; an
  idle session is swept after 24 hours.
- **v2 sync:** a revision waiting for parents stays parked under fed's retention
  rule; one dropped because its publisher passed 10,000 parked ops is recorded
  in `sync_missing` and re-read when its parent's name reappears or on
  `sync repair`; a hash clash is a sync problem (a provisional revision yields
  to the signed one); an unverified author on an accepted doc is held back; a
  conflicting fold becomes a conflicted head, and an oversize one takes the
  oversize form.
- **Linear:** an edit overwritten in the push window is a sync problem and an
  Inbox item, never silent.
- **Memory v1 is not there** (v0, or memory's store unavailable): personal scope
  answers 403, and `memory` link targets are `invalid`.
- **`a2a.db` is not there:** `a2aOrigin` falls back to the label and the
  provenance line, and never answers false because of the outage.
- **The checkout moves:** its run-state key changes and `docs.db` is orphaned,
  as `memory.db` and `messages.db` are. `GET /api/docs/health` lists, to
  decide-tier humans, `runs/*/docs.db` files whose `meta.root` no longer exists;
  recovery is moving the file into the new key's directory with the daemon
  stopped (O5).
- **Invalid config:** the key's default, with a warning.

## Testing

- **`packages/server/src/docs`,** against in-memory SQLite and a recording fake
  `DocsHost`:
  - limits: a 200-byte multi-byte title, a 768 KiB body, the escaped-size rule,
    reserved and prefixed slugs, CRLF and BOM normalization, a merge result over
    the limit refused;
  - the Principals, scope, visibility and lifecycle tables, including `a2a.`
    agents, A2A-provenance runs (linked team docs only, no writes, no ancestors,
    no mentions), review and verify runs (read only), a decide-tier human on
    another's personal doc (403), and invisible docs (404);
  - `a2aOrigin` with `a2a.db` unavailable: a task labelled `a2a`, and one whose
    body has the provenance line, both read as A2A origin;
  - **namespaces:** a team create, a rename and a spec link colliding with
    another human's personal doc succeed and reveal nothing; `~slug` resolves
    only for the owner's principals; a bare slug never reaches a personal doc;
  - the revision DAG: local `n`; a clean merge storing the writer's revision
    plus a merge; a conflict storing nothing; `unchanged` writes;
  - open revisions: amend by the same principal, and every seal trigger (idle,
    60-minute age, another writer, another principal's body read, save version,
    review, status, link, revert, publish, promote, the sweep, boot); a stale
    `baseHash`; the section index after amends;
  - **review state:** an agent's edit then a human's stale autosave merge leaves
    the doc unreviewed; a human-only doc is never unreviewed; a policy approval
    is unreviewed; a human approval of a proposal on a reviewed head is
    reviewed; a sync fold of two human-only heads is not unreviewed; a revert to
    an agent's revision is; mark reviewed needs decide tier on team docs and
    seals the head;
  - proposals: extend-not-duplicate, rate limits, the elevated reading of
    task-less proposals, policy `auto` at rung 4 with the receipt, gate raise
    and replay idempotence, approve (moved and unmoved head), approve that
    conflicts, approve over the limit, reject, expiry (`docs.db` first, then
    `closeGate`), recovery of a proposal with no gate;
  - **gate safety:** a doc-shaped question raised by a deciding human is
    ignored; an answer stored by a request-tier human (as an older build would
    allow) is ignored, the proposal stays open, and a fresh gate is raised; with
    the store unavailable the handler throws and the effect stays unapplied, and
    reopening the store then `recover()` applies it once; a reconcile closes
    gates of proposals no longer open;
  - lifecycle and proposals: reopen and archive withdraw open proposals and
    close their gates; hard delete closes gates before removing rows; an approve
    on an archived doc fails with a notice; an answer to an expired proposal
    gets a notice;
  - rename, aliases and no reuse within a namespace; hard delete with its
    tombstone;
  - **links:** one team spec per task and `replace`; the team-to-personal
    refusal; a run linking a doc as `spec` to another task (403); an approved
    agent adding `spec` (403); a request-tier human replacing an accepted spec
    (403) and adding a plan (allowed); `replace` only over a draft the caller
    could write; any link to an A2A-origin task by a non-decide principal (403);
    mentions rebuilt on seal, outside code fences; task-body mentions at read
    time, ignored for A2A-origin tasks;
  - proposal revisions: revision, diff and `doc_read(rev)` follow the proposal
    rows; history lists only revisions with an `n`; the author's operator sees
    its runs' proposals through `/proposals/:rev`;
  - the creates rate limit, humans exempt;
  - promote: owner only, as a human; a new id, no history, a team slug;
  - FTS search, `snippet()`, grouping, the `LIKE` fallback.
- **Merge,** table-driven over the behaviors `git merge-file` documents:
  one-sided, identical and overlapping changes, insertions at one position,
  delete against modify, empty base, a missing final newline. Property tests:
  `merge(b, x, b) = x`, `merge(b, b, y) = y`, `merge(b, x, x) = x`, and equal
  inputs give equal bytes, each also with the work budget forced to 1,000 so the
  coarse path is covered. Marker labels are pinned: ids for stored bodies, local
  labels only in `marked`.
- **Merge performance at the cap:** a 768 KiB body under the six measured shapes
  (block move, swapped halves, scattered edits, blanked lines, reversed
  sections, every line rewritten). Each diff's work count stays within
  `DIFF_WORK`, asserted exactly, since it is deterministic, and a merge's wall
  time stays under 500 ms as a regression alarm, generous for CI machines. The
  mergeability cache is hit on a second card read.
- **Anchored ops:** duplicate headings and anchors, headings in fenced code, h4
  headings as text, nested sections, `replace` found zero and two times,
  `insert` and `append`, atomicity when a later op fails, the `rebased` report.
- **Prompt:** snapshots of `## Docs` with and without the MCP server; a property
  test that the section never exceeds `3 × indexTokens` bytes apart from the
  spec line, including CJK and emoji titles; the ancestor walk; A2A runs (own
  links only, no mentions, no ancestor's inline); operator-only personal lines;
  a throwing docs service leaving the prompt intact.
- **Notices:** the window and the trailing notice, none for a run's own edit,
  none for unsealed amends, visibility, proposal decisions, a CLI-executor run
  dropping it, and none for a personal doc: no personal handle or summary
  appears in any `run.log` event.
- **Routes:** principal resolution (agent token and `a2a.` refused), the 409
  shape, idempotent replays, the 2 MiB bound, `doc.changed` without an id for
  personal docs, health's orphan list and restore report for decide tier only
  and 403 for runs. Avoid the in-process daemon traps: no `spawnSync` against
  the in-process server; `realpathSync` temp directories.
- **Gate wiring:** `GATE_TYPES`, `PolicyGate`, `GATE_RUNGS`, the notification
  kind, the decision feed listing a doc gate with its task and run and no
  content, and boot order: the handler registered before `recover()`.
- **Policy config:** `parsePolicyConfig` skips an unknown gate key with a
  warning instead of throwing, in `loadConfig` and on the Settings write path;
  Settings writes `gates.doc` only when set.
- **Durability:**
  - the exporter step writing `.dispatch/docs/`, exporting the sealed ancestor
    of an open head, and pruning only renamed, personal and tombstoned files;
  - a receipts pass with personal docs present writes none of them;
  - with the store unavailable, the step changes nothing and reports one
    problem, and the tasks still export;
  - with a staged restore pending, the step removes nothing;
  - a file of an unknown doc id is kept, with a problem;
  - a build without the step (today's `materializeReceipts`) leaves
    `.dispatch/docs/` untouched;
  - boot applies the staged restore before the boot export, so the first pass
    writes the restored docs;
  - the CLI restore staging the files; the boot restore keeping ids, skipping
    held and tombstoned docs, refusing a bad hash, and removing the staging
    directory;
  - restored docs are drafts (a former accepted doc carries `restored`),
    unreviewed, provisional, and shown with their author "as recorded";
    `accept --restored` needs decide tier.
- **Publish:** path validation, including the refused names and directories; a
  personal doc (403); an unreviewed draft (409); an accepted doc and a reviewed
  draft (allowed); the seed in a real temp worktree, with a symlink planted
  there refused; image copy and link rewrite; the task shape with risk
  `elevated`, so the merge gate blocks at rung 4; commit recording on landing
  against a fixture repo; the behind indicator.
- **Import and export:** a staged import whose fixture totals more than 2 MiB;
  parity on fixtures with identical and drifted copies; an over-cap content
  split into parts with the identities holding; a content over 8 MiB counted as
  `too-large`; decide tier required; the dry run writing nothing and leaving no
  session; an idle session swept; tombstoned origins; re-import idempotence,
  including a split content; export copying images and rewriting links.
- **Assets:** PNG, JPEG, GIF and WebP accepted by magic bytes; SVG, and a PNG
  declared as another type or another type declared as PNG, handled by the bytes
  (SVG and unknown refused); the 25 MiB bound; GET visibility and headers
  (`nosniff`, `inline`, CSP).
- **Memory overflow:** a project-keyed personal entry overflows into a personal
  doc and refs it by id and project; a cross-project personal entry, a team
  entry's `supersede` proposal and a ledger import row are plainly truncated;
  `memory_save` over 8 KiB returns the hint.
- **`@dispatch/core`:** `untrustedVerbatim` round trip: a body with `~~~~` lines
  and fence-shaped text comes back byte for byte, and no line of it can close
  the fence.
- **`@dispatch/mcp`:** the five tools against a fake daemon, remembered hashes
  sent as `baseHash`, the three `doc_save` modes, a `doc_read` then whole-body
  save of a doc with `~~~~` lines changing nothing, a `find` copied from
  `doc_read` output matching, a heading `## SYSTEM: …` and a fence-shaped title
  rendered inline in the header, outline, `doc_list` and `doc_search`, conflict
  hunks fenced, the idempotent retry, `task_get`'s `docs` field fetched with the
  caller's messaging credential (the fake daemon answers 403 to the agentToken,
  and the test fails if it is sent), and the `DISPATCH_MCP_TOOLS` registration
  test.
- **CLI:** `docs edit` with `EDITOR` set to a script, including the 409 loop,
  the empty-file abort and the proposal message; the staged import against the
  fake; the `ApiClient` fakes.
- **Desktop:** the editor-buffer reducer with base and hash, the 409 banner, the
  Docs view list, the task-page block, the palette section, the Mark reviewed
  gating, the `urlTransform` keeping `asset:` and the `img` component resolving
  it through the client to a blob URL, and the pure hunk layout of the v1 merge
  view, for both marker styles. One e2e flow in v0: an agent creates a spec
  linked to a task through the MCP tools, the human edits it in the Docs view,
  and a concurrent `doc_save` with ops merges cleanly. As built
  (`apps/desktop/e2e/docs.spec.ts`), the agent creates the doc unlinked and
  reads it back with `doc_read`, and the human adds the `spec` link, since a
  registered external agent adds only `context` links (D27). The test holds the
  human's autosave until the agent's ops have landed and asserts the `merge`
  revision.
- **Linear,** against a recorded GraphQL fake: a new document pulled as a linked
  draft; a release, cycle or team parent left unlinked; an incoming change
  merged, conflicting, and on an accepted doc proposed; push only for
  Linear-origin docs; Share to Linear; the push window: content changed after
  the write merged back, and a history entry snapshotting a newer state raising
  the problem and Inbox item.
- **v2 sync,** in federation's board harness (fed Staging task 18a; Testing,
  "The convergence harness"): three replicas with concurrent edits converge to
  one head id and bytes; a conflict is flagged everywhere; a conflicting fold on
  replicas that number revisions differently gives identical bytes; an oversize
  fold under different arrival orders gives identical bytes and fits one op;
  every merge is published; an unverified author and a policy approval stricter
  here are held back; approve and reject here converge everywhere; concurrent
  approve and reject converge on reject; a removal against a later revision;
  parked parents, an overflow drop and the re-read; restore, then a concurrent
  local edit, then sync, both when the branch supplies the restored revision's
  history (confirmed) and when it does not (adopted); concurrent creates
  claiming one slug resolve to the same handles everywhere; personal docs never
  published; the seat pause.
- **Manual, before the AGENTS.md change:** the import dry run on this repo's
  specs across the main checkout and worktrees matches that day's read-only
  count, then the real import.

## Staging

Each stage ships on its own. Sizes: S under a day, M a few days, L a week.

### v0: team docs, read and write

Needs messaging only.

| #   | Task                                                                                                                                                                                                                                                                         | Writes                                                                                                                                                                             | Size |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | `DocStore`, `SqliteDocStore`, `sections.ts`: schema, namespaces and handles, limits, open revisions and the sweep, review state, aliases, tombstones, FTS5 and fallback                                                                                                      | `packages/server/src/docs/{store,sections,review}.ts`                                                                                                                              | M    |
| 2   | `merge.ts` (its own bounded diff, diff3, the performance test at the cap) and `ops.ts`                                                                                                                                                                                       | `packages/server/src/docs/{merge,ops}.ts`                                                                                                                                          | M    |
| 3   | `service.ts` and `routes.ts`: every v0 route, principal auth, link rules, `doc.changed`, idempotency, boot order; `@dispatch/client`, CLI `ApiClient` and fakes; core wire types and `DocsConfig`; `parsePolicyConfig` skipping unknown gates, unless memory landed it first | `packages/server/src/docs/{service,routes}.ts`, `packages/server/src/{api,events,index}.ts`, `packages/client/src/api.ts`, `packages/cli/src/apiClient.ts`, `packages/core/src/**` | M    |
| 4   | `doc` in `REF_TYPES`; thread rendering of doc refs                                                                                                                                                                                                                           | `packages/protocol/src/envelope.ts`                                                                                                                                                | S    |
| 5   | The five MCP tools, `untrustedVerbatim`, `DISPATCH_MCP_TOOLS`, `task_get`'s `docs` with the caller's credential; the overseer's read tools                                                                                                                                   | `packages/mcp/src/**`, `packages/core/src/{untrusted,dispatchMcpTools}.ts`, `orchestrator/overseerTools.ts`                                                                        | M    |
| 6   | `## Docs` and the no-MCP inline; `buildTaskPrompt` and `promptForTask`                                                                                                                                                                                                       | `packages/server/src/docs/prompt.ts`, `orchestrator/{prompt,orchestrator}.ts`                                                                                                      | S    |
| 7   | `dispatch docs` (all but `publish`, `promote`, `accept`, `reopen`), the staged import with parity and splitting, export                                                                                                                                                      | `packages/cli/src/commands/docs.ts`, `packages/server/src/docs/transfer.ts`                                                                                                        | M    |
| 8   | Desktop: Docs view, source editor with preview, autosave with base and hash, the conflict banner, Mark reviewed, task-page block, palette                                                                                                                                    | `apps/desktop/src/**`                                                                                                                                                              | L    |
| 9   | The v0 e2e flow                                                                                                                                                                                                                                                              | `apps/desktop/e2e/**`                                                                                                                                                              | S    |

Exit: an agent in a worktree reads a spec it never had on disk; the e2e flow
passes; the import dry run reproduces the day's count; the merge performance
test passes at the cap.

**As built (v0).** v0 also shipped task 11, the A2A rules, as its last task: the
`a2a` label and the provenance line are enough to fail closed, and `a2a.` agents
are refused from v0. Binding the bridge's own task origin waits for the A2A
bridge. On 2026-09-28 the e2e flow passed, the merge performance test passed at
the cap, and the import dry run matched that day's read-only count of 61 files,
50 names and 61 distinct contents, with both parity identities `ok`.

### v1: review, personal scope, durability

Needs memory v1's `RunMeta.operator` and identities (memory :2061-2063).

| #   | Task                                                                                                                                                                                           | Needs                                                                                                                                                                        | Size |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 10  | Personal scope through `operatorOf`; personal namespaces; promote; the privacy rules                                                                                                           | memory v1                                                                                                                                                                    | M    |
| 11  | A2A rules: `a2a.` agents refused, A2A-provenance runs read-only on linked team docs, the fail-closed `a2aOrigin`, the A2A-task link rule, no mentions; no later than the A2A bridge's handoffs | —                                                                                                                                                                            | S    |
| 12  | `accepted`, proposals, the `doc` gate with its handler checks, `PolicyGate`, `GATE_RUNGS`, `NotificationKind`, the decision-feed case, the policy copy, withdrawal and expiry, the gate card   | #6 Staging task 7a (C1, C2, C5); memory's relabel and `describePolicyAuthorization` (memory :891-903); the lenient `parsePolicyConfig` released at least one release earlier | M    |
| 13  | History panel, diffs, restore, the three-pane merge view                                                                                                                                       | —                                                                                                                                                                            | M    |
| 14  | Live notices, team docs only                                                                                                                                                                   | —                                                                                                                                                                            | S    |
| 15  | Receipts: the conservative exporter step, the README line, CLI restore staging, the boot restore with provisional, draft and unreviewed restores, `accept --restored`                          | —                                                                                                                                                                            | M    |
| 16  | Publish: route with the review and path rules, `elevated` task, worktree seed with the re-check and image copy, landing record, behind indicator                                               | —                                                                                                                                                                            | M    |
| 17  | Images: upload and read routes with sniffing and headers; the preview's `urlTransform` and `img`; export and publish copying                                                                   | —                                                                                                                                                                            | M    |
| 18  | Memory overflow to a project-keyed personal doc and the `memory_save` hint (memory's code)                                                                                                     | 10                                                                                                                                                                           | S    |
| 19  | AGENTS.md "Agent Artifacts" (agents to `doc_save`) and the import of this repo's specs                                                                                                         | 12, 15                                                                                                                                                                       | S    |

Exit: an agent's edit to an accepted spec waits in Needs you at rung 3 and
applies itself at rung 4; a doc gate answered by an older build's rules is not
applied; a receipt log restores team docs on a clean machine as reviewed-pending
drafts.

### v1.1

| #   | Task                                                                                                                | Size |
| --- | ------------------------------------------------------------------------------------------------------------------- | ---- |
| 23  | Review and verify prompts gain the task's spec line (not the index), after v1 shows how often specs are linked (O1) | S    |

### v2: sharing

| #   | Task                                                                                                                                                                                                                                                                                                                                   | Size |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 20  | The federation `doc` op fold (ELv2): publish, verify, park and `sync_missing`, grounding and restored revisions, fold with based merge ids and the oversize form, slug claims, hold-back proposals, approve and reject revisions, seats; after fed task 20 (F3), which supplies the op's routing, parking, `speaksFor` and `rereadOps` | L    |
| 21  | The Linear documents adapter, with the push-window detection, after parity P2                                                                                                                                                                                                                                                          | M    |
| 22  | Later, with the hosted server: a CRDT body (option C) behind the same revision DAG, its snapshots sealing as revisions. Not scheduled here                                                                                                                                                                                             | —    |

Exit: the convergence harness scenarios in Testing pass.

**Verification per task:** `moon run root:format`, `moon run root:lint`, and
`moonx <project>:typecheck` and `moonx <project>:test` for every touched project
(AGENTS.md "Verification Baseline").

## Decisions adopted on the owner's behalf

The owner asked for everything to proceed without stopping (decisions :15). No
owner decision on #4 is on record, so the options doc's recommendation and its
recommended answer to every question (options §5-§6) are adopted, and so is
every choice below, including the former open questions (as memory's and A2A's
were, decisions :13). Each can be reversed; the last column says when to
revisit.

| Q   | Question            | Adopted                                                                                                                                                    | Revisit if                                                                                                           |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Approach            | B: `docs.db`, a revision DAG, anchored ops, diff3                                                                                                          | Live co-editing is needed before the hosted server                                                                   |
| 2   | Store               | `docs.db` in run-state                                                                                                                                     | The storage spine moves stores to `~/.dispatch/projects/<id>/`                                                       |
| 3   | Scopes              | Personal (per project, own namespace) and team                                                                                                             | Machine-specific runbooks turn up                                                                                    |
| 4   | Concurrent edits    | Base revision, anchored ops, diff3, 409 on a real conflict                                                                                                 | Conflicts prove common                                                                                               |
| 5   | Agents on team docs | Drafts direct; accepted docs through the `doc` gate, auto-approving at rung 4; `spec` and `plan` links that displace an accepted doc are decide tier (D27) | A bad agent draft misleads a teammate's run                                                                          |
| 6   | Reaching runs       | Budgeted index plus tools; the spec inlined only without MCP                                                                                               | Runs miss specs they needed                                                                                          |
| 7   | Mid-run changes     | A rate-limited `notifyRun` digest, team docs only                                                                                                          | It proves noisy                                                                                                      |
| 8   | v1 editor           | Markdown source with preview                                                                                                                               | Non-engineers adopt Docs                                                                                             |
| 9   | History             | Every sealed revision, full bodies                                                                                                                         | A project's `docs.db` passes 100 MB                                                                                  |
| 10  | Team sync           | Signed federation `doc` op after F3, DAG, deterministic merge                                                                                              | Federation slips and teams need docs sooner                                                                          |
| 11  | Durability          | Receipts export team heads; restore reads them back as unreviewed, provisional drafts                                                                      | —                                                                                                                    |
| 12  | The repo            | One-way publish through an `elevated` task and PR                                                                                                          | —                                                                                                                    |
| 13  | Existing markdown   | Explicit, staged import with parity; AGENTS.md changes after v1                                                                                            | —                                                                                                                    |
| 14  | Memory overflow     | Project-keyed personal entries overflow into a personal doc; others truncate; `memory_save` over 8 KiB hints `doc_save`                                    | —                                                                                                                    |
| 15  | Body cap            | 768 KiB, one revision per op; import splits larger files                                                                                                   | The A2A plan is at 95.8% of it: revisit when a doc must be edited whole past the cap, which needs multi-op revisions |
| 16  | Linear documents    | Adapter in v2, after parity P2                                                                                                                             | —                                                                                                                    |
| 17  | License             | FSL host, MIT interfaces inside MIT packages, ELv2 sync, private hosted backend                                                                            | An embedder asks for the engine                                                                                      |
| 18  | A2A                 | `a2a.` agents nothing; A2A-provenance runs read linked team docs, read-only                                                                                | —                                                                                                                    |

Choices this spec makes where the options doc was silent, also adopted on the
owner's behalf:

- **D1. Ids** are `doc-<ulid>` and `rev-<ulid>`; v2 sync merges take a hashed
  `rev-` id over the algorithm, the base and the sorted parents.
- **D2. Open revisions** seal on 10 idle minutes, 60 minutes of age, another
  principal's write or body read, "Save version", any review, status or link
  change, and the sweep; `baseHash` guards a principal's second editor.
- **D3. A clean whole-body merge stores the writer's revision and a merge
  revision,** so history keeps what each side wrote.
- **D4. The ops** are `replace_section`, `replace`, `insert`, `append` and
  `set_title`; sections are ATX h1–h3 outside code fences.
- **D5. Bodies must also fit 960 KiB once JSON-escaped,** so the 1 MiB op limit
  holds for any content; computed bodies obey the same limits.
- **D6. `unreviewed`** is computed from the revision DAG: any tainted revision
  (agent-authored, policy-approved, unverified or restored) since the last
  review. Only a decide-tier review (the owner's, for personal docs) or accept
  clears it; human saves and merges do not.
- **D7. One open proposal per principal per doc;** later writes extend it under
  the same gate.
- **D8. Approval always writes an `approve` revision** carrying the approver; an
  approval that conflicts or exceeds the limits fails the proposal with a
  notice, and the card shows mergeability first.
- **D9. Proposals with no source task read as `elevated`,** so a human always
  decides them, as memory's do.
- **D10. Review and verify runs read docs and never write them.**
- **D11. Archived docs are read-only until restored;** personal docs carry
  status only as a label.
- **D12. v0 has `draft` and `archived`;** `accepted` and the gate come in v1.
- **D13. Live notices fire on seals, not on every amend,** and also cover docs
  the run has read.
- **D14. `[[slug]]` in task bodies resolves at read time,** team docs only and
  never for A2A-origin tasks; in doc bodies it becomes a `context` link when a
  revision seals.
- **D15. Index rank, tags and line format** as in The `## Docs` prompt index;
  the spec line always shows.
- **D16. Receipts restore** is staged by the CLI into run-state and applied by
  the daemon at its next open, before the boot export, keeping revision ids as
  provisional; restored docs come back as unreviewed drafts, with a decide-tier
  "Accept again" for formerly accepted ones.
- **D17. Publish seeds the file into the run's worktree** through an
  orchestrator hook that re-checks the path there; the agent only formats and
  commits.
- **D18. Import keeps dated file names as slugs,** turns drifted copies into
  revisions in mtime order, runs as a staged session, and splits over-cap files
  at headings.
- **D19. Sync holds back uncovered revisions to accepted docs as a proposal;**
  rejecting writes a `reject` revision that removes the change for everyone, and
  a concurrent approve and reject converge on reject.
- **D20. Linear:** only Linear-origin docs push back; "Share to Linear" uses
  `projectId` or `issueId`; Linear edits to accepted docs are proposals; a
  release parent maps to no task.
- **D21. Configuration keys and defaults** as in Configuration;
  `parseDocsConfig` never throws.
- **D22. A `doc` notification kind,** and the rung-4, rung-3 and policy-table
  copy, extending memory's relabel.
- **D23. The overseer gets read-only doc tools.**
- **D24. `task_get` returns the task's doc lines,** fetched with the caller's
  messaging credential.
- **D25. Promote** copies a personal doc into a new team draft (v1).
- **D26. Personal docs have their own namespace per owner,** written `~slug`;
  team writes never collide with them, and `links_one_spec` is per namespace.
- **D27. Link rules:** runs link only on their own task; approved agents add
  `context` links only; any human may add `spec` and `plan` links that displace
  nothing accepted; displacing an accepted `spec` or `plan`, and any link to an
  A2A-origin task, is decide tier; `replace` only over a draft the caller could
  write.
- **D28. Live notices never cover personal docs,** since `notifyRun` broadcasts
  its line to every socket as `run.log`.
- **D29. Publish tasks are `elevated`,** so a human always merges them; only an
  accepted or reviewed team doc publishes; agent-instruction files and the
  `.agents/`, `.claude/`, `.github/`, `.dispatch/` and `.git/` trees are
  refused.
- **D30. Import is decide tier.**
- **D31. `merge.ts` has its own bounded diff** (patience anchors, linear-space
  Myers in gaps, a deterministic 2,000,000-unit work budget) and runs on the
  request thread; jsdiff is not added.
- **D32. The `doc` handler is always registered,** before `recover()`; it acts
  only on its own system-raised gate and only on an answer from the system or a
  human who can decide now; in the unavailable mode it throws so the effect
  waits.
- **D33. `parsePolicyConfig` skips unknown gate keys with a warning,** shipped
  at least one release before the `doc` gate; Settings writes `gates.doc` only
  when set.
- **D34. The receipts docs step never deletes a file it cannot vouch for:**
  nothing when docs are unavailable, nothing while a restore is pending, never a
  file of an unknown doc.
- **D35. Restored revisions are provisional** until a signed revision confirms
  them or the first complete pass after the restore adopts them.
- **D36. Sync slug claims:** the lower id keeps a contested slug; the other
  doc's handle takes an id suffix, derived locally and never published.
- **D37. Every sync merge is published;** an oversize fold keeps the lower-id
  parent's body under a marker block; dropped parked revisions are re-read
  through a federation hook.
- **D38. Reopen, archive and delete withdraw open proposals and close their
  gates;** expiry updates `docs.db` before closing the gate.
- **D39. Text other principals wrote reaches agents fenced or inline:** the page
  and conflict hunks through `untrustedVerbatim`, which alters no line; titles,
  headings, snippets and summaries through `untrustedInline`.
- **D40. AGENTS.md sends agents to `doc_save`;** `dispatch docs` stays a human
  tool.
- **D41. `a2aOrigin` fails closed** on the `a2a` label and the provenance line
  when `a2a.db` is down.
- **D42. Linear pushes re-read before and after the write,** merge a later edit
  back, and surface an overwritten one as a problem and an Inbox item.
- **D43. Health's orphan list and restore report are decide tier;** assets are
  typed by their bytes and served with `nosniff`, `inline` and a sandboxing CSP.
- **D44. The `doc` `GateData` carries `taskId` and `runId`,** so the decision
  feed can show them.
- **D45. Proposal revisions follow their proposal's visibility,** and history
  lists only revisions with an `n`.

Former open questions, adopted from their recommendations:

- **O1. Review and verify prompts** get the task's spec line (not the index) in
  v1.1, Staging task 23. _Revisit if_ v1 shows specs are rarely linked, or
  reviewers need more than one line.
- **O2. Rejecting a synced change removes it for the whole team** (D19),
  including a teammate's human edit built on it. Accepted; the gate card says
  "rejecting removes this change for every teammate" and lists the held
  revisions with their authors. _Revisit if_ teammates lose wanted edits this
  way.
- **O3. Personal doc text in run transcripts on shared hosts:** notices no
  longer carry personal docs (D28), but `doc_read` results are tool output in
  the run's transcript, the same exposure memory accepted (memory :2105-2117).
  Accepted, and said in the shared-host documentation. _Revisit if_ a shared
  host's teammates can read each other's run transcripts by default.
- **O4. Files-backend projects** have no receipts (`receipts.ts:108-118`) and no
  sync (fed Scope), so their team docs live only in `docs.db`. Accepted; tasks
  are leaving markdown (`docs/TEAM-SERVER.md:77-100`), and
  `dispatch docs export` covers backups. _Revisit if_ a files-backend team asks
  for shared docs.
- **O5. Moving the checkout orphans `docs.db`,** as it does `memory.db` and
  `messages.db`. Taken up in the storage-spine move to
  `~/.dispatch/projects/<id>/` (`packages/core/src/sqliteDb.ts:215-227`); until
  then, health lists orphans to decide-tier humans and says how to move them.
  _Revisit if_ the spine move slips past v1.

## Changes to other specs

Each lands with its own sub-project or stage:

- **Messaging:** `Ref.type` (:106-110) and `GateData` (:162-185) gain `doc`; the
  `doc` gate data carries optional `taskId` and `runId`, and the decision feed's
  `gateItems` reads them (`decisionFeed.ts:432-439`).
- **Memory:**
  - truncation (:1403-1406) gains the doc hand-off for project-keyed personal
    entries only, reffed by id and project; every other case stays plain
    truncation (The boundary with memory);
  - `memory_save` gains the over-8-KiB hint (Q14);
  - the rung-4 relabel (:891-903) extends to docs: core's label "Auto-merge on
    green and accept agents' team memory and doc edits", the slider's "Merge and
    accept memory and doc edits on their own", and rung 3's description ending
    "Merging, shared memory and accepted docs still wait.";
  - the `memory` gate has the `doc` gate's config hazard: whichever of memory v1
    and docs v0 lands first makes `parsePolicyConfig` skip unknown gate keys
    with a warning (`config.ts:896-900`, `:1791-1795`), and the `memory` gate
    ships at least one release later;
  - memory's live-notify citation of `orchestrator.ts:599-611` is now
    `:586-599`.
- **Federation:** `OpType` already carries `doc` (fed FederatedOp, Op types),
  decision 36 already hands docs the body and fold, and task 20 already supplies
  routing, parking and `speaksFor`; nothing there changes. Four additions:
  - a `rereadOps(replica, seqs)` hook, so the docs module can recover a board op
    dropped from `fed_parked` when its publisher passed 10,000 parked ops (fed
    Speaks for, "Checks that wait"), since board ops stay on the branch and
    relay (fed The sync branch; Relay (F4));
  - `DocBody` gains `meta.aliases` and `review` and loses `meta.reviewedRev`
    (fed Plain bodies); fed's Team memory and docs bullet "a `status` or
    `reviewedRev` change" becomes "a `status`, `review` or reserved link
    change";
  - fed's "Pointers into this spec" table maps this spec's old pointers into
    fed; it can drop them once fed has read this revision;
  - fed's own pointers into this file (Plain bodies; Team memory and docs (F3);
    Staging's closing paragraph) name the 2026-09-26 morning draft's lines (docs
    :343, :1050-1140, :1475); they should cite section names ("Validation and
    limits", "Team sync", Staging task 20).
- **#6:** registers `doc` as a provisional ref type and `doc` as a provisional
  system-only gate type (approve, reject) in Registries §11, both made permanent
  at its Staging task 16. Docs task 12 waits for #6 Staging task 7a (C1, C2,
  C5), as #6 already says in its notes for #4. The optional `taskId` and `runId`
  join the `doc` gate data in the registry and App. F. #6's pointers into this
  file ("docs :308-314", ":626-641", ":635-638", ":640-641", ":646-648",
  ":1572-1574") name the 2026-09-26 morning draft; they should cite "Doc,
  revision, link, proposal, review", "Proposals and the `doc` gate" and "Changes
  to other specs".
- **A2A bridge:**
  - the egress table's "Never exported by the bridge" column (a2a :1790-1796)
    gains "docs (#4)";
  - "Memory and A2A-linked runs" (a2a :1801-1815) gains its docs counterpart:
    runs of A2A-origin tasks read only team docs linked to their own task, never
    ancestors' links, body mentions or personal docs, and write nothing; links
    to such tasks are decide tier; when `a2a.db` is down, the `a2a` label and
    the provenance line stand in for `dispatch_task`.
- **Core** (`packages/core/src/untrusted.ts`): `untrustedVerbatim(label, text)`
  beside `untrustedFenced` (`:33-45`), whose escaping stays for every other use.
- **Autonomy ladder** (`docs/design/autonomy-ladder.md`): rung 4 covers the
  `doc` gate.
- **AGENTS.md** "Agent Artifacts" after Docs v1 (Q13; D40).

## Open questions

None. The five raised by the earlier draft are adopted as O1–O5 above, with
revisit triggers, so the owner can review them with the rest.

## Critic responses

Numbered as the critique listed them: 1–17 feasibility, 18–40 consistency.

1. **Merge blocks the daemon.** Fixed, beyond the suggested fix. Measured:
   jsdiff with the suggested `maxEditLength: 2000` still spends about 1.05 s
   giving up, and about 240 ms at 1,000, because its cost grows with the square
   of the bound. So jsdiff is dropped for an in-house patience-anchored diff
   with a deterministic work budget, measured at 5–59 ms per diff at the cap
   (Merge), plus the mergeability cache and a performance test at the cap.
   Running on the shared worker is declined: at about 120 ms per merge it is not
   needed, and the fd-leak concern then does not arise.
2. **Import over 2 MiB.** Fixed with the staged session (Import). Exempting the
   route from the bound is declined: a 3.3 MB request, rolled back whole on one
   bad file, is worse than chunked uploads with hash dedupe.
3. **Receipts step with docs closed, and boot order.** Fixed: the step touches
   nothing when docs are not open, prunes nothing while a restore is pending,
   and never deletes a file of an unknown doc; `openDocs` and the restore run
   before the boot export (Boot order; Receipts). The "one project and one
   daemon" rationale is rewritten.
4. **Doc gate lost when docs is down.** Fixed: the handler is always registered,
   before `recover()`, and throws in the unavailable mode (Effect).
5. **C1/C2 dependency and answer authorship.** Fixed: task 12 needs #6 Staging
   task 7a (C1, C2 and C5, since #6's third draft split task 7), and the handler
   checks the answerer's decide tier now, which C2 does not (The gate).
6. **`policy.gates.doc` breaks older builds.** Fixed with the lenient parse,
   shipped a release ahead, for memory's gate too (Autonomy ladder; D33).
7. **Merge id without the base, and restored ancestry.** Fixed: the id hashes
   the base; only grounded revisions fold, publish or serve as bases; restored
   revisions are provisional until confirmed or adopted; the scenario is in the
   harness (Team sync).
8. **Slug clashes in sync, and the personal slug oracle.** Fixed: a
   deterministic lower-id rule with id-suffixed handles and replicated aliases,
   and per-owner namespaces for personal docs (Handles and namespaces; Team
   sync).
9. **Expiry through `closeGate` never applies.** Fixed by the second suggested
   route: `docs.db` moves first, then `closeGate`, and reconcile covers a crash
   between them. A system-answer host method is declined as a second path to the
   same effect.
10. **`asset:` images do not render.** Fixed: a `urlTransform`, an `img`
    component with blob URLs, export and publish rewriting, and task 17 resized
    to M (Desktop UI).
11. **`untrustedFenced` corrupts round trips.** Fixed with `untrustedVerbatim`,
    which widens the bar and alters nothing; listing escaped lines is declined
    as needless once nothing is escaped.
12. **Linear push race, and releases.** Fixed partly as suggested: a later edit
    is merged back. The overwritten edit itself is not recovered: the API
    exposes it only as internal ProseMirror JSON and an unspecified metadata
    object, so the adapter detects it through `documentContentHistory` and
    raises a problem and an Inbox item instead of a conflicted head. Release
    parents map to no task.
13. **Stale federation and #6 citations.** Fixed throughout. Both specs were
    revised again while this one was (each grew by more than half), so they are
    now cited by section name, C-change label and task number rather than line,
    as fed asks of citations into it. The "OpType gains doc" item is restated as
    already done, with fed decision 36 and task 20, and fed's new retention rule
    (no 7-day limit) is adopted.
14. **Stale cap numbers.** Fixed with today's figures, and import now splits
    over-cap files so parity holds (Validation; Import).
15. **`a2aOrigin` fails open.** Fixed: it falls back to the label and the
    provenance line (Principals).
16. **"Only the system raises it," and the decision feed.** Fixed: the handler's
    recorded-gate and system-sender checks are stated as load-bearing and
    tested; the gate data carries `taskId` and `runId` for the feed.
17. **AGENTS.md sends agents to a CLI they cannot use.** Fixed: AGENTS.md sends
    agents to `doc_save`; teaching the CLI to read run tokens is declined,
    because the CLI's rule never to read a token an agent can reach is
    deliberate (`appToken.ts:21-23`).
18. **Ungated link changes redirect accepted specs.** Fixed with the link rules
    (D27). Routing link changes through the `doc` gate is declined in favor of
    the decide-tier rule: a gate per link would flood Needs you, and the index
    already marks the draft `unreviewed`.
19. **A2A client text pulls in team docs.** Fixed: no body mentions for
    A2A-origin tasks, decide-tier links to them, no ancestor inline, and an A2A
    spec change (Changes to other specs).
20. **One slug namespace across scopes.** Fixed, as in 8, with `links_one_spec`
    per namespace.
21. **`unreviewed` cleared by merges.** Fixed with Review state; mark reviewed
    is decide tier on team docs, matching memory's confirm.
22. **Live notices publish personal handles.** Fixed: personal docs make no
    notices (D28).
23. **Memory overflow breaks scope.** Fixed: project-keyed personal entries
    only, reffed by id and project; every other case truncates (The boundary
    with memory). Writing a team doc through the gate for shared entries is
    declined: a proposal per truncated lesson is more review load than the lost
    tail is worth.
24. **Publish auto-merges and can write agent instructions.** Fixed: `elevated`
    risk, the review requirement, refused paths and a re-check in the seed
    (D29). Allowing those paths at decide tier is declined; they change through
    ordinary tasks.
25. **Import over 2 MiB, and its tier.** Fixed, as in 2, plus decide tier.
26. **Marker labels differ per replica.** Fixed: stored and synced bodies label
    by revision id; local labels only in a 409's `marked`.
27. **Computed bodies escape the cap.** Fixed: every computed body obeys the
    limits, oversize folds take a bounded form, every sync merge is published,
    and dropped parked revisions are re-read. "Align with fed's 7-day drop" no
    longer applies: fed's revision parks with no time limit and drops only on
    revocation or past 10,000 parked ops per publisher, and this spec now
    follows that rule.
28. **The system-only claim, and C1/C2.** Fixed, as in 5 and 16. A separate
    docs-side validation change is declined: #6's C5 now adds `GATE_RAISERS`,
    which makes `doc` system-only in `validateGate`, and until it lands the
    handler's check covers the gap.
29. **Restore trusts unsigned frontmatter.** Fixed: restored docs are
    unreviewed, `draft` unless re-accepted by a decide-tier human, shown "as
    recorded", and provisional for sync (D16, D35).
30. **Missing tests.** Fixed: Linear, assets, promote, receipts' personal
    exclusion, publish of personal docs, overflow and the creates limit are all
    in Testing.
31. **Unspecified authorization.** Fixed: import decide tier, health's orphans
    and restore report decide tier, and the asset rules and headers (Routes).
32. **Licensing gaps.** Fixed: the `DocBody` row (MIT), the fold (ELv2), the
    hosted backend (private), and the `LICENSING.md` note.
33. **Stale cross-references.** Fixed, as in 13; the pointers the other specs
    hold into this file are listed under Changes to other specs.
34. **Open questions left open.** Fixed: O1–O5 are adopted with revisit
    triggers, O1's task is in Staging (23), and D26–D45 record the choices the
    critique named.
35. **`task_get` sends the refused agentToken.** Fixed: that fetch uses the
    caller's messaging credential, with a test.
36. **Proposal revision visibility.** Fixed (Who sees what; D45).
37. **Proposals on archive, delete and reopen.** Fixed with withdrawal (D38).
    Keeping proposals open on reopen is declined: a draft has no gate.
38. **Rung-4 relabel.** Fixed: memory's relabel is extended to docs, and task 12
    depends on memory's `describePolicyAuthorization` change.
39. **Stale cap data.** Fixed, as in 14.
40. **Unfenced metadata.** Fixed: titles, headings, snippets and summaries go
    through `untrustedInline`, and conflict hunks are fenced, with a test.

## Sources

- Options: `.agents/ignore/specs/2026-09-25-docs-options.md` (revised
  2026-09-26)
- Messaging core: `docs/specs/2026-09-23-messaging-core-design.md`
- Memory, A2A bridge, federation, published spec, #2/#3 decisions:
  `.agents/ignore/specs/2026-09-25-{memory-design,a2a-bridge-design,federation-design,published-spec-design,subprojects-2-3-decisions}.md`
- Linear parity plan:
  `../dispatch-worktrees/p2-linear-sync/.agents/ignore/specs/2026-09-23-linear-parity-and-task-surfaces.md`
- Linear documents: <https://linear.app/docs/documents>
- Linear GraphQL schema (`type Document` with `release`, `DocumentCreateInput`,
  `DocumentUpdateInput`, `documentUpdate`, `documentContentHistory`,
  `DocumentContentHistoryType`), fetched 2026-09-26:
  <https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql>
- jsdiff release notes (`merge` removed in 8.0.0, #596; `maxEditLength`):
  <https://github.com/kpdecker/jsdiff/blob/master/release-notes.md>
- Myers, "An O(ND) Difference Algorithm and Its Variations" (1986):
  <http://www.xmailserver.org/diff2.pdf>
- Patience diff, `git diff --patience`:
  <https://git-scm.com/docs/git-diff#Documentation/git-diff.txt---patience>
- diff3: <https://www.cis.upenn.edu/~bcpierce/papers/diff3-short.pdf>
- `git merge-file`: <https://git-scm.com/docs/git-merge-file>
- SQLite FTS5: <https://www.sqlite.org/fts5.html>
- Yjs: <https://docs.yjs.dev/> · Automerge: <https://automerge.org/>
