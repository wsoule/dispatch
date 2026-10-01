# Memory

Status: **v1 built** (v0's store, index, ledger import and read tools, plus
personal memory, the `memory` gate, the ledger cutover, decay, the Claude export
and the one-time import); v2 not yet. The live Agent SDK probe passed on
2026-09-28 on Claude Code 2.1.207 (bundled) and 2.1.283 (PATH), so
`memory.claudeAutoMemory` defaults to `export` and 2.1.207 is the probed
version. Designed 2026-09-25 and revised the same day after a feasibility
critique and a consistency critique. Second of the six sub-projects in
`docs/specs/2026-09-23-messaging-core-design.md` (:21-30), "MIT model, FSL
host", depending on messaging (#1). Binding inputs: the owner decisions in
`.agents/ignore/specs/2026-09-25-subprojects-2-3-decisions.md` and the option
analysis in `.agents/ignore/specs/2026-09-25-memory-options.md` (option B,
adopted except where the decisions differ). Where this spec departs from a
decision, it says so under Open questions.

Code references are to `claude/agent-communication-platform-abb9af` at commit
`80b9d206`, taken while messaging Phase 3 was still editing. Phase 3 finished at
`f6870ed0`, which v0 is built on, and moved some of them: `promptForTask` is
`orchestrator.ts:4937-4957` and `ledger.changed` is `events.ts:77`. Every
reference names its symbol, so search for the symbol when a line number has
drifted.

## Why

Dispatch already carries knowledge between runs, in pieces that do not fit
together:

- **The ledger is the only cross-task memory, and it is an audit log.**
  - Entries are append-only, "never edited in place"
    (`packages/server/src/ledger.ts:10-11`), so nothing can supersede or retire
    one.
  - Every matching entry goes into every dispatch prompt, with no cap
    (`entriesFor`, `ledger.ts:125-133`; `renderLedgerSection`,
    `orchestrator/prompt.ts:18-27`, pushed at `:75-76`).
  - The daemon writes its own receipts into the same table:
    - policy auto-decisions (`policyEngine.ts:600-618`)
    - floor holds (`:573-593`)
    - scope grants (`messaging/scopePolicy.ts:85-123`)
    - review's undeclared-write hazards (`orchestrator/review.ts:921-930`)
    - dependency-map degradation (`index.ts:1170-1179`)
  - This repo's `dispatch.db` on 2026-09-25 (read-only count) held 330 rows:
    - 300 undeclared-write hazards and 14 dependency-map notices, all authored
      `none`
    - 1 scope grant
    - 15 lessons that agents recorded, whose details run from 1,119 to 5,002
      characters
  - The 28 project-wide rows alone put 39,437 characters of title and detail
    into every dispatch prompt.
- **On SQLite projects, teammates never see each other's hazards.** Board sync
  replicates task ops only (`team/boardSync/engine.ts:25-45`).
- **Claude Code auto memory holds most of the real lessons, and Dispatch cannot
  see or curate it.**
  - Every Claude SDK session Dispatch starts in a checkout loads it. Auto memory
    is on by default and is read whatever `settingSources` says. Only
    `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns it
    off
    ([docs, "What settingSources does not control"](https://code.claude.com/docs/en/agent-sdk/claude-code-features)).
  - That covers dispatched runs (`orchestrator/executors/claude.ts:842`) and the
    overseer (`overseers/claude.ts:280`). It also covers sessions whose code
    believes it is isolated:
    - the planner, which leaves out `'user'` "to isolate from operator's
      personal environment" (`orchestrator/planners/claude.ts:324-327`);
    - the repo digest (`orchestrator/repoDigest.ts:141-146`);
    - the AI task filter, the inbox clusterer and commit-message generation
      (`aiTaskFilter.ts:158-170`, `inboxClusterer.ts:143-155`,
      `git/commitMessage.ts:60-73`).

    None of them sets either switch.

  - Every worktree of a repository shares one auto-memory directory
    ([docs](https://code.claude.com/docs/en/memory#storage-location)). So every
    one of these sessions reads the owner's personal notes, and runs write them,
    including a teammate's session on a shared host.
  - Codex runs get none of it.
  - The owner's directory for this repo holds 69 topic files behind a 69-line
    `MEMORY.md`. Every file keeps its kind under `metadata.type`: 45 `project`,
    13 `feedback`, 10 `reference`, 1 `user`. None has a top-level `type`
    (read-only count, 2026-09-25). They mix team facts (the 7-day release-age
    gate, flaky server tests) with personal preferences (terse comments), and
    one fact appears twice.

This spec does two things:

- It replaces the knowledge half of the ledger, and the runs' use of Claude's
  auto memory, with one store that has scopes, trust, a prompt budget and decay.
- It puts that store's logic in an MIT package, as messaging did.

## Architecture

```text
┌──────────────────────────────────────────────┐
│ @dispatch/memory  (MIT)                      │
│  entry + proposal types, validation, limits  │
│  MemoryStore interface + SQLite/FTS5 impl    │
│  MemoryEngine ── calls ──► MemoryHost        │
│  rank + render the budgeted index, decay     │
│  Claude auto-memory file format + diff       │
└───────────────────────▲──────────────────────┘
                        │ implements MemoryHost
┌───────────────────────┴──────────────────────┐
│ dispatchd  (FSL)                             │
│  HTTP routes, memory.changed, #1 principals  │
│  personal identities, run operators          │
│  memory gate through the DeliveryEngine      │
│  prompt index, Claude export/ingest          │
│  ledger import, decay scheduler              │
│  team memory ops: federation F3 (ELv2, v2)   │
└───────────────────────▲──────────────────────┘
                        │ HTTP
   packages/mcp (runs + external agents), desktop app, CLI
```

The engine is pure logic over its stores and a host interface. The daemon is one
host, and another product can be another.

`@dispatch/memory` is a new workspace package (`packages/memory`), a sibling of
`@dispatch/protocol` and not a folder inside it:

- Protocol is the wire format that #6 publishes; a memory store is not wire
  format.
- An embedder can take messaging without memory.

Its dependencies:

- `@dispatch/core`: `SqliteDatabase`, `openSqliteDb`, `dbVersion`, the
  `untrusted*` helpers, `TASK_ID_PATTERN`.
- `@dispatch/protocol`: `Address`, `parseAddress`, `Ref`, `createUlidFactory`,
  and `LINE_BREAK`. `LINE_BREAK` is newly exported from
  `packages/protocol/src/lines.ts:3`, so both packages reject line breaks
  identically.

### Files on disk

```text
$DISPATCH_HOME/.dispatch/runs/<projectKey>/memory.db                        project + team scopes, proposals
$DISPATCH_HOME/.dispatch/runs/<projectKey>/claude-memory/<lineage>/         one run lineage's Claude export
$DISPATCH_HOME/.dispatch/runs/<projectKey>/claude-memory/o-<conversation>/  an overseer export an older build left; closed, never ingested
$DISPATCH_HOME/.dispatch/memory/identities.db                               personal identities and their aliases
$DISPATCH_HOME/.dispatch/memory/<identity>.db                               one human's personal scope
```

- `<projectKey>` is `sha256(rootDir)[:12]`, the run-state key.
- `memory.db` sits beside `messages.db`, in the machine-local run-state
  directory (`orchestrator/paths.ts:26-32`, `messaging/service.ts:94-96`).
- A personal database is cross-project, so it cannot live in any one project's
  run-state.
- None of these is ever committed.
- **File modes.** `memory/` and every `claude-memory/` directory are 0700. Every
  database, its `-wal` and `-shm` files, and its `.bak` are 0600. The modes are
  set at creation and re-applied at open, as the teammate token file does
  (`team/teammates.ts:126-129`).
- **Busy timeout.** `openSqliteDb` sets WAL and `synchronous = NORMAL` but no
  busy timeout (`packages/core/src/sqliteDb.ts:357-367`). `openMemoryDb` adds
  `PRAGMA busy_timeout = 5000`, because a personal file is opened by one daemon
  per project and two of them must wait for each other instead of failing.
- **Versions.** Every database carries `PRAGMA user_version` (its schema
  version, `MEMORY_DB_VERSION = 1`) and `meta.min_reader_version`, the oldest
  schema version that can still read and write it.
  - Schema changes are additive: new tables and new nullable columns. They bump
    `user_version` and leave `min_reader_version` alone.
  - A build refuses a file only when `min_reader_version` exceeds its own
    `MEMORY_DB_VERSION`.
  - `openMessagesDb` refuses any newer file
    (`packages/protocol/src/sqliteStore.ts:61-75`). Memory cannot do that. All
    daemons under one `$DISPATCH_HOME` share the personal databases
    (`orchestrator/paths.ts:19-22`), including the installed app and a dev build
    on another root. So one newer build would lock every older daemon on the
    machine out of personal memory.
  - A change that cannot be additive bumps `min_reader_version` and is named in
    the release notes. An older daemon then shows "personal memory unavailable
    (written by a newer Dispatch)" (Failure handling).

### Personal identity

A handle cannot name a cross-project file, because handles belong to one
project's roster:

- `handleFromEmail` takes the email's local part and suffixes collisions within
  one roster only (`packages/core/src/team.ts:24-39`). So `alex@a.com` and
  `alex@b.com` are both `alex` in their own projects.
- The owner's handle is cached per `rootDir` (`actorContext.ts:40-43`,
  `:84-105`), so the owner can be `wyat` in one project and `wyat2` in another.
- A teammate's credential is "a handle" on one daemon
  (`team/teammates.ts:23-25`).
- Everyone without a git email becomes `local` (`FALLBACK_EMAIL`,
  `actorContext.ts:19`).

So personal stores are keyed by an identity, and handles are only per-project
aliases of it:

- **The daemon's own human** is identity `self`: the OS user whose
  `$DISPATCH_HOME` this is. Every project's owner alias binds to `self`,
  whatever handle or git email that project gives the owner. The owner's memory
  is therefore cross-project with no setup (decision Q2).
- **Anyone else** (a teammate on a shared host) gets a new identity,
  `pid-<ulid>`, the first time a principal acting for them touches personal
  memory in a project. The binding is an alias row,
  `(projectKey, handle) → identity`, which also records the roster email at
  binding time.
- **Linking.** A teammate reaches across projects after one explicit link.
  - `dispatch memory link`, in a project where they are already bound, prints a
    one-time code. The code lasts 10 minutes and is stored hashed.
  - `dispatch memory link <code>`, in another project, binds that alias to the
    same identity and moves any entries already made there.
  - Until they link, a teammate's personal memory is per project (Open question
    6).
- **A handle that now belongs to someone else.** If the roster email behind a
  bound handle has changed since binding (the handle was removed and reused),
  personal reads and writes answer 409 `conflict`: "this handle was bound to
  someone else; link or start fresh". Settings → Memory offers both. Nobody
  inherits a stranger's store by taking over a handle.
- **The placeholder email.** When the roster email is `local@localhost`, that
  check cannot tell people apart, and Settings → Memory warns until a real email
  is set.

### MemoryHost

```ts
// Messaging's principal, resolved per request from the presented credential
// (messaging/principal.ts:9-13). The shared agentToken never resolves to one (:28).
interface Principal {
  address: Address;
  canDecide: boolean; // the credential's tier allows decide
  kind: 'human' | 'run' | 'agent';
}

interface Operator {
  human: Address; // human:<handle> in this project
  identity: string; // 'self' or pid-<ulid>: which personal database
}

interface MemoryHost {
  // The human a principal acts for, or null (no personal scope). See "Who a run acts for".
  operatorOf(principal: Principal): Operator | null;
  projectKey(): string; // sha256(rootDir)[:12], the run-state key
  taskContext(taskId: string): IndexContext | null; // title, body, writes, epic, risk, a2a
  taskOfPrincipal(principal: Principal): string | null; // an execute run's task
  runTaskOf(principal: Principal): string | null; // any run's task, for A2A provenance
  // Policy's ruling for one open proposal, consulted before any gate is sent.
  rule(proposal: MemoryProposal): PolicyRuling;
  // Sends the memory gate for an open proposal, or returns the one already open for it.
  raiseGate(proposal: MemoryProposal): Promise<string>;
  // The ledger receipt and Activity line for a policy approval.
  recordPolicyApproval(proposal: MemoryProposal, ruling: AutoRuling): void;
  changed(change: MemoryChange): void; // memory.changed signal and live notify
  now(): Date;
}
```

- **Decide rights belong to the credential, not the address.** There is no
  `canDecide(address)`. The owner's one address, `human:<owner>`, is both the
  request-tier agentToken and the operator-tier app token
  (`identity.ts:113-127`). Messaging already passes the credential's tier as
  `canDecide` (`messaging/principal.ts:55-61`), and memory takes the same shape.
- **What `human` trust and direct shared writes need.** Both need a `Principal`
  of kind `human`. Direct shared writes also need `canDecide`.
- **Routes outside messaging.** A route that writes memory without going through
  messaging (amendments, and the ledger in v0) builds its principal the same
  way. A request presenting the shared agentToken never becomes a `human`
  principal. Its memory write is a proposal with `agent` trust, attributed as
  the route attributes it today (`humanActor`, `api/caller.ts:16-18`).

### Who a run acts for

`operatorOf` reads a new `RunMeta.operator` field: a human ref, or absent for
none. Every new run, a successor in a session lineage included, acts for the
principal that caused it: a human acts for itself, and the owner only on the
owner's app token; an agent, a run or the system (the auto wake policy among
them) acts for no one. A successor keeps its predecessor's operator only when
that operator is who caused it. (Amended by ruling MEM-R6: a successor used to
inherit its predecessor's operator whoever caused it.) An aux run follows the
same rule (ruling MEM-R7): one a human starts acts for that human, and one the
system starts after a run keeps that run's operator; it no longer copies the
task's latest execute run's operator. It is separate from `dispatchedBy`, which
keeps its meaning: who pressed dispatch, used for claims and decision ownership
(`orchestrator/types.ts:322-327`).

Ruling MEM-R8 adds four points:

- **Epic sessions.** Starting or resuming an epic session sets its `startedBy`
  to the caller by the rule above. A teammate's resume re-keys it to the
  teammate, and a resume on the agentToken clears it.
- **Epic auto-fill.** A fill run acts for `startedBy` only on a task that human
  created and last edited (title or body, Activity aside). Otherwise it acts for
  no one. `TaskAuthorship` (`orchestrator/taskAuthorship.ts`, persisted beside
  `epic-sessions.json`) records the creator and last editor. It is recorded by
  `POST /api/tasks`, `PATCH /api/tasks/:id` and plan confirm. A task created any
  other way, or changed since its last recorded edit, has no author.
- **Messaging a live run.** A request-tier human may not deliver into a live run
  whose operator is another human. This covers `POST /api/messages` to `run:`,
  overseer `message_run`, and a review send-back or request-changes on a live
  run. The refusal is a 403 that names the task and the operator to message
  instead. The decide tier and the run's own operator may deliver.
- **The owner's CLI acts for no one.** This is a behaviour change, documented
  and not fixed. The CLI presents the daemon file's agentToken, so a run it
  starts acts for no one unless the CLI is given the app token (`--token` or
  `DISPATCH_APP_TOKEN`). The desktop app and the sign-in cookie act for the
  owner.

| How the run starts                                                                                                                                   | `operator`                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch()` credited to a human (`orchestrator.ts:884-886`, stamped at `:903`)                                                                      | `dispatchedBy`                                                                                                                                                                                                                                    |
| `dispatch()` by the epic auto-fill, `actor: 'none'` (`orchestrator/epic.ts:846-848`)                                                                 | the epic session's `startedBy` (`EpicSession`, `epic.ts:72-86`: whoever last started or resumed it) on a task they created and last edited; otherwise none                                                                                        |
| resume (`resumeRun`, `orchestrator.ts:4955-5016`), request-changes (`requestChanges`, `:4826-4860`), `dispatchOrResume` and overseer `dispatch_task` | whoever asked for it, by the rule above; a teammate continuing the owner's run acts for the teammate. The boot recovery sweep, with no one asking, keeps the run's own                                                                            |
| wake (`messaging/host.ts`): a task or `run:` wake, or a gated wake a human approved                                                                  | the human sender, or the human who approved the gate, by the rule above; an agent or run wake under the auto policy has none                                                                                                                      |
| aux runs (`dispatchAuxRun`, `:956-1006`): review (`review.ts:836`), verify (`verify.ts:250`), fix-loop implementer (`fixLoop.ts:722`)                | a required `operator` option: the human who started it (review, verify, Review & fix, fix-loop advance), by the rule above; one the system starts after a run (auto review, fix-loop continuation, policy verify retry) keeps that run's operator |
| any run of a task with A2A provenance (a row in `a2a.db` `tasks.dispatch_task`, a2a-bridge-design.md "Tables")                                       | none, whoever dispatched it                                                                                                                                                                                                                       |
| runs recorded before this field                                                                                                                      | `dispatchedBy` if set, otherwise none                                                                                                                                                                                                             |

Today none of the successor `RunMeta`s carries attribution: the resume
(`:4989-5016`), the follow-up (`:4838-4860`) and the aux run (`:990-1006`) copy
the model, effort, claims and session but not `dispatchedBy`.

- **No operator means no personal scope.** The run's index and tools see no
  personal entries, a personal `memory_save` is `forbidden`, and the run uses
  `prompt` mode. No run ever falls back to the project owner.
- **Other principals.**
  - The owner's overseer reads memory as `agent:dispatch`, for no one: every
    request-tier caller can read its transcripts (see Overseer).
  - `agent:<op>/<name>` acts for `human:<op>`. The exception is names starting
    with `a2a.`, which are reserved for A2A clients (a2a-bridge-design.md
    "Addresses"). They have no operator and are refused on every memory route
    and tool.
  - A human acts for itself.
  - `agent:dispatch` acts for no one.

## Data model

### Entry

```ts
type MemoryKind =
  | 'preference' // how one human wants work done (personal scope only)
  | 'convention' // how this project does things (project/team only)
  | 'constraint' // a must or must-not
  | 'hazard' // a trap that will bite whoever walks into it
  | 'decision' // a choice others should stay consistent with
  | 'fact' // something true that the code and git history do not say
  | 'reference'; // where to find something outside the repo

// The same three words in storage, routes, tools and events. Which human a
// personal entry belongs to is the database it lives in (Personal identity).
type MemoryScope = 'personal' | 'project' | 'team';

interface MemoryEntry {
  id: string; // mem-<ulid>
  handle: string; // '#' + 8 Crockford base32 characters of sha256(id)
  scope: MemoryScope;
  kind: MemoryKind;
  title: string; // the whole lesson in one line; this is the index line
  body: string; // markdown: evidence, detail, how to apply
  refs: Ref[]; // protocol Ref: task | run | file | commit | message
  epic: string | null; // project/team only: narrows reach to one epic's tasks
  appliesTo: string[]; // project/team only: narrows reach to these tasks
  projectKey: string | null; // personal only: null = every project
  author: Address; // human, agent, run, or agent:dispatch
  trust: 'human' | 'confirmed' | 'agent';
  status: 'active' | 'retired';
  statusReason: 'forgotten' | 'superseded' | 'undone' | null;
  decay: 'fresh' | 'stale' | 'expired'; // local to this machine; never replicated
  pinned: boolean; // always first in the index, never decays
  supersedes: string | null;
  supersededBy: string | null;
  origin: string | null; // 'ledger:<id>@<createdAt>' | 'claude:<projectKey>/<path>' | 'amendment:<taskId>@<at>' | 'sync:<replica>'
  proposal: string | null; // the proposal that created it (shared scopes)
  decidedBy: Address | null; // the human who approved it
  decidedByPolicy: { rung: number; authorizedBy: 'rung' | 'override' } | null;
  rev: number; // bumped on every content or status change
  createdAt: string;
  updatedAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
}
```

- **Short handles.** A handle is `#` plus the first 8 Crockford base32
  characters of `sha256(id)`, which is 40 bits.
  - It is a hash rather than a slice of the ULID. `createUlidFactory` is
    monotonic: within one millisecond it increments the previous random part
    (`packages/protocol/src/ulid.ts:30-47`). A batch import would otherwise get
    handles that differ only in the last character, so one mistyped character
    would reach a sibling entry.
  - The `#` prefix cannot be read as an address (`<kind>:<id>`,
    `packages/protocol/src/address.ts:24-67`) or as a messaging id (`m-<ulid>`).
  - The index prints handles instead of 30-character ids, because every standing
    token is paid on every dispatch.
  - `memory_read` and `memory_forget` accept a handle or a full id. Given an
    `m-…` messaging id, they answer `invalid` with the hint "that is a message
    id; memory handles start with #".
  - A handle resolves only among entries the caller can see. One that matches
    two of them is a `conflict` that lists both full ids.
- **Displayed state.** Agents and the UI see one derived state:
  - `retired` when `status` is `retired` or `decay` is `expired`;
  - `stale` when `decay` is `stale`;
  - otherwise `active`.
- **Title and body.** The title carries the lesson and the body the evidence:
  the index shows only titles, so a hazard whose title does not say what to do
  is a hazard nobody reads. `memory_save`'s description says so.

### Proposal

A change to shared memory by anyone below the decide tier is a proposal. A
proposal is a row of its own, never an entry, so an unapproved or rejected
lesson is never an entry that other runs could read.

```ts
interface MemoryProposal {
  id: string; // mp-<ulid>
  action: 'add' | 'supersede' | 'retire';
  scope: 'project' | 'team';
  target: string | null; // supersede, retire: the active entry it changes
  baseRev: number | null; // supersede, retire: the target's rev when proposed
  content: {
    kind: MemoryKind;
    title: string;
    body: string;
    refs: Ref[];
    epic: string | null;
    appliesTo: string[];
  } | null; // add, supersede
  reason: string | null; // retire
  author: Address;
  operator: Address | null; // the author's operator: visibility and the promotion check
  runId: string | null;
  taskId: string | null;
  origin: string | null; // set by imports, so a re-import finds it
  contentHash: string | null;
  gate: string | null; // the gate message deciding it
  state: 'open' | 'approved' | 'rejected' | 'expired';
  decidedBy: Address | null;
  decidedByPolicy: { rung: number; authorizedBy: 'rung' | 'override' } | null;
  decisionReason: string | null;
  result: string | null; // the entry an approval created or changed
  createdAt: string;
  decidedAt: string | null;
}
```

### Validation

`validateMemoryInput` rejects:

- a `preference` outside personal scope;
- a `convention` inside it;
- `epic` or `appliesTo` on a personal entry;
- `projectKey` on a shared entry;
- an `epic` that is not an epic id;
- `appliesTo` entries that are not task ids (`TASK_ID_PATTERN`,
  `packages/core/src/ids.ts:103`);
- a `supersedes` or retire target that is not visible to the caller, not
  `active`, or **not in the same scope** as the new entry;
- line breaks in the one-line fields.

The same-scope rule means a shared entry can never retire a personal one.
Promoting a personal entry is a copy, and the source stays where it is.

Size limits per write:

| Field   | Limit                                  |
| ------- | -------------------------------------- |
| `title` | 200 bytes (UTF-8), one line, non-empty |
| `body`  | 8 KiB (UTF-8); long-form belongs to #4 |

Over 8 KiB, `memory_save` answers
`body: at most 8192 bytes (UTF-8); long-form belongs in a doc: doc_save it, then ref it from a short entry`.
| `refs` | 20 entries; `id`, `at` 512 bytes each | | `appliesTo` | 50 task ids |
| `reason` (forget, reject) | 500 bytes, one line | | `query` (search) | 500
bytes |

Every failure is a `MemoryError` whose `field` names the bad input. Its `code`
maps to a status the way `MessagingError`'s does: `invalid` 400, `forbidden`
403, `not-found` 404, `conflict` 409, `limited` 429, plus `unavailable` 503 when
a store cannot be opened.

### Scopes

Scope says who reads an entry and where it may travel. `epic` and `appliesTo`
only narrow which tasks it is relevant to.

| Scope    | Who reads it                                                                                     | Who writes it directly                                               | Leaves the machine           |
| -------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------- |
| personal | its human; runs whose operator is that human; agents registered under them (never `a2a.` agents) | its human; runs and agents acting for them (undoable)                | never                        |
| project  | every principal of this project on this daemon, except `a2a.` agents and A2A-provenance runs     | decide-tier humans; everyone else proposes through the `memory` gate | never                        |
| team     | as project, plus teammates' daemons once replicated (v2), minus `a2a.` agents                    | as project                                                           | board sync and receipts (v2) |

- **Project vs team.** Project scope exists because some shared facts are true
  only on one machine: "proto shims were missing here", "Homebrew pnpm shadows
  the pin". Every run on this daemon needs them; a teammate's machine does not.
  Team is the default for lessons about the code.
- **Personal reach.** Personal memory is cross-project by default, and a
  per-entry `projectKey` narrows it to one project (decision Q2). The key is
  `sha256(rootDir)[:12]`, the same key as run-state. Moving a checkout orphans
  its filters, and the desktop's Memory view (v2) can re-home them. For a
  teammate, "cross-project" starts after they link their identity.

### Who sees what

One rule, applied to list, search, read, handle resolution, the index, recalls
and the export:

| Object                            | Runs and agents                           | Humans below decide tier               | Decide-tier humans                   |
| --------------------------------- | ----------------------------------------- | -------------------------------------- | ------------------------------------ |
| active shared entries             | yes; `stale` ones marked                  | yes                                    | yes                                  |
| retired or expired shared entries | only with `includeRetired`, marked        | same                                   | same                                 |
| open proposals                    | their author, and the author's operator   | their own, and their runs' and agents' | all                                  |
| decided proposals                 | no                                        | their own                              | all, and the audit views             |
| personal entries                  | those whose operator is the entry's human | their own only                         | their own only; 403 on anyone else's |

`a2a.` agents see nothing. A2A-provenance runs see team entries only, because
their messages and artifacts may leave the machine (A2A decision Q12) and
project scope never does.

### Trust

| Trust       | Meaning                                       | How an entry gets it                                                                                                                                      |
| ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human`     | A human wrote it                              | Written by a `human` principal (a per-person credential, never the shared agentToken), directly or through a proposal that a decide-tier human approved   |
| `confirmed` | An agent wrote it and a human checked it      | A decide-tier human approved its proposal, or pressed Confirm (`POST /api/memory/:id/confirm`)                                                            |
| `agent`     | An agent wrote it and no human has checked it | Agents' personal writes, policy-approved proposals, Claude ingest and import, every ledger import (whatever its `authoredBy` says), and agentToken writes |

- Trust is never raised by an agent.
- An agent's edit of a `human` or `confirmed` entry is a new revision with
  `agent` trust, until a human approves it (`confirmed`).
- Index lines mark `agent` entries `unreviewed`, so a reading agent weighs them
  accordingly.
- Rank uses trust only as a tiebreaker (see Recall).

### Lifecycle and decay

```text
entry status (replicated for team):
  active ──forget / supersede──► retired ──undo / restore──► active

proposal state (local to the daemon that holds it):
  open ──approve──► approved   (creates or changes an entry)
    ├───reject───► rejected    (no entry changes)
    └───TTL──────► expired     (no entry changes)

decay (local to each machine, only while active):
  fresh ──60 days without use──► stale ──180 days without use──► expired
    ▲─────────────── any recall revives (stale or expired) ─────────┘
```

- **"Use"** is `max(lastRecalledAt, updatedAt)`.
- **Stale** entries leave the index and the Claude export, but stay searchable
  and marked `stale`.
- **Expired** entries are excluded from search unless `includeRetired: true`.
  They are kept for audit and never exported.
- **Exempt from decay:** pinned entries, and `human`-trust `constraint`s with no
  `origin`, that is, written directly as memory (the options doc, §B Decay).
  Amendment-derived, imported and synced constraints decay like any other entry.
- **Why decay is per machine.** Staleness means "unused here". A teammate's idle
  laptop must not retire what this machine's runs rely on, so decay changes are
  never replicated (see Team replication).
- **Keeping retired entries.** Retired entries and decided proposals are kept,
  since they are at most 8 KiB each.
- **Hard delete.** Only the entry's human (personal) or a decide-tier human
  (shared) can hard-delete an entry: from the desktop in v2, or with
  `dispatch memory delete` in v1.
  - A hard delete of an entry that has an `origin` leaves a tombstone in
    `deleted_origins`, in the same database.
  - Every import skips a tombstoned origin. The ledger is append-only
    (`ledger.ts:10-11`, with no delete in `LedgerStorePort`, `:24-28`) and is
    re-imported on every `ledger.changed`. Without the tombstone, a deleted
    imported entry would come back at the next policy receipt
    (`policyEngine.ts:592`, `:618`).
  - A hard delete of a team entry removes its receipt file at the next export,
    but does not scrub git history: earlier versions stay in the receipt log,
    and on any remote it was pushed to, until that history is rewritten.

### Tables

`memory.db` and each personal `<identity>.db` share one schema. Some tables are
used in only one of them.

```sql
entries  (id PK, handle UNIQUE, scope, kind, title, body, refs, epic, applies_to,
          project_key, author, trust, status, status_reason, decay, pinned,
          supersedes, superseded_by, origin UNIQUE, proposal_id, decided_by,
          decided_by_policy, rev, content_hash, created_at, updated_at,
          last_recalled_at, recall_count)
          -- refs and applies_to hold JSON text
entries_fts USING fts5(title, body, refs, content='entries',
          content_rowid='rowid', tokenize='porter unicode61')  -- + sync triggers
revisions (memory_id, rev, snapshot_json, by_addr, cause, at,
          PRIMARY KEY (memory_id, rev))   -- cause: save|edit|retire|undo|gate|import|ingest|decay|sync
recalls  (memory_id, run_id, via, at, PRIMARY KEY (memory_id, run_id, via))
          -- via: index | search | read | claude-recall; runs only; kept in the entry's own database
deleted_origins (origin PK, entry_id, deleted_by, at)
meta     (key PK, value)
          -- last_decay_at, min_reader_version, ledger-import:<version>,
          -- ledger-cutover-at, claude-import:<projectKey>

-- memory.db only
proposals (id PK, action, scope, target, base_rev, content_json, reason, author,
          operator, run_id, task_id, origin UNIQUE, content_hash, gate_id, state,
          decided_by, decided_by_policy, decision_reason, result_id,
          created_at, decided_at)
exports  (lineage, file, store, memory_id, rev, parsed_hash,
          PRIMARY KEY (lineage, file))

-- personal databases only
activity (id PK, at, kind, memory_id, run_id, summary)
          -- kind: saved | edited | retired | ingested | throttled | ingest-problem
ingest_problems (id PK, lineage, file, reason, size, sha256, content, at)
          -- content ≤ 8 KiB, readable only by the identity's human

-- identities.db
identities (id PK, created_at)
aliases  (project_key, handle, identity_id, email_at_bind, bound_at,
          PRIMARY KEY (project_key, handle))
link_codes (code_sha256 PK, identity_id, expires_at)
```

- **The FTS column is `refs`.** An external-content FTS5 table reads its column
  values from the content table by name. With FTS columns `(title, body, refs)`
  over a table whose column is `refs_json`, `MATCH` finds the row but
  `snippet()` fails with "SQL logic error" (reproduced with sqlite3 3.51.0 on
  2026-09-25). `memory_search` relies on `snippet()`, so the entries column is
  named `refs`.
- `content_hash` is `sha256(kind, title, body, refs)`. It detects duplicate
  proposals and duplicate imports.
- A `recalls` row answers "what did this run see?". A recall by a human or an
  external agent only bumps `last_recalled_at` and `recall_count`. Recalls of
  personal entries stay in the personal database, so `memory.db` never records
  which personal entries a run read.
- Writes run in `BEGIN IMMEDIATE` transactions, and every change appends its
  revision in the same transaction. Undo is always one revision back and never
  destructive.

Retrieval is SQLite FTS5 (decision Q9):

- **Verified to work** on this repo's pinned runtimes, 2026-09-25:
  - Bun 1.3.14, which uses the macOS system SQLite 3.51.0;
  - Node 24.11.0, whose bundled SQLite is 3.50.4.
- **Fallback.** If creating the virtual table fails (`no such module: fts5`),
  the store opens in fallback mode and `GET /api/memory/health` reports
  `search: 'like'`. In that mode:
  - search ANDs the query terms as `LIKE` over title and body;
  - results rank by recency;
  - `snippet` is the first 160 bytes of the body.

### Configuration

Every key lives under `memory:` in `.dispatch/config.yml` and is read per use,
as policy is (`policyEngine.ts:50-66`), so an edit takes effect without a
restart. An invalid value falls back to its default, and Settings → Memory shows
a warning naming the key.

| Key                     | Default                          | Allowed                                 |
| ----------------------- | -------------------------------- | --------------------------------------- |
| `indexTokens`           | 1000                             | integer 200–4000                        |
| `personalWritesPerHour` | 50                               | integer 1–500                           |
| `proposalsPerHour`      | 10                               | integer 1–100                           |
| `maxOpenProposals`      | 50                               | integer 1–500                           |
| `proposalTtlDays`       | 14                               | integer 1–90                            |
| `staleAfterDays`        | 60                               | integer 7–3650                          |
| `retireAfterDays`       | 180                              | integer, above `staleAfterDays`, ≤ 3650 |
| `claudeAutoMemory`      | `export` (the live probe passed) | `export` or `off`                       |

## Recall

Decisions Q5 and the task brief: a budgeted index goes in the prompt, and bodies
are read on demand through tools.

### The index

`renderIndex(entries, context, budgetTokens)` is pure and in the MIT package.
Its inputs:

- **Candidates:** every entry the run may see (Who sees what) with displayed
  state `active` (fresh), whose reach matches the context:
  - `epic` is null or the task's parent;
  - `appliesTo` is empty or contains the task;
  - a personal entry's `projectKey` is null or this project.
- **Relevance query:** built from the task's title, the path segments of its
  `writes`, and the first 1,000 bytes of its body:
  - lowercase words of at least 3 characters, minus a fixed list of stopwords;
  - at most 32 terms, each double-quoted and OR'ed, so FTS syntax in task text
    cannot change the query.

Rank, compared in order, highest first:

1. `pinned`.
2. Kind class:
   - `constraint`, `hazard` = 3;
   - `decision`, `convention`, `preference` = 2;
   - `fact`, `reference` = 1.
3. Specificity:
   - `appliesTo` names the task = 3;
   - `epic` matches = 2;
   - whole project, team or personal = 1.
4. Relevance: whether the entry matched the query, then its `bm25` score.
5. Trust: `human` > `confirmed` > `agent`.
6. `max(lastRecalledAt, updatedAt)`, newest first.
7. `id`, so ties are deterministic.

Lines are added in rank order until the next line would cross the budget.
Rendering stops there and never skips ahead to a shorter line, so a lower-ranked
entry never displaces a higher one.

- **Budget:** `memory.indexTokens`.
- **Token estimate:** `ceil(utf8Bytes / 3)`. That overestimates English and
  code, and the renderer never exceeds it.
- **Reserved room:** the header and the overflow line.
- **Pinned overflow:** if pinned entries alone exceed the budget, the
  lowest-ranked pinned ones are cut too, and the desktop warns "pinned memory
  exceeds the index budget".

```text
## Memory
Lessons and preferences from earlier work, one line each. Open one with
memory_read("#…"); memory_search finds more. "unreviewed" lines were written
by an agent and no human has checked them.
- hazard · epic · unreviewed: pnpm 11 ignores onlyBuiltDependencies; use allowBuilds (#7QX2K9PA)
- constraint · task: /api/sessions response shape is frozen for the client team (#K3M0Q1ZD)
- preference · you: comments are one or two lines; no incident narratives (#A8C4TT2N)
- convention · unreviewed: run tests with `bun run test`, never bare `bun test` (#QW90PX1E)
(14 more not shown; memory_search finds them)
```

- **Reach tags:**
  - `you` = personal;
  - `local` = project scope;
  - `epic`, `task` = narrowed;
  - no tag = team, project-wide.
- **Untrusted text.** Titles go through `untrustedInline`
  (`packages/core/src/untrusted.ts:16-20`), as the ledger's did.
- **Placement.** `## Memory` replaces the ledger section in `buildTaskPrompt`
  (`orchestrator/prompt.ts:41-53`, `:75-76`). `promptForTask`
  (`orchestrator.ts:5147-5167`) asks the memory service for the index instead of
  calling `ledgerStore.entriesFor`.
- **Executors without the dispatch MCP server** (`dispatchMcp: false`,
  `prompt.ts:48-50`) have no tools to open a body with, so their variant:
  - drops the header's tool sentence and the overflow line's hint;
  - renders, under each class-3 line (`constraint`, `hazard`), its body cut to
    300 bytes on a character boundary, through `untrustedBlock` and indented;
  - counts those bodies against the same budget, so fewer lines fit.

  Today `renderLedgerSection` renders every entry's full detail
  (`prompt.ts:20-27`), so these executors keep the substance of the top hazards
  and constraints.

- **Other prompts.** Review, verify, planner, enrich and draft prompts carry no
  ledger section today, and get no index.

Each included entry records an `index` recall for the run. An `index` recall
counts as use for decay only when the entry matched the relevance query or is
narrowed to the task or its epic. An entry that merely fills the index is not
evidence that anyone needed it.

### Tools

See MCP tools. `memory_search` and `memory_read` ship with the index in v0,
because the index only prints titles and the bodies of the 15 imported lessons
(1–5 KB each) must stay reachable. `memory_search` records a `search` recall for
every hit it returns, and `memory_read` records a `read` recall. Either revives
a stale or expired entry.

### Live notify

When a `project` or `team` entry of kind `hazard` or `constraint` becomes
active, the service hands a digest line to every live execute run that may see
it and whose task it reaches, other than the author's own run:

- The line goes through `orchestrator.notifyRun` (`orchestrator.ts:709-723`),
  the same path messaging's channel digests take (`messaging/host.ts:101-103`):

  ```text
  🧠 memory · hazard from run:r-9f2c01: <title cut to 80 characters> (#7QX2K9PA)
  ```

- It is not a message and is never held or retried. Runs that start later see
  the entry in their index.

## Writes

| Caller                                                    | Personal (own operator's)               | Project / team           |
| --------------------------------------------------------- | --------------------------------------- | ------------------------ |
| human, decide tier                                        | direct, `human`                         | direct, `human`          |
| human, below decide tier                                  | direct, `human`                         | proposal → `memory` gate |
| run with an operator                                      | direct, `agent`, undoable (decision Q4) | proposal → `memory` gate |
| run with no operator                                      | forbidden                               | proposal → `memory` gate |
| approved external agent (`agent:<op>/<name>`)             | direct, `agent`, undoable               | proposal → `memory` gate |
| agent with no operator (`agent:x`)                        | forbidden                               | proposal → `memory` gate |
| `a2a.` agent                                              | forbidden                               | forbidden                |
| shared agentToken (amendments only, and the ledger in v0) | —                                       | proposal, `agent` trust  |
| anyone, into another human's personal scope               | forbidden (deciding humans included)    | —                        |

Lifecycle operations, per scope:

| Operation                | Personal entry                                         | Shared entry                               |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------ |
| save, edit               | its human; runs and agents acting for them             | decide tier: direct. Anyone else: proposal |
| retire (forget)          | its human; runs and agents acting for them (undoable)  | decide tier: direct. Anyone else: proposal |
| undo                     | its human                                              | decide tier                                |
| confirm                  | its human                                              | decide tier                                |
| pin, unpin               | its human                                              | decide tier                                |
| hard delete              | its human                                              | decide tier                                |
| promote (copy to shared) | its human: direct at decide tier, otherwise a proposal | —                                          |

Anyone else gets 404 on a personal entry, or 403 with the reason if they are a
decide-tier human (Privacy).

### Personal writes and undo

- A direct personal write commits the entry, its revision and an `activity` row
  in the operator's personal database, in one transaction.
- The host's `changed` hook then emits `memory.changed` with
  `{ scope: 'personal' }` and nothing else.
- **Where Undo lives.** The desktop Inbox reads
  `GET /api/memory/activity?since=`. The route answers only the caller's own
  identity (a `human` principal), and the Inbox shows each row as a `recorded`
  item: `run:r-9f2c01 saved to your memory: <title> [Undo]`.
  - Personal titles never go through a messaging notice, a decision-feed item, a
    webhook, or any WS payload. Deciding humans can read any message
    (`messaging/routes.ts:64-72`), decision-feed items without `owner` go to
    everyone (`decisionFeed.ts:83-85`), and the Inbox's own entries are kept
    only client-side (`apps/desktop/src/lib/inbox.ts:49-72`).
  - An agent write appends nothing to the ledger, since personal memory never
    enters receipts.
- **Undo** (`POST /api/memory/:id/undo`, or the Inbox button) restores the
  previous revision as a new revision, with cause `undo`. Undoing a creation
  retires the entry with reason `undone`.
  - Undo has no time limit, because revisions are kept.
  - Only the entry's own human may undo a personal write.
- **Rate limit.** `memory.personalWritesPerHour` per run or agent counts tool
  writes and ingested files together. Over it:
  - a tool write is `limited`;
  - an ingested file goes to `ingest_problems` with its content, and the owner
    can accept it later from Settings → Memory;
  - one `throttled` activity row tells the operator.

### Proposals

`MemoryEngine.propose(input, principal)`:

1. **Authorize and validate** (above).
2. **De-duplicate** within the scope:
   - an `add` or `supersede` whose `content_hash` matches an active entry or an
     open proposal is a `conflict` naming it;
   - one matching a proposal rejected in the last 30 days is a `conflict` saying
     who rejected it and when, so an agent cannot re-ask until someone gives in;
   - a `retire` of a target that already has an open retire proposal is a
     `conflict` naming it.
3. **Rate limit:**
   - `memory.proposalsPerHour` per run or agent;
   - `memory.maxOpenProposals` open proposals per project, counted from
     `proposals`;
   - ledger-import and sync proposals are exempt from both, because they are
     bounded by what arrives, not by what an agent asks.
4. **Store** the proposal as `open`, and commit.
5. **Consult policy**, outside any transaction: `host.rule` calls
   `consultProjectPolicy(rootDir, 'memory', risk)` (`policyEngine.ts:56-66`).
   - `risk` is the source task's risk. A proposal with no task (an external
     agent, the overseer, a human, an import) reads as `elevated`. That caps the
     rung at 3 (`RISK_RUNG_CAPS`, `packages/core/src/policy.ts:82-86`), and a
     per-gate `auto` pin does not beat the cap (`:74-80`). So such a proposal
     always waits for a human.
   - **Promotion check.** The engine blocks auto-approval, whatever the ruling,
     when the proposal's `content_hash` or normalized title (lowercased,
     whitespace folded) equals one of its operator's personal entries. The
     reviewer's card says "matches a personal entry of the author's operator",
     and never shows that entry.
6. **On `auto`**, one transaction applies the proposal (Effect, below) as the
   system, records `decidedByPolicy`, and marks the proposal `approved`.
   `host.recordPolicyApproval` then writes the receipt. No gate is sent, so
   nobody is notified of something already decided.
   - This differs from scope auto-grants on purpose. Those send the gate and
     answer it from an asynchronous subscriber with `void engine.reply(...)`
     (`messaging/scopePolicy.ts:127-163`), after the owner has already been
     notified of it.
7. **On `block`**, `host.raiseGate` sends the `memory` gate through the
   messaging `DeliveryEngine`, as `agent:dispatch`, to the project owner. It
   first looks for an open memory gate whose `data.proposalId` matches
   (`openBlocking`, `packages/protocol/src/store.ts:76`) and returns that one
   instead of sending a second. The gate id is then recorded on the proposal.
8. **Return** the state re-read from the store, not the host's word:
   `{ status: 'active', handle }`, or `{ status: 'proposed', proposal, gate }`.

A proposal is one of three actions:

- `add`;
- `supersede`: new content naming an active `target` in the same scope;
- `retire`: `memory_forget` on a shared entry, naming the `target`.

A crash between steps 4 and 7 leaves an open proposal with no gate id.
`memory.recover()` calls `raiseGate` for it at boot, which finds a gate sent
before the crash rather than sending another. If two open gates exist for one
proposal anyway, recover closes every one but the recorded gate as the system.

## The `memory` gate

A new `GateData` variant (`packages/protocol/src/envelope.ts:66-97`), also added
to `GATE_TYPES` (`:66-72`):

```ts
| {
    type: 'memory';
    proposalId: string; // mp-<ulid>
    action: 'add' | 'supersede' | 'retire';
    scope: 'project' | 'team';
    kind: MemoryKind;
  }
```

- **No content in the message.** The title and body stay in `memory.db`, and the
  card reads them through `GET /api/memory/proposals/:id` (decide tier or the
  author). So proposal content never enters `messages.db`, the `message.new`
  event, the decision feed or a webhook.
- **Shape.** The message is exactly `kind: 'question'`, `blocking: true`,
  `choices: ['approve', 'reject']`. `refs` names the task and run.
- **Body.** One content-free line:
  `run:r-9f2c01 proposes a team memory (hazard). Review it in Needs you.` The
  decision feed's summary is the body's first line (`decisionFeed.ts:477`), so
  the feed item and anything built from it carry no title either.
- **Validation.** As with scope gates, validation checks the payload shape and
  names the correct one in its error.
- **Who raises and answers it.** Only the system or a deciding human may raise
  one: the existing rule for every gate but `scope` (`envelope.ts:186-192`).
  Answering one needs the `decide` tier, like every gate.

**Autonomy ladder.** The changes, in `packages/core/src/policy.ts` and the
desktop:

- `PolicyGate` gains `'memory'` (`:13-18`), and so does `POLICY_GATES`
  (`:21-27`).
- `GATE_RUNGS.memory = 4` (`:67-73`): the top rung, per the controller's ruling,
  because a bad team lesson reaches every teammate's runs.
- **Config hazard.** A `.dispatch/config.yml` naming `policy.gates.memory` used
  to be a `ConfigError` on a build without the gate. Docs Task 3a made
  `parsePolicyConfig` skip an unknown gate key with a warning instead, one
  release before the `memory` gate shipped, so a teammate's older build ignores
  the pin rather than refusing the file.
- **Rung 4 is relabelled**, since it now covers two gates:
  - core's stop (`:50`) keeps the name `auto-merge`, which config and old
    receipts use, and its label becomes "Auto-merge on green and accept agents'
    team memory and doc edits" (the `doc` gate joined it in docs v1);
  - the desktop slider's label
    (`apps/desktop/src/components/settings/PolicySection.tsx:56`) becomes "Merge
    and accept memory and doc edits on their own";
  - its description (`:48`) gains "Agents' lessons join shared memory without
    review";
  - rung 3's description (`:47`) ends "Merging, shared memory and accepted docs
    still wait."
- **Receipts name the gate.** `describePolicyAuthorization`
  (`policy.ts:261-270`) now names the gate instead of the stop:
  `auto-decided by policy rung 4 (memory gate)`, and likewise for every gate.
  The leading `auto-decided by` marker is unchanged, so the desktop's
  `isPolicyReceipt` (`apps/desktop/src/lib/policyReceipts.ts:6`) and ledger
  classification rule 2 still match.
- `RISK_RUNG_CAPS` (`:82-86`) applies as for every gate:
  - a proposal from an `elevated` task (cap 3), or with no task, always waits
    for a human;
  - so does one from a `critical` task (cap 1).
- The existing per-gate pins apply unchanged:
  - `policy.gates.memory: block` keeps every proposal human;
  - `auto` approves routine-task proposals at any rung. It cannot beat a risk
    cap.
- The desktop's gate table gains a row (`PolicySection.tsx:61-82`): "Shared
  memory from agents: an agent's lesson joins the memory every run here, and
  every teammate's run, reads."

**Effect.** `gates.register('memory', …)` (`messaging/gates.ts:18-34`) calls
`engine.applyGateAnswer(question, answer)`:

- **Idempotence.** The handler looks up the proposal by `data.proposalId`. It
  does nothing unless the proposal is `open` and its recorded gate is this
  question. So the messaging engine's replay of unapplied gate effects is safe
  (spec :283-291).
- **approve:**
  - `add` creates the entry as `active`;
  - `supersede` creates the entry, and retires the target with `superseded` and
    links `supersededBy` if the target is still active. If the target was
    retired meanwhile, the new entry still stands;
  - `retire` retires the target with `forgotten` if it is still active;
  - the proposal becomes `approved`, with `result` set.
- **Trust after approval:**
  - `human` when the author was a `human` principal. Such proposals have no
    source task, so a human always approves them;
  - otherwise `confirmed` when a human approved;
  - `agent` when policy did, since a rung is not a review.
- **reject:** the proposal becomes `rejected`, and the answer's body is kept as
  its reason. No entry changes, so rejecting a retire leaves its target active.
  If the author's run is live, it gets a digest line through `notifyRun`.

**Receipts.** A policy approval writes the ledger receipt that the policy engine
writes for every auto-decision (`policyEngine.ts:600-618`):

- a `decision` titled `Memory approved: team hazard #7QX2K9PA`, with no title
  text, so project-scope content never reaches the ledger (which travels with
  the repo on the files backend);
- its detail:
  `proposal mp-… from run:r-… — auto-decided by policy rung 4 (memory gate)`;
- a `[policy]` Activity line on the source task.

Human decisions write no receipt; the gate thread is the record.

**Expiry.** A decay pass closes open proposals older than
`memory.proposalTtlDays` as the system:

- `choice: 'reject'`, `data: { type: 'x-expired' }`;
- the proposal becomes `expired`, and no entry changes.

**Notifications.** A new `NotificationKind`, `'memory'`
(`packages/core/src/configTypes.ts:343-381`), on by default:

- `notificationKindForMessage` returns it for memory gates;
- memory gates can be quieted without muting approvals;
- the desktop's gate list gains `'memory'`
  (`apps/desktop/src/lib/gates.ts:34-40`);
- the webhook posts the feed item unchanged (`webhookDelivery.ts:113-125`),
  which is content-free for memory gates (Body, above).

**Federation (#5).** Project-scope proposals, their gate messages and project
entries are never federated. #5 must carry this rule.

## Ledger split

Decision Q1: memory takes constraint, hazard and decision, through an import
with count parity. The ledger stays, audit-only.

### Classification

`classifyLedgerEntry` (FSL, `packages/server/src/memory/ledgerImport.ts`) sorts
every row. The first matching rule wins:

| #   | Rule                                                                                   | Goes to | Source of the marker                                                             |
| --- | -------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| 1   | `kind === 'handoff'`                                                                   | audit   | messaging retired handoffs (spec :517)                                           |
| 2   | `detail` contains `auto-decided by` and a space                                        | audit   | `describePolicyAuthorization` (`policy.ts:261-270`), as `policyReceipts.ts:6-14` |
| 3   | `detail` contains `held by the irreversibility floor (`                                | audit   | `describeFloorHold` (`policy.ts:251-254`)                                        |
| 4   | `title` starts with `Scope extended for run` and a space                               | audit   | `api/scopeRequests.ts:176-186`, `messaging/scopePolicy.ts:113-121`               |
| 5   | `authoredBy === 'none'` and `title` matches `^changed .+ outside its declared writes$` | audit   | `review.ts:221-223` (both the batched and the older per-file spelling)           |
| 6   | `authoredBy === 'none'` and `title === 'dependency map degraded'`                      | audit   | `index.ts:1170-1179`                                                             |
| 7   | anything else (`constraint`, `hazard`, `decision`)                                     | memory  | —                                                                                |

A test pins rules 2 and 3 against core's own output, as `policyReceipts.test.ts`
does for the desktop.

### Mapping

A row that goes to memory becomes one entry, or one proposal after the cutover
(When it runs):

- **Content:**
  - same `kind`;
  - `title` cut to 200 bytes on a character boundary, with any overflow
    prepended to the body;
  - `body` = `detail`. A detail over 8 KiB is cut, with a final line
    `[truncated on import: N bytes]`, and counted as `truncated`.
- **Scope and reach:**
  - `scope: 'team'`: the ledger was the project's shared record, and on the
    files backend it already traveled with the repo;
  - `epic` = `epicId`;
  - `appliesTo` = `appliesTo`;
  - `refs` = the source task, when set.
- **Author and trust:**
  - `author` = `authoredBy` when it is a `human:` or `agent:` ref, shown as "as
    recorded in the ledger". Otherwise (`''` from pre-team records, or `none`)
    it is `agent:dispatch`, and the desktop labels it "imported from the ledger;
    author not recorded".
  - `trust` is `agent` for every row. A ledger `authoredBy` is not evidence of
    who wrote a row. `POST /api/ledger` without a `runId` credits the caller,
    and the shared agentToken is that caller as the owner
    (`api/findings.ts:180-183`, `api/caller.ts:16-18`, `identity.ts:113-127`).
    Neither `ledger` nor `tasks/*/amend` is an elevated route
    (`api.ts:4442-4495`, falling back to `request` at `:4647`). A git-pulled
    `.dispatch/ledger.jsonl` line says whatever its writer put there. A
    decide-tier human can confirm imported entries in bulk:
    `dispatch memory confirm --origin ledger`.
- **Identity and timestamps:**
  - `origin` = `ledger:<id>@<createdAt>`, because ledger ids can repeat with
    different `createdAt` (`ledger.ts:52-73`);
  - `createdAt` and `updatedAt` = the row's `createdAt`;
  - `lastRecalledAt` = import time. The ledger has been putting every one of
    these rows in every prompt, so their decay clock starts at the import, not
    60 days in the past.

### Parity

The import runs in one transaction and reports like `migrate.ts`
(`packages/core/src/migrate.ts:95-121`, `:575-600`), with real `COUNT(*)`
queries on both sides:

```text
ledger rows read        330   (constraint 0 · hazard 319 · decision 11 · handoff 0)
→ memory                 15   (imported 15 · proposed 0 · truncated 0 · already imported 0, of which deleted 0)
→ audit-only            315   (policy 0 · floor 0 · scope 1 · undeclared-writes 300 · dep-map 14 · handoff 0)
damaged                   0
memory rows       0 → 15
open proposals    0 → 0
```

The figures are this repo's ledger, counted read-only on 2026-09-25. The run is
`MISMATCH`, with the transaction rolled back, when any check fails:

- `read ≠ memory + audit + damaged`;
- memory `≠ imported + proposed + already imported`;
- memory rows `after ≠ before + imported`;
- open proposals `after ≠ before + proposed`.

A row counts as already imported when its origin is on an entry, on a proposal,
or in `deleted_origins`.

**When it runs:**

- at daemon boot, after the stores open and before HTTP serves;
- again on every `ledger.changed` event (`events.ts:93`);
- on the files backend, also when `.dispatch/ledger.jsonl` changes on disk, as
  after a `git pull`.

**The cutover.** The first boot of the build that removes the ledger's lesson
writers (v1) records `meta.ledger-cutover-at`.

- Rows the first import after it finds, created before it, import as `active`
  entries: parity with what prompts already carried. That import records
  `meta.ledger-cutover-swept-at`.
- Every other row can only come from elsewhere: a teammate's older build through
  a `git pull`, or a hand edit. That covers a row created after the cutover, one
  with no parseable `createdAt`, and any row the first import did not see,
  whatever `createdAt` it claims. They import as open `add` proposals, authored
  `agent:dispatch`, showing the row's `authoredBy` as a claim. With no task,
  they read as `elevated` and wait for a human.
- In v0 there is no cutover and no gate, and every row imports as `active` with
  `agent` trust. That is today's exposure (every lesson row already reaches
  every prompt), now marked `unreviewed`.

`POST /api/memory/import/ledger?dryRun=1` and
`dispatch memory import-ledger --dry-run` print the report without writing.

**Verification before v0 lands.** Parity must be shown on this repo's ledger and
on the audio-book project's. This is the migration chain's rule (options §7).

### After the split

| Ledger writer                                                                        | After                                                                                     |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `POST /api/ledger` (`api/findings.ts:185-237`), used by humans and `record_decision` | Removed in v1; `POST /api/memory` replaces it. `GET /api/ledger` stays as the audit read. |
| `record_decision` (`packages/mcp/src/tools.ts:1139-1160`)                            | Removed in v1 for `memory_save`, with no alias (messaging's cutover rule, spec :529-531)  |
| Amendments' constraint (`api/amendments.ts:42-57`)                                   | A `team` `constraint`, written through the write policy (below)                           |
| Policy receipts, floor holds, scope grants, undeclared writes, dep-map notices       | Unchanged: they are the audit log                                                         |
| Memory gate policy approvals                                                         | New audit receipts (above)                                                                |

**Amendments.** `POST /api/tasks/:id/amend` still amends the task, and the
task's own prompt still renders the amendment (`prompt.ts:29-37`). The
constraint that today reaches other tasks goes through the memory write policy,
as the caller's principal:

- a decide-tier `human` principal writes it directly, with `human` trust;
- anyone else, including the shared agentToken, proposes it through the gate;
- reach: `appliesTo` = the amended task's dependents at amendment time (tasks
  whose `dependsOn` names it, at most 50). With no dependents, `epic` = the
  task's parent. With no parent either, it is project-wide;
- `refs` = the task, and `origin` = `amendment:<taskId>@<at>`;
- it decays like any other entry. An amendment is about one task, so it must not
  become a permanent, top-ranked, project-wide rule.

**Readers of the ledger:**

- no prompt reads it after v0;
- `GET /api/ledger?class=audit` returns only rows `classifyLedgerEntry` sorts to
  `audit`. The desktop's Receipts pane and the overseer's `ledger_entries` tool
  (`overseerTools.ts:411-422`, now described as "audit receipts: policy
  decisions, holds, grants") read it. The imported lesson rows then appear once,
  in the Memory pane, with their memory state;
- `GET /api/ledger` without `class` stays unchanged for older clients.

**Kinds.** `LEDGER_KINDS` (`packages/core/src/ledger.ts:40-45`) keeps its
values, so history still parses.

## Claude auto-memory round-trip

Decision Q6(d): point Claude's `autoMemoryDirectory` at a Dispatch-managed
export. Claude then reads and writes files Dispatch owns, and Dispatch ingests
them.

### How the setting reaches a run (verified)

- **The key.** `Settings.autoMemoryDirectory?: string` exists in the pinned
  Agent SDK 0.3.207 (`pnpm-workspace.yaml:117`; `sdk.d.ts:6286-6288`), which
  bundles Claude Code 2.1.207 (`package.json:83`). Beside it are
  `autoMemoryEnabled` (`:6282-6284`) and `autoDreamEnabled`, background
  consolidation (`:6290-6292`). The SDK files live under
  `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.207…/node_modules/@anthropic-ai/claude-agent-sdk/`.
- **The layer.** The query option `settings` takes a settings object or a path
  to one. It loads into the flag-settings layer, the same layer as the CLI's
  `--settings` flag (`sdk.d.ts:1818-1835`).
- **Precedence.** `autoMemoryDirectory` "is read from any settings scope: user,
  project, local, policy, or --settings". The value must be an absolute path or
  start with `~/`
  ([storage location](https://code.claude.com/docs/en/memory#storage-location)).
  Only managed settings outrank the flag layer
  ([precedence](https://code.claude.com/docs/en/settings)).
- **Per-run scoping.** A run gets its own directory through the options of its
  own `query()` call.
- **What Claude loads.**
  - The first 200 lines or 25 KB of `MEMORY.md` load at session start.
  - Topic files are read on demand with the ordinary file tools.
  - Subagents do not load the main auto memory
    ([how it works](https://code.claude.com/docs/en/memory#how-it-works)).
- **Which CLI runs.** A packaged daemon runs whatever CLI `openClaudeQuery`
  resolves: `DISPATCH_CLAUDE_BIN`, then the bundled CLI, then `claude` on PATH
  (`orchestrator/claudeCli.ts:31-79`). That CLI can predate
  `autoMemoryDirectory` (added in 2.1.74). It can also hit reported bugs where
  the setting is ignored
  ([#33535](https://github.com/anthropics/claude-code/issues/33535), closed as
  not planned) or the system prompt still names the default path
  ([#36636](https://github.com/anthropics/claude-code/issues/36636)). So export
  mode is gated per CLI version (Modes).
- **Version note.** The `modified` frontmatter stamp needs Claude Code 2.1.214
  or later (same page), and Claude Code nests it under `metadata` (Export).
  Dispatch never relies on it for change detection; it compares against its own
  manifest.

### Modes

The orchestrator picks a mode per session before building the prompt, and passes
it as `ExecutorStartOptions.memory: { mode, dir? }`
(`orchestrator/types.ts:157-192`). `RunMeta` records `memoryMode` for diagnosis.
The procedure, first match wins:

```text
1. the executor is not Claude                                   → prompt
2. the run's kind is not execute (review, verify)               → prompt, and no index (their prompts carry none)
3. the run has no operator                                      → prompt, no personal entries
4. the operator is the owner, and the owner's Claude import for
   this project is not complete (running, failed or unconfirmed) → native
5. memory.claudeAutoMemory is off                               → prompt
6. the export preflight fails, or the export cannot be written   → prompt
7. otherwise                                                    → export
```

| Mode     | Index goes in            | Claude flag settings                                                                                                                                                                                           |
| -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export` | the export's `MEMORY.md` | `autoMemoryEnabled: true`, `autoMemoryDirectory: <dir>`, `autoDreamEnabled: false`, `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0'`, read/edit allow rules for `<dir>`; query option `additionalDirectories: [dir]` |
| `native` | the prompt               | none: Claude's own auto memory, as today                                                                                                                                                                       |
| `prompt` | the prompt               | `autoMemoryEnabled: false`, `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'`                                                                                                                                         |

- **Why `native` wins over `off` and over a failed preflight.** Both would
  otherwise hide the owner's notes before they are imported, which is exactly
  what the controller's ruling on the import prevents.
- **Why only the owner.** Step 4 is the only way to `native`. A teammate's run
  reaches `prompt` or `export`, never the host owner's notes.
- **Why execute runs only.** Review and verify runs get neither an index nor an
  export. They also stop loading the owner's notes, which they do today.
- **Why the env var is pinned.** A settings file's `env` block reaches the CLI's
  environment, including a `settings.local.json` an agent writes. That is why
  the floor pins `CLAUDE_CODE_SIMPLE` (`orchestrator/floorHook.ts:73-78`, pinned
  at `:105-108`). Without the pin, a repository or an agent could turn auto
  memory off under `export`, or back on under `prompt`, around the flag-layer
  `autoMemoryEnabled`. The pin sits next to `CLAUDE_CODE_SIMPLE` in the same
  flag-layer `env`.

The preflight for `export` checks:

- **The CLI version.** The executor resolves the executable the way
  `openClaudeQuery` does and runs `<exe> --version`, cached per path and mtime.
  The version must be at least the one the live probe passed on, which is
  recorded in `memory.db` `meta.claude-probe-passed`. With no passing probe,
  export is never chosen.
- **The process environment.** `CLAUDE_CODE_DISABLE_AUTO_MEMORY` must not be set
  in the daemon's own environment
  ([docs](https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory)).
- **Managed settings.**
  `resolveSettings({ cwd: worktree, settingSources: ['user', 'project', 'local'] })`
  (`sdk.d.ts:2570-2594`) must show no `managed` source setting
  `autoMemoryDirectory`, `autoMemoryEnabled: false`, or
  `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY`, since managed would beat the flag
  layer. `resolveSettings` is `@alpha`, so a throw fails the preflight to
  `prompt`.
- **Reads outside the worktree.** The export directory is passed in
  `additionalDirectories`. So a
  `permissions.blockReadsOutsideWorkingDirectories` setting, which makes the
  file tools "refuse reads outside the working directories in every permission
  mode"
  ([settings reference](https://code.claude.com/docs/en/settings-reference)),
  still lets topic files be read. The live probe covers that case.

The Claude executor merges the memory settings into the flag settings it already
passes (`executors/claude.ts:820`; `floorHook.ts:105-108`):

```ts
settings: {
  ...floor.settings,
  env: { ...floor.settings.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' },
  autoMemoryEnabled: true,
  autoMemoryDirectory: dir, // absolute
  autoDreamEnabled: false, // Dispatch owns consolidation (decay)
  permissions: { allow: [`Read(/${dir}/**)`, `Edit(/${dir}/**)`] },
},
additionalDirectories: [dir],
```

- **Allow rules.** A permission rule's `//path` is an absolute path
  ([permissions](https://code.claude.com/docs/en/permissions#read-and-edit)), so
  `/${dir}` is right for an absolute `dir`. The rules keep memory writes outside
  the worktree from reaching `canUseTool` as tool-approval gates.
- **The floor still applies.** Its PreToolUse hook still sees every call.
- **Load check.** No tool runs until it passes. From start, the executor sets
  the floor's `refusal` callback (`floorHook.ts:85-95`) to "memory setup
  pending", and it buffers assistant messages instead of logging them.
  - After the session's `init` message, the executor reads its
    `claude_code_version` (`sdk.d.ts:4290`) and calls `getContextUsage()`
    (`sdk.d.ts:2377`).
  - **Loaded.** If the version is at least the probed one and `memoryFiles`
    (`:3004-3008`) lists `<dir>/MEMORY.md`, the refusal clears and the buffered
    messages flow.
  - **The native directory loaded instead.** If `memoryFiles` lists any
    auto-memory file outside `<dir>`, the executor aborts the session through
    its `AbortController` before any tool runs, discards the buffered output,
    and restarts the run's session in `prompt` mode. It records
    `memoryMode: 'export-fallback'` and one transcript line saying why. The
    CLI's system prompt may be naming the default path (#36636), so the session
    must not continue.
  - **Nothing loaded.** The executor continues with
    `memoryMode: 'export-unloaded'` and queues a pending note, which reaches the
    agent with its first tool result (`executors/claude.ts:693-699`). The note
    carries the rendered index and "Your auto-memory directory is not active;
    save memories with memory_save." The export prompt line (below) is then
    false, and this note replaces it.

For a Claude run in `export` mode, the dispatch prompt carries one line instead
of the `## Memory` section:

> Your memory index is MEMORY.md in your auto-memory directory, managed by
> Dispatch. Save new memories there as usual. `memory_search` and `memory_read`
> reach older entries, and `memory_save` with `scope: "team"` proposes a lesson
> for everyone.

### Other Claude sessions

Every Claude SDK session Dispatch starts that is not a run, the overseer
included, gets `autoMemoryEnabled: false` and
`env.CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'` through one helper in
`orchestrator/claudeCli.ts`. That covers the planner, the repo digest, the AI
task filter, the inbox clusterer and commit-message generation (Why). Folding
the setting into `floorGuard` would miss the last three, which do not call it.
None of these sessions needs personal notes, and a teammate's plan session on a
shared host must not load the owner's.

### Export

At the start of a session in `export` mode, before `query()`, the service writes
its directory:

- **One directory per session lineage**, `claude-memory/<lineage>/`, where the
  lineage is the first run of a resume chain (follow `resumedFrom` to its root).
  - A continuing resume re-opens the same Claude session, whose history cites
    files by path. So it reuses the directory. Before its `query()`, the service
    ingests anything left, then re-exports for the new run, and the paths stay
    valid.
  - A task has at most one live run (`liveRunForTask`, `orchestrator.ts:970`),
    so every file change in a lineage's directory is attributable to its one
    live run.
  - Concurrent runs of different tasks never race on one `MEMORY.md`, and each
    index is ranked for its own task.
- **Closing a lineage.** A lineage's directory gets a final scan and is deleted
  when the lineage closes:
  - its last run is reviewed (merged or discarded, `reviewedAt`);
  - or a non-continuing run of the task starts, with a new lineage;
  - or 7 days pass with no live run.
- **Modes.** The directory is 0700 and its files 0600, in the project's
  run-state.

The directory holds:

- **`MEMORY.md`:**
  - A two-line header: "Managed by Dispatch. Add a memory as a new file here.
    Changes to team and project entries become proposals, which a human reviews
    unless policy approves them. Lines marked unreviewed were written by an
    agent."
  - Then the same ranked, budgeted lines as the prompt index, in Claude's link
    form: `- [<title>](mem-01K….md) — hazard · epic · unreviewed`.
    - The title goes through `untrustedInline`, the same as in the prompt index,
      and then `\`, `[` and `]` are backslash-escaped.
    - Each line starts with `- [`, so a title can never pose as a heading or a
      fence.
    - `agent`-trust entries carry `unreviewed`, as in the prompt index.
- **One topic file per exported entry, `mem-<ulid>.md`.** Exported entries are
  every entry the run may see with displayed state `active`, up to 300 by rank.
  Each file uses the frontmatter layout Claude Code itself writes. All 69 of the
  owner's files nest `type` under `metadata`, beside `node_type`,
  `originSessionId` and `modified` (for example
  `~/.claude/projects/-Users-wyatsoule-Sites-dispatch/memory/carto-working-install.md:1-8`):

  ```text
  ---
  name: mem-01K…
  description: "<title, YAML-quoted>"
  metadata:
    node_type: memory
    type: project
    dispatch:
      handle: "#7QX2K9PA"
      scope: team
      kind: hazard
      trust: agent
      rev: 3
  ---

  > Dispatch memory #7QX2K9PA · team hazard · by run:r-9f2c01 · unreviewed: an agent wrote this and no human has checked it.

  <body, through untrustedBlock>
  ```

  - The provenance line names the author and trust. The body goes through
    `untrustedBlock` (`untrusted.ts:24-30`), so a body line cannot pose as a
    heading or a fence. `MEMORY.md` and recalled topic files reach Claude as its
    own trusted context ([docs](https://code.claude.com/docs/en/memory): both
    memory systems "are loaded at the start of every conversation").
  - The frontmatter is informational: ingest never trusts it.

| Dispatch kind                                            | Claude `metadata.type` |
| -------------------------------------------------------- | ---------------------- |
| `preference`                                             | `feedback`             |
| `fact`, `convention`, `constraint`, `hazard`, `decision` | `project`              |
| `reference`                                              | `reference`            |

The manifest in `exports` records each file's entry, store, revision and
`parsed_hash`: the sha256 of the title and body that ingest's parser reads back
from the file exactly as Dispatch wrote it.

### Ingest

**When.**

- While a run is live, the service polls its directory every 15 s. It compares
  mtime and size first, as a cheap filter, then parses. Polling is used instead
  of `fs.watch`, whose recursive mode is not portable across Bun on Linux.
- When the run reaches a terminal state, a scan runs. The directory stays until
  its lineage closes (Export).
- At boot, `memory.recover()` scans every directory with no live run, then
  deletes those whose lineage has closed.

**Reading safely.**

- Every path is checked with `lstat`. Symlinks and anything that is not a
  regular file or a directory are refused into `ingest_problems`, and never
  followed.
- At most 3 directory levels below the lineage directory, and at most 500 files
  per scan.
- Reads are bounded at 64 KiB. A larger file is refused as `too-large`, with its
  first 8 KiB kept for the owner.

**Parsing, and what counts as a change.**

- Frontmatter is YAML. The kind comes from `metadata.type ?? type`, and the
  timestamp from `metadata.modified ?? modified`.
- The title is the first of `description`, `name`, or the first non-empty body
  line, cut to 200 bytes.
- The body is the text after the frontmatter, with Dispatch's provenance line
  removed and `untrustedBlock`'s escapes reversed. It is cut at 8 KiB on a line
  boundary, with the line
  `[truncated by Dispatch: N bytes; long-form belongs in Docs]`. A personal
  entry keyed to this project hands its full text to a personal doc of its human
  instead, and the line reads
  `[truncated by Dispatch: N bytes; full text in doc <doc id> of project <key>]`
  with a `doc` ref to it (built in docs Task 18). Every other case stays plain
  truncation: cross-project personal entries, project and team entries, the
  `supersede` proposals ingest makes for them, and ledger import rows.
- **Changed** means the sha256 of the parsed title and body differs from the
  manifest's `parsed_hash`. Claude Code rewrites frontmatter whenever it writes
  a file (`metadata.modified`, `originSessionId`, `node_type`), and those keys
  and `metadata.dispatch` never count as a change. A file hash would read every
  touch of an exported team file as an edit and raise a `supersede` proposal.

**What a change means.**

| File change                                 | Maps to (by the manifest)        | Effect                                                                                               |
| ------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| new `*.md`, not `MEMORY.md`                 | nothing                          | a personal save for the run's operator, `agent` trust (decision Q4)                                  |
| changed                                     | a personal entry of the operator | a new revision, direct and undoable                                                                  |
| changed                                     | a project or team entry          | a `supersede` proposal through the `memory` gate, carrying `baseRev`                                 |
| deleted                                     | a personal entry                 | retired (`forgotten`), undoable                                                                      |
| deleted                                     | a project or team entry          | a `retire` proposal through the `memory` gate                                                        |
| renamed (same parsed hash under a new name) | the original entry               | manifest updated only                                                                                |
| `MEMORY.md` changed                         | —                                | ignored, since it is regenerated. A new line that links to no file becomes one personal `fact` entry |

**How a new file becomes an entry.**

- **Kind** from `metadata.type ?? type`:
  - `user` and `feedback` → `preference`;
  - `project` → `fact`;
  - `reference` → `reference`;
  - missing or unknown → `fact`.
- **Project filter:**
  - `project` and `reference` types are narrowed to this project, because
    Claude's directory for them was already per repository. This departs from
    decision Q2's default (Open question 4);
  - `user` and `feedback` stay cross-project (decision Q2).

**Trust and conflicts.**

- **Frontmatter is never trusted.** Scope, trust, author and status come from
  the database, through the manifest keyed by filename. A new file's
  `metadata.dispatch` is ignored, so a file cannot promote itself to team scope
  or claim `human` trust.
- **Author and trust.** Everything ingested is authored `run:<id>` with `agent`
  trust.
- **Personal conflicts.** When the base revision in the manifest is not the
  entry's current revision (someone else edited it meanwhile), the file's
  version still becomes the new revision. The later write wins, the overwritten
  revision stays one undo away, and the activity row says
  `replaced a change by <who>`.
- **Team and project conflicts** are always proposals. The proposal carries
  `baseRev`, and its card shows the base and the current version side by side.
  Both are shared entries, so the card shows nothing personal.
- **Limits.** Ingested personal writes share `memory.personalWritesPerHour` with
  tool writes (Writes).

**Recalls from Claude.**

- The executor reports reads of files under its directory, seen in the
  PostToolUse hook it already installs (`executors/claude.ts:693-699`), as
  `read` recalls.
- It reports `system`/`memory_recall` messages (`sdk.d.ts:3883-3906`) as
  `claude-recall` recalls.
- Only absolute paths inside the lineage directory are mapped, through the
  manifest. A `<synthesis:DIR>` sentinel (synthesize mode) or an https URL
  (organization scope) names no exported file (`sdk.d.ts:3893-3897`), and is
  logged and ignored.
- A recalled body reaches the model without the `untrustedFenced` wrapping that
  `memory_read` gives. The provenance line and `untrustedBlock` in each topic
  file are the export path's marking instead.

### One-time import of the owner's MEMORY.md

This is the controller's ruling: the owner's existing entries are imported once
as personal memory, because repointing would otherwise hide them from runs.

- **Who and when.**
  - It runs for the daemon's own human, identity `self`: the OS user whose
    `~/.claude` is on this machine.
  - It runs once per project, at the first boot of the v1 build, before any run
    is dispatched. It runs whatever `claudeAutoMemory` defaults to, so a failed
    live probe does not leave the owner's notes unimported.
  - Its state is recorded in the personal database as
    `meta.claude-import:<projectKey>`: `complete`, `failed`, or `unconfirmed`.
- **Source,** first match:
  1. The effective `autoMemoryDirectory` that
     `resolveSettings({ cwd: rootDir })` reports, from any source.
     - A value from user or managed settings is used as found.
     - A value from project or local settings (the repository's own files) is
       only a candidate the owner must confirm. Otherwise a repository could
       point the import at notes it wrote itself.
  2. `${CLAUDE_CONFIG_DIR ?? ~/.claude}/projects/<name>/memory/`.
     - `<name>` is `CLAUDE_CODE_PROJECT_DIR_NAME` if set. The docs say that name
       applies only beside `CLAUDE_CONFIG_DIR` and needs Claude Code 2.1.234 or
       later ([docs](https://code.claude.com/docs/en/memory#storage-location)).
     - Otherwise it is the main checkout's absolute path with every character
       outside `[A-Za-z0-9]` replaced by `-`, which is the naming observed on
       the owner's machine. The docs say the directory is derived from the git
       repository, so worktrees share it.
     - A daemon launched from the desktop does not inherit the owner's shell, so
       neither variable may be set even when the owner's terminal sets it.
- **Outcomes.**
  - **Found and readable:** imported, `complete`.
  - **Found but unreadable:** `failed`. The owner stays in `native` mode, and
    Settings → Memory shows the problem with "import again".
  - **Not found:** `unconfirmed`, never `complete`. The owner stays in `native`
    mode.
    - Settings → Memory lists candidates: each `<config dir>/projects/*/memory/`
      whose name ends with the sanitized repository directory name or contains
      the sanitized main-checkout path, plus any project-sourced
      `autoMemoryDirectory`.
    - The owner answers once: "import from X", or "I have no Claude notes for
      this project".
    - `dispatch memory import-claude --from <dir>` or `--none` does the same.
- **Mapping:**
  - each topic file becomes one personal entry, parsed as ingest parses
    (`metadata.type ?? type`);
  - `MEMORY.md` lines only fill titles a file lacks, and a file linked twice
    becomes one entry;
  - a line that links nowhere becomes one `fact` entry;
  - the reading limits are ingest's: `lstat`, no symlinks, 64 KiB per file.
- **Provenance:**
  - `author` = `agent:<owner>/claude-code`;
  - `trust` = `agent`, since Claude wrote them and nobody reviewed them as
    Dispatch memory. The owner can confirm them in bulk with
    `dispatch memory confirm --origin claude`;
  - `origin` = `claude:<projectKey>/<relative path>`;
  - `createdAt` = `metadata.modified ?? modified`, else the file's mtime;
  - `lastRecalledAt` = import time.
- **Duplicates.** A cross-project entry whose `content_hash` matches one
  imported from another project is skipped.
- **The source is only read.** Nothing in it is ever changed. The owner's
  interactive Claude Code sessions keep using it.
- **Re-running.**
  `dispatch memory import-claude [--from <dir> | --none] [--dry-run]` re-runs
  the import by hand. It is idempotent by `origin`, and it skips tombstoned
  origins. A file whose parsed title and body changed since the last import
  becomes a new revision of its entry, and an unchanged one is skipped.

### Overseer

Every request-tier caller can start an overseer conversation and read its
transcript, so the overseer is not a personal reader until its conversations are
private to the owner.

- Its `memory_search` and `memory_read` read as `agent:dispatch`: project and
  team scope only, never the owner's personal entries (`overseerTools.ts`).
- Each turn runs with Claude's auto memory off (`autoMemoryEnabled: false`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), so it never loads the owner's native
  Claude notes, and nothing is exported to it or ingested from it.
- An `o-<conversation>` directory an older build left is closed by the same
  24-hour rule as a run's, without being ingested.

## Decay jobs

`memory/decay.ts` runs a pass at boot when `meta.last_decay_at` is more than 24
hours old, and then every 24 hours. It sweeps `memory.db` and every personal
database this daemon has opened. A personal database another daemon swept within
24 hours is skipped.

Steps 1–4 run in one `BEGIN IMMEDIATE` transaction per database:

1. `active` + `fresh` → `stale` after `memory.staleAfterDays` without use.
   Pinned entries and `human` constraints with no origin are exempt.
2. `stale` → `expired` after `memory.retireAfterDays` without use.
3. Open proposals older than `memory.proposalTtlDays` close as `expired` (see
   the gate). `memory.db` only.
4. `recalls` rows older than 365 days are deleted. `recall_count` already
   carries their total.

   Then, after the commit:

5. **Backup.** `VACUUM INTO '<file>.bak.tmp'` (removing a leftover temporary
   file first), then fsync it, `chmod 0600`, and rename it over `<file>.bak`.
   One generation is kept, the only copy of personal memory until #5.
   - `VACUUM INTO` refuses an existing target ("output file already exists") and
     refuses to run inside a transaction ("cannot VACUUM from within a
     transaction"). Both were reproduced with sqlite3 3.51.0 on 2026-09-25.

Each transition appends a revision with cause `decay`. The pass emits one
`memory.changed` per store, not one per entry. There is no LLM consolidation
(decision Q8 chose option b, not c). Superseding is how entries merge.

## Privacy

Personal memory belongs to one human:

- **Readers.** Only that human, runs whose operator they are, agents registered
  under them can read it. The overseer cannot (see Overseer).
  - Unlike messaging, where a deciding human acts as anyone (spec :451-453), a
    decide-tier human gets a 403 on another human's personal entries, and the
    project owner is no exception.
  - The same holds for every route that could carry personal lines: the index,
    recalls and activity routes (Transport).
- **Reach.** It never enters:
  - board sync;
  - receipts;
  - ledger receipts;
  - messaging (no notices, no gate content);
  - the decision feed, and so webhooks;
  - A2A: `a2a.` agents may not touch memory, and A2A-provenance runs have no
    operator and see team entries only.

  Its `memory.changed` events carry no id and no handle, only
  `{ scope: 'personal' }`. A client refetches what it is allowed to see.

- **Team memory as a source.** Team memory never becomes personal automatically.
- **Promotion.** Personal memory becomes shared in one of two ways:
  - A decide-tier human copies their own entry
    (`dispatch memory promote <id> --scope team` in v1, a button in v2).
  - An agent proposes new shared content. A human reviews it at rungs 1–3. At
    rung 4, or under an `auto` pin, policy can approve a routine-task proposal
    with no human.
    - A proposal whose `content_hash` or normalized title matches one of the
      author's operator's personal entries is never auto-approved (Proposals,
      step 5).
    - A paraphrase of a personal note is caught only by review. That is the cost
      of rung 4, and the rung's new label says what it accepts.
- **The Claude export.** A run's directory holds its own operator's personal
  entries and no one else's. On a shared host, a teammate's run is never
  `native`, so it no longer loads the host owner's notes, which it does today.
- **Run logs.** A run that reads its operator's personal entries can quote them
  in its log. On a shared host, `GET /api/runs/:id` returns any run's log to any
  request-tier token (`api.ts:5403-5413`, and `runs/*` GET is not an elevated
  route), and `run.log` events go to every WS client (`orchestrator.ts:594`,
  `:610`). So from v1, teammates can see what another human's runs quoted (Open
  question 3).
- **The local caveat.** Messaging states it (spec :388-391), and it holds here
  too. Any process running as the same OS user can read the database files and
  export directories, so on one machine these rules give attribution and
  consent, not a security boundary.
- **Per machine.** Personal memory is per machine. A human's personal memory on
  their laptop and on a shared host are two different stores until federation
  (#5).

## Transport

Daemon routes (FSL). Each authenticates its caller as a messaging principal
(`messaging/principal.ts:28-123`): a team member's token, a live run's token, or
an approved agent's token. The shared `agentToken` is refused, and so is any
agent whose name starts with `a2a.` (403).

```text
GET    /api/memory?scope=&kind=&state=&taskId=&limit=   visible entries, ranked (default 50, at most 200)
GET    /api/memory/search?q=&scope=&kind=&includeStale=&includeRetired=&limit=
GET    /api/memory/:id                                  entry, revisions, recall count; id or #handle
POST   /api/memory                                      save: direct or proposal; Idempotency-Key replays
POST   /api/memory/:id/retire   {reason}                direct or proposal (lifecycle table)
POST   /api/memory/:id/undo                             restore the previous revision
POST   /api/memory/:id/confirm                          agent → confirmed
POST   /api/memory/:id/pin | /unpin
POST   /api/memory/:id/promote  {scope}                 copy a personal entry to shared: direct or proposal
DELETE /api/memory/:id                                  hard delete; tombstones its origin
GET    /api/memory/proposals?state=                     decide tier: all; anyone else: their own
GET    /api/memory/proposals/:id                        one proposal's content; decide tier or its author
GET    /api/memory/activity?since=                      the caller's own personal activity (the Undo list)
GET    /api/memory/index?taskId= | ?runId=              an index (below)
GET    /api/memory/recalls?runId=                       what a run saw (below)
GET    /api/memory/health                               stores, search mode, import states, config warnings, last decay
POST   /api/memory/import/ledger?dryRun=1               decide tier; the parity report
POST   /api/memory/import/claude?dryRun=1&from= | none=1  the daemon's own human only
POST   /api/memory/link  |  /api/memory/link/:code      personal identity linking
```

- **Authorization** follows the Writes tables and Who sees what. `state=` on the
  list defaults to `active`, with stale entries included and marked.
- **Reads** return only what the principal may see. An entry that is not visible
  answers 404, not 403, so it does not reveal that it exists. The exception is
  personal entries requested by id by a decide-tier human, who gets 403 with the
  reason.
- **Index and recalls.**
  - `?taskId=` renders the index the caller's own run would get for that task,
    with the caller as operator.
  - `?runId=` (the index that run got, rebuilt from its `index` recalls) and
    `/recalls?runId=` answer the run itself, the run's operator, and decide-tier
    humans.
  - In both, personal lines of anyone but the caller are replaced by "(N
    personal lines hidden)".
- **Claude import `from`.** `from` must be an absolute path. After `realpath` it
  must lie under the owner's home directory, and no component may be a symlink.
  It is read with ingest's limits.
- **Events.** `memory.changed`, typed
  `{ type: 'memory.changed'; scope: 'personal' | 'project' | 'team'; id?: string }`,
  joins `ServerEvent` (`events.ts:93`) as a bare refetch signal. `id` is never
  set for `personal`. It is sent to any request-tier token, like messaging's
  events, so it carries no content.
- **Clients.** The CLI's own `ApiClient` (`packages/cli/src/apiClient.ts`), its
  test fakes, and `@dispatch/client` all mirror these routes.
- **`dispatch memory` commands:** `list`, `show`, `save`, `forget`, `undo`,
  `confirm`, `pin`, `promote`, `delete`, `proposals`, `link`, `import-ledger`,
  `import-claude`.
  - They authenticate with `--token` or `DISPATCH_APP_TOKEN` through
    `resolveAppToken`, like `dispatch scope`
    (`packages/cli/src/commands/appToken.ts:21-32`), or with a teammate token.
  - The agentToken the CLI reads from the daemon file is refused by memory
    routes, and the command's error says so.

## MCP tools

The same tools for runs and external agents, in `packages/mcp`. They
authenticate like the `msg_*` tools (`packages/mcp/src/messaging.ts`, through
`identity.ts`).

| Tool                                                                                         | Ships | Replaces          |
| -------------------------------------------------------------------------------------------- | ----- | ----------------- |
| `memory_search(query, scope?, kind?, includeStale?, limit?)`                                 | v0    | —                 |
| `memory_read(id)`                                                                            | v0    | —                 |
| `memory_save(scope, kind, title, body, refs?, epic?, appliesTo?, supersedes?, projectOnly?)` | v1    | `record_decision` |
| `memory_forget(id, reason)`                                                                  | v1    | —                 |

- **`memory_search`:**
  - returns at most `limit` hits (default 10, at most 50), each with
    `{ id, handle, title, kind, scope, trust, state, updatedAt, snippet }`;
  - `snippet` is FTS5's `snippet()`, and results are ordered by `bm25` then the
    index rank;
  - an empty `query` returns the caller's top entries by index rank, with no
    task context. That is how an external agent, which has no dispatch prompt,
    asks "what should I know?".
- **`memory_read`** returns the entry with its body wrapped in
  `untrustedFenced('memory <handle>', body)`
  (`packages/core/src/untrusted.ts:33-45`), plus provenance: author, trust, who
  decided it, and revisions.
- **`memory_save`:**
  - `scope` is `personal`, `project` or `team`; `personal` means the caller's
    operator.
  - For runs, `epic` defaults to the calling task's parent epic. Pass `null` for
    the whole project. This matches `record_decision`'s default.
  - `projectOnly` narrows a personal entry to this project; it defaults to
    `false` (decision Q2).
  - The result is `{ id, handle, status }`, where status is `active`, or
    `proposed` with the proposal and gate ids.
  - The description tells the agent the three things that matter:
    - the title is the whole lesson;
    - shared scopes are reviewed;
    - personal saves are the operator's and undoable.
- **`memory_forget`:**
  - retires a personal entry directly;
  - on a shared entry, proposes retirement.
- **Retries.** Writes send an `Idempotency-Key` and retry a dropped connection
  once, like `msg_send`.
- **Registration.** `DISPATCH_MCP_TOOLS`
  (`packages/core/src/dispatchMcpTools.ts:3-21`) gains the read tools in v0 and
  the write tools in v1, and loses `record_decision` in v1, so Codex runs
  pre-approve them by name (spec :498-500).

## Replacements

| Today                                                                        | After                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `renderLedgerSection`: every matching ledger row in every prompt, uncapped   | `## Memory`: a ranked index with a hard budget, or the export's `MEMORY.md`                              |
| `record_decision`, `POST /api/ledger`                                        | `memory_save`, `POST /api/memory`; `GET /api/ledger` stays for audit                                     |
| Amendments writing a ledger constraint                                       | A `team` constraint through the write policy                                                             |
| The daemon's receipts mixed in with lessons                                  | The ledger holds only receipts                                                                           |
| Every Claude session sharing the owner's `~/.claude/projects/<repo>/memory/` | Runs: a per-lineage export through `autoMemoryDirectory`, ingested back. Other sessions: auto memory off |
| Nothing for Codex, CLI or external agents                                    | The same index in the prompt, plus the `memory_*` tools                                                  |

**Not replaced:**

- the brain-dump inbox (`.dispatch/inbox/`, `dispatch_note`), which is capture
  to task, not recall;
- orientation and the repo digest (`orchestrator/repoDigest.ts:38`), which are
  derivable and must not be duplicated into memory;
- long-form documents, which are Docs (#4).

**Cutover.** The v1 removals and their replacements land together, with no
aliases, and require no live runs, as messaging's cutover did.

## Desktop UI

- **v1:**
  - **Needs you** gets a memory gate card. It fetches the proposal from
    `GET /api/memory/proposals/:id` and shows its title, kind, scope and reach,
    the body, author, source task, Approve and Reject.
    - A `supersede` shows a diff of the base and proposed versions.
    - A proposal that matched a personal entry says so, without showing it.
  - **Inbox** gets `recorded` items for agents' personal writes and ingests,
    each with Undo, read from `GET /api/memory/activity` for the signed-in human
    only.
  - **Settings → Autonomy** gets the `memory` row and the relabelled rung 4.
  - **Settings → Memory** shows:
    - store health, and config warnings;
    - the ledger parity report;
    - the Claude import state, with "import again". When the state is
      `unconfirmed`, it shows the candidate list and "I have no Claude notes";
    - skipped ingest files, with "accept";
    - identity links;
    - `claudeAutoMemory` (export or off);
    - `indexTokens`.
  - **Task page:** `LedgerSection`
    (`apps/desktop/src/components/tasks/detail/LedgerSection.tsx`) is split
    into:
    - **Memory**: entries that reach the task, read-only, with provenance;
    - **Receipts**: `GET /api/ledger?class=audit`.
- **v2:** a Memory view (a new `ProjectView` in `lib/appNav.ts`) with Personal,
  Project, Team, Proposals and Stale tabs. Per entry it offers provenance,
  revisions, recall count, pin, retire, confirm, promote and delete.

## Licensing

| Code                                                                                                                                                                           | License                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `packages/memory` (`@dispatch/memory`): types, validation, limits, `SqliteMemoryStore`, `MemoryEngine`, `MemoryHost`, rank/render, decay, Claude file format and manifest diff | MIT                                                   |
| `@dispatch/protocol`: the `memory` `GateData` variant; the `LINE_BREAK` export                                                                                                 | MIT                                                   |
| `@dispatch/core`: `PolicyGate` `memory`, the rung-4 label, `MemoryConfig`, the `memory` `NotificationKind`, `DISPATCH_MCP_TOOLS`                                               | MIT                                                   |
| `@dispatch/mcp`, `@dispatch/client`, `@dispatch/cli`: tools, API, commands                                                                                                     | MIT                                                   |
| `packages/server/src/memory/`: host, routes, identities, gate handler, ledger import, Claude export/ingest/import, decay scheduler, prompt wiring; desktop                     | FSL                                                   |
| `packages/server/src/receipts/exporter.ts`: the v2 export of team entries                                                                                                      | FSL                                                   |
| The team-memory op's wire format (`MemoryBody` in `@dispatch/protocol/federation`; published in the protocol spec's App. F)                                                    | MIT in the package; Apache-2.0 as published in App. F |
| Team replication machinery: `packages/server/src/team/federation/memory.ts` (federation F3, in place of `team/boardSync/` `memory` ops)                                        | ELv2                                                  |

The new package, per AGENTS.md:

- `"license": "MIT"`;
- a sibling MIT `LICENSE` file;
- an entry `'@dispatch/memory': 'MIT'` in `EXPECTED` in
  `scripts/check-licenses.ts:18-33`.

Two documents change with it:

- `LICENSING.md`'s MIT row (`:13`) gains `packages/protocol` and
  `packages/memory`.
- AGENTS.md's Licensing list says only core, client, cli and mcp are MIT, and
  "Everything else … is FSL". It gains `packages/protocol` and
  `packages/memory`, and the ELv2 team directory, in the same change.

## Team replication (v2, ELv2)

This is decision Q11. Board sync gains a second op type beside the task op
(`team/boardSync/engine.ts:25-45`):

```ts
interface MemoryOp {
  v: 1;
  replica: string;
  seq: number;
  hlc: string;
  memory: string; // mem-<ulid>
  kind: 'put' | 'remove';
  fields?: Record<string, unknown>; // title, body, kind, refs, epic, appliesTo, pinned,
  // status, statusReason, supersedes, supersededBy, author, createdAt,
  // decidedBy, decidedByPolicy
}
```

- **What travels.** Only `team` entries, in `active` or `retired` status, merged
  per field by last writer wins on the hybrid clock, exactly like task fields.
- **What never travels:**
  - proposals, which are local to the proposer's daemon. An approved result
    travels as an entry;
  - personal and project entries;
  - `trust`, `decay`, recalls and revisions, which are local.
- **Trust is recomputed on arrival.** Board-sync ops are unsigned, and a
  teammate's daemon or a hand-edited sync log can assert any field. Identity
  becomes a boundary only across the network (messaging spec :388-391), and
  signed ops belong to #5. So an incoming entry is stored with `agent` trust,
  unless this daemon already holds it at a higher trust. Its remote `decidedBy`
  and `decidedByPolicy` are shown as provenance, not trusted.
- **Local policy still applies.** An incoming entry that was approved by policy
  elsewhere (`decidedByPolicy` set) is checked against this daemon's own
  `memory` policy. If this daemon would block, the entry arrives as an open
  `add` proposal with `origin: sync:<replica>`, and later ops for it update the
  proposal until it is decided. On approval, the entry keeps its replicated id.
- **Seats.** Replication pauses past the license's seats, like task ops.
- **Receipts.** v2 also exports team entries, active and retired, as
  `.dispatch/memory/<id>.md` into the receipt log (the layout in
  `packages/core/src/receipts.ts`; the export is a receipts step,
  `packages/server/src/memory/receipts.ts`). The export never reads the log
  back: editing a file changes nothing in `memory.db`. A file is pruned only
  when this `memory.db` exported its id (meta `receipts_exported`), or when an
  entry, or an approved or rejected proposal, holds a `receipts:<id>` origin. An
  expired proposal owns nothing, so its file stays. Pruning continues while a
  restore is staged. A hard delete does not scrub git history.
- **Restore (ruling MEM-R9).** Restore is an explicit owner action,
  `dispatch receipts restore`, at parity with docs. The log is untrusted input
  from anyone with push rights:
  - **Staging.** The CLI stages only regular files named `mem-<ULID>.md`, within
    32 KiB (`MEMORY_RECEIPT_FILE_BYTES`), refusing symlinks, into run-state
    `memory-restore/` (0700).
  - **Validation.** At boot, after `messaging.recover()`, each staged file is
    checked again: its name, `lstat`, size, and a body within 8 KiB. The
    frontmatter is read strictly (a duplicated key is a problem) and only
    suggests the kind. The `status` must be one string, compared trimmed and
    lower-cased.
  - **Always gated.** Each file becomes an `add` proposal by `agent:dispatch`
    with `agent` trust and origin `receipts:<id>` (`receipts:<id>/2`, `/3` after
    an attempt expired undecided), exempt from the hourly proposal limit. A
    `receipts:` proposal always raises a gate, whatever the auto policy, as a
    personal-entry match does, and the gate says the lesson came from the
    receipt log. Nothing restored goes live without a human.
  - **Skipped.** A receipt whose `status` begins with `retired`, after trimming
    and lower-casing, is skipped, as are ids or origins already held and content
    conflicts.
  - **At most 50 per boot.** Handled files leave the staging directory, which is
    removed only once empty. The rest wait for the next boot, and problem files
    stay with a hint.
  - **Health.** The last report is served as `restore` in `/api/memory/health`.

## Failure handling

- **`memory.db` will not open** (its `min_reader_version` is too new, or it is
  corrupt):
  - the daemon starts without memory;
  - prompts carry no index;
  - memory routes and tools answer 503 `unavailable` with the reason;
  - Settings → Memory shows it;
  - dispatch is never blocked.
- **A personal database will not open** (too new, corrupt, or busy past 5 s):
  - writes fail `unavailable`;
  - an index skips the personal lines and adds "(personal memory unavailable)";
  - the run's mode drops from `export` to `prompt`.
- **An identity alias conflicts** (a reused handle): personal routes answer 409,
  and the index skips personal lines, until the human links or starts fresh.
- **No FTS5:** `LIKE` fallback (Tables).
- **Ledger import `MISMATCH`:** the transaction rolls back. In v0 the prompt
  keeps rendering the old ledger section until an import succeeds, and Settings
  → Memory shows the report.
- **A gate effect throws:** the answer stands, and messaging's `recover()`
  replays the idempotent handler at the next boot.
- **An open proposal has no gate** (crash): `memory.recover()` calls
  `raiseGate`, which finds or sends it.
- **A proposal is never answered:** it expires after `memory.proposalTtlDays`.
- **The export cannot be written:** the run starts in `prompt` mode.
- **Claude did not load the export:** the session restarts in `prompt` mode if a
  native directory loaded, or continues with a pending note if nothing did
  (Modes).
- **Ingest fails on a file** (unreadable, a symlink, too large, over the rate
  budget, or a validation error): that file is recorded in the operator's
  `ingest_problems`, the rest are ingested, and one activity row names what was
  skipped.
- **The daemon dies mid-run:** leftover export directories are ingested at boot,
  and deleted once their lineage has closed.
- **Two daemons race on a personal database:** `BEGIN IMMEDIATE` plus the busy
  timeout serialize them. Personal edits are last-writer-wins, with the loser
  one undo away.
- **The Claude import source is unreadable or not found:** the owner stays in
  `native` mode (Modes), and Settings → Memory shows the problem or the
  candidate list.
- **Invalid config:** the key's default applies, with a warning.
- **Invalid input or an unknown id:** rejected with a field-specific
  `MemoryError`.

## Testing

- **`@dispatch/memory`**, unit tests against in-memory SQLite and a recording
  fake host:
  - validation and limits, including multi-byte titles at 200 bytes, and the
    same-scope rule for `supersedes` and retire targets;
  - the visibility matrix (Who sees what), including `a2a.` agents, A2A runs,
    proposals by state, and personal entries against a decide-tier non-owner;
  - the write-policy and lifecycle-operation tables, including the agentToken
    row;
  - the proposal state machine: add, supersede and retire through approve,
    reject and expire. Rejecting or expiring a retire leaves its target active;
  - replay idempotence keyed on the gate id, and a second open gate closed by
    recover;
  - the promotion check;
  - de-duplication and rate limits, including ingest counting against
    `personalWritesPerHour`;
  - revisions and undo;
  - decay transitions and exemptions: amendment-derived and imported constraints
    do decay;
  - tombstones: import, hard delete, trigger a re-import, and the row stays
    gone;
  - FTS search, `snippet()`, and the `LIKE` fallback;
  - rank order;
  - handles: a batch of same-millisecond ids gets unrelated handles, and `m-`
    ids are refused with the hint;
  - a property test that `renderIndex` never exceeds `3 × indexTokens` bytes for
    random entries, including CJK and emoji, in both the tools and the
    `dispatchMcp: false` variants;
  - Claude file render and parse round-trips:
    - the manifest diff: new, changed, deleted, renamed, tampered frontmatter;
    - a rewrite that only touches `metadata.modified`, `originSessionId` or
      `node_type` is not a change;
    - titles and bodies containing `]`, headings and fence runs cannot pose as
      structure in `MEMORY.md` or a topic file;
  - config validation for every `memory.*` key;
  - `min_reader_version`: an older reader opens an additively newer file and
    refuses a breaking one.
- **`@dispatch/server`:**
  - routes and principal authorization:
    - 403 for a decide-tier human on another human's personal entry, and 404 for
      invisible entries;
    - the index, recalls and activity routes for a decide-tier non-operator;
    - the agentToken and `a2a.` agents refused;
  - personal identities: two projects give different people the same handle and
    get different identities; one person with different handles stays separate
    until linked; the owner as `wyat` and `wyat2` shares `self`; a reused handle
    gets 409;
  - run operators, table-driven over the "Who a run acts for" rows: dispatch,
    auto-fill with and without `startedBy`, resume, request-changes by a
    different human (who becomes the operator), agent wake (none), fix loop,
    review and verify by a teammate on the owner's task (the teammate) and after
    the owner's run (the owner), A2A provenance;
  - the mode procedure, table-driven over every combination of executor, run
    kind, operator, import state, `claudeAutoMemory`, preflight and export
    write;
  - the memory gate:
    - auto-approve at rung 4 with no gate sent;
    - a block at rungs 1–3;
    - `elevated` and `critical` caps, and no-task proposals always blocking;
    - `block` and `auto` pins;
    - the feed item and webhook payload carry no title;
    - the receipt names the gate and carries no title;
  - expiry;
  - the ledger classifier, with rules 2 and 3 pinned to
    `describePolicyAuthorization` and `describeFloorHold` output;
  - import parity on fixtures, including duplicate ids with different
    `createdAt`, rows after the cutover becoming proposals, and tombstoned
    origins;
  - every ledger row imported with `agent` trust, including one posted without a
    `runId` through the agentToken;
  - amendments: direct for a decide-tier human, a proposal for the agentToken,
    reach narrowed to dependents;
  - prompt snapshots with and without an index;
  - Claude executor option snapshots for each mode, including the pinned env;
  - the other Claude sessions' options: the planner, repo digest, AI filter,
    inbox clusterer and commit message all set auto memory off;
  - the load check: loaded, native loaded (abort and restart in `prompt`), and
    nothing loaded;
  - the export/ingest lifecycle with a fake executor writing files, a continuing
    resume reusing its lineage directory, and boot recovery of leftover
    directories;
  - ingest safety: symlinks, depth, size;
  - the one-time import against a fixture `~/.claude` with the layout Claude
    Code ≥ 2.1.214 writes (nested `metadata.type`, `node_type`,
    `originSessionId`, `modified`) and synthetic content, never the owner's own
    notes. It covers: found, unreadable, not found (`unconfirmed`, the owner
    stays `native`), and a project-sourced `autoMemoryDirectory` needing
    confirmation;
  - decay's backup: two passes in a row, both leaving one `.bak` at 0600.

  These avoid the in-process daemon traps (no `spawnSync` against the in-process
  server; `realpathSync` temp directories).

- **`@dispatch/mcp`:**
  - the four tools against a fake daemon;
  - handle resolution;
  - the `DISPATCH_MCP_TOOLS` registration test.
- **`apps/desktop`:**
  - the gate card, the Inbox undo item, the policy row and the rung-4 labels;
  - one e2e flow: an agent proposes a team hazard, the human approves it in
    Needs you, and the next dispatched run's index shows it.
- **Manual, before v1 turns `export` on by default:** a live Agent SDK probe.
  - Setup: a scrubbed environment and fixtures outside the repo.
  - Record the Claude Code version, bundled and on PATH, and store the lowest
    passing one as `meta.claude-probe-passed`.
  - Show that a flag-tier `autoMemoryDirectory` loads its `MEMORY.md`, as listed
    by `getContextUsage().memoryFiles`, and that the native directory does not
    load.
  - Show that a topic-file write lands without reaching `canUseTool`, under each
    permission mode Dispatch dispatches with.
  - Show that a topic-file read works with
    `permissions.blockReadsOutsideWorkingDirectories` on.
  - Show that `memory_recall` paths point into the export.
  - Show that a `settings.local.json` `env` block cannot flip
    `CLAUDE_CODE_DISABLE_AUTO_MEMORY` past the pin.

  If the probe fails, `memory.claudeAutoMemory` ships defaulting to `off` until
  it passes (Open question 5).

  **Outcome (2026-09-28).** Every case passed on the bundled 2.1.207 and the
  PATH 2.1.283, so 2.1.207 is `PROBED_CLAUDE_CODE_VERSION` and boot records it
  as `meta.claude-probe-passed`. Both list the export's `MEMORY.md` with the
  `memoryFiles` type `AutoMem` (2.1.283 also knows `AutoMemPinned`); the load
  check counts any type outside CLAUDE.md's four as native. Writes landed with
  no `canUseTool` call under `default`, `acceptEdits`, `auto` and
  `bypassPermissions`. 2.1.207 has no `blockReadsOutsideWorkingDirectories`
  setting; on 2.1.283 it refused a read outside while the topic file stayed
  readable. The recall supervisor that emits `memory_recall` is behind a server
  flag and did not run by default; forced on, both CLIs recalled from the export
  directory only.

- **Manual, before v0 lands:** ledger parity on this repo and on the audio-book
  project.

## Staging

Each stage ships on its own.

- **v0: store, index, ledger import (the read path).**
  - `packages/memory`: types, store, FTS, rank and render.
  - `memory.db`.
  - The ledger import, with parity at boot and on `ledger.changed`. Every row
    imports `active`, with `agent` trust.
  - `## Memory` replaces the ledger section, with the hard budget and the
    `dispatchMcp: false` variant.
  - `index` recalls.
  - `memory_search` and `memory_read`, and their `DISPATCH_MCP_TOOLS` entries.
  - Read-only `GET /api/memory*` and `/health`.
  - The ledger's write path is unchanged: `record_decision` and
    `POST /api/ledger` still write it, and the import carries new lessons
    across.
  - Receipts stop reaching prompts.
- **v1: the write path.**
  - Personal identities and databases, `RunMeta.operator`, and
    `EpicSession.startedBy`.
  - `memory_save` and `memory_forget`.
  - Proposals, the `memory` gate, its `GATE_RUNGS` entry and the rung-4 relabel.
  - Write routes, the CLI and the client.
  - The ledger writer changes and the cutover: `record_decision` and
    `POST /api/ledger` removed, amendments moved to the write policy,
    `?class=audit`.
  - Decay jobs.
  - Live notify.
  - The Claude round-trip: modes, export, ingest, the overseer, and auto memory
    off for every other Claude session.
  - The one-time import, which runs whatever `claudeAutoMemory` defaults to.
  - The v1 desktop surfaces.
  - `export` defaults on only after the live probe passes.
- **v2: sharing and curation.**
  - ELv2 board-sync `memory` ops for team scope.
  - The receipts export.
  - The desktop Memory view, with promote and confirm.

## Open questions

1. **Files-backend teams between v1 and v2.**
   - The problem:
     - On the files backend, `.dispatch/ledger.jsonl` travels with the repo, so
       teammates share hazards through git today.
     - From v1, new lessons live in machine-local `memory.db`.
     - v2 replication rides board sync, the SQLite team path.
   - The consequence: files-backend teams stop sharing new lessons. Ledger lines
     that teammates on older builds push still arrive, but as proposals that
     wait for a human, not as active entries.
   - **Recommendation:** accept the gap and say so in the v1 release notes.
     Tasks are already leaving markdown (`docs/TEAM-SERVER.md` §3), and a dual
     write into the ledger would undo the audit-only split.
2. **The owner's interactive Claude Code sessions.**
   - After the import, interactive sessions keep writing Claude's native
     directory. Dispatch sees those notes only when someone re-runs
     `dispatch memory import-claude`.
   - The alternative: write `autoMemoryDirectory` into the project's
     `.claude/settings.local.json`, pointing at a per-operator export.
   - **Recommendation:** leave interactive sessions native through v2. Changing
     the owner's own tool configuration is a bigger step than dispatched runs
     need.
3. **Personal memory quoted in run logs, on shared hosts, from v1.**
   - A run that reads its operator's personal memory can quote it in its log. On
     a shared host, `GET /api/runs/:id` returns any run's log to any
     request-tier token, and `run.log` events reach every WS client (Privacy,
     Run logs). So teammates can read what another human's runs quoted from v1,
     not only once the hosted server uploads transcripts (`docs/TEAM-SERVER.md`
     §6, §8.1).
   - The alternative: filter the logs of runs with an operator to that human and
     to decide-tier humans.
   - **Recommendation:** accept for v1, and say it in the shared-host
     documentation. Personal memory is visible wherever its operator's own runs
     are. Filtering run logs is a run-visibility change bigger than memory, and
     it belongs with the transcript-storage decision.
4. **Claude `project` and `reference` notes narrowed to one project (departs
   from decision Q2's default).**
   - Decision Q2 makes personal memory cross-project by default. Ingest and the
     one-time import narrow Claude's `project`- and `reference`-typed notes to
     the project they came from. For the owner that is 55 of 69 notes, so for
     the main source of personal memory the default flips.
   - **Recommendation:** narrow them, and ask the owner to confirm. Claude's
     directory was already per repository, so narrowing keeps each note's reach
     exactly as it is today. Widening them would put 45 Dispatch-specific notes
     into the audio-book project's runs. `user` and `feedback` notes stay
     cross-project, and so does everything saved with `memory_save`.
5. **Export off if the live probe fails (falls short of decision Q6(d)).**
   - If the probe fails, `claudeAutoMemory` ships `off`, and every Claude run
     uses `prompt` mode: auto memory disabled, and the index, including the
     imported personal notes, in the prompt. That is close to option (c), not
     (d). The one-time import still runs, so no notes are hidden.
   - **Recommendation:** accept as a temporary fallback, with the owner's
     confirmation, and turn export on in a point release once a probe passes on
     the CLI versions users run.
   - **Resolved:** the probe passed (Testing), so v1 ships with `export` on.
6. **Teammates' personal memory is per project until they link (clarifies
   decision Q2).**
   - Handles are per roster, so a teammate on a shared host cannot be recognised
     across projects without proof. The owner's memory is cross-project with no
     setup (identity `self`), and a teammate's becomes cross-project after one
     `dispatch memory link`.
   - The alternative: join identities by roster email automatically. Roster
     emails are self-declared (git config), so anyone could claim another
     person's store.
   - **Recommendation:** accept the explicit link.

## Critic responses

- **Carry `dispatchedBy` onto successor runs:** done through a new
  `RunMeta.operator` instead. `dispatchedBy` means "who pressed dispatch" and
  drives claims and decision ownership, and overloading it would change those
  features.
- **Key the export directory by SDK session id:** keyed by lineage (the root run
  id) instead. The session id is unknown until the first `init`, after the
  directory must exist, and the lineage covers the same resume chain.
- **Promotion check by FTS similarity:** declined. Paraphrase detection by bm25
  is unreliable. The engine checks exact `content_hash` and normalized title,
  and the Privacy section now states what rung 4 accepts.
- **Filter other humans' run logs:** deferred to Open question 3, which is
  restated to apply from v1 on shared hosts.
- **Require the owner's confirmation before leaving `native`:** applied when the
  source directory is not found or is project-sourced. A directory found where
  Claude Code puts it is imported without asking.
- **Narrow Claude `project` notes or keep Q2's default:** kept the narrowing and
  flagged it (Open question 4). Detecting repo paths in note text would be a
  heuristic with no clear failure mode.
- **Narrow amendment constraints to dependents:** done for dependents that exist
  at amendment time. A task that starts depending on it later does not get it.
  That is an accepted limit, since the amendment still renders in the amended
  task's own prompt.
- **v2 incoming trust via decider signatures:** declined for v2. There is no
  signing before #5, so trust is recomputed locally and re-gated by local policy
  instead.
