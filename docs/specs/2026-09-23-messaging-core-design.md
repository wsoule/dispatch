# Messaging core

Status: **design approved 2026-09-23.** First of six sub-projects that turn
Dispatch from a task tracker into an agent communication platform.

## Why

Dispatch already lets agents talk, but only to a live run and only by injecting
text into it (`agent_message` → `POST /api/runs/:id/inject`). Nothing is stored:
a message to a finished run fails, there are no threads or replies, no
broadcast, and a daemon restart drops whatever was in flight. Meanwhile four
separate mechanisms — `ask_user` (`QuestionRegistry`), `request_scope`
(`ScopeRequestRegistry`), tool approvals (`awaiting-approval`) and
`message_user` — are each a special case of "one actor tells another something
and maybe waits for an answer."

This spec replaces all of them with one persistent, addressable message bus, and
puts the bus's logic in an MIT package so other products can embed it.

## The six sub-projects

| #   | Piece                                                                      | License              | Depends on |
| --- | -------------------------------------------------------------------------- | -------------------- | ---------- |
| 1   | **Messaging core** — this spec                                             | MIT engine, FSL host | —          |
| 2   | Memory — personal and team stores, scopes, prompt injection, decay         | MIT model, FSL host  | 1          |
| 3   | A2A bridge — Dispatch agents as A2A agents and back                        | MIT                  | 1          |
| 4   | Docs — team documents beside tasks                                         | FSL                  | 2          |
| 5   | Federation — messages and memory across teammates' daemons                 | ELv2 / private       | 1, 2       |
| 6   | Published protocol spec — the extensions written up for other implementers | open                 | 1–3        |

The protocol is extracted from a working implementation (#6 last), and speaks
[A2A](https://a2a-protocol.org) at the edge (#3) rather than competing with it.
A2A covers request/response between services; what Dispatch adds is persistent
mailboxes, channels, humans as peers, and work context.

## Architecture

```text
┌────────────────────────────────────────────┐
│ @dispatch/protocol  (MIT, new package)     │
│  address + envelope types, validation      │
│  MessageStore interface + SQLite impl      │
│  DeliveryEngine ── calls ──► MessagingHost │
└──────────────────────▲─────────────────────┘
                       │ implements MessagingHost
┌──────────────────────┴─────────────────────┐
│ dispatchd  (FSL)                           │
│  HTTP routes, WebSocket events, tokens     │
│  push = inject into SDK session            │
│  wake = resume/dispatch, decide = autonomy │
└──────────────────────▲─────────────────────┘
                       │ HTTP
   packages/mcp (runs + external agents), desktop app, CLI
```

The engine is pure logic over a store and a host interface. The daemon is one
host; another product can be another.

`@dispatch/protocol` depends only on `@dispatch/core` (for `ActorRef` parsing
and the driver-blind `SqliteDatabase` type). Add it to `EXPECTED` in
`scripts/check-licenses.ts` as MIT with a sibling `LICENSE`.

## Data model

### Addresses

One string grammar, reusing `ActorRef` (`packages/core/src/actor.ts`) for
actors. Handles follow `ActorRef`'s `[a-z0-9][a-z0-9._-]*`.

```text
human:wyat                     agent:wyat/claude-code.macbook   actors
task:t-4a8cce                  run:r-9f2c01                     work
channel:epic/e-c25f9c          channel:auth-refactor            many-to-many
```

- **Actor** — one human or agent identity.
- **Task** — whatever run works that task now or next. Outlives any single run.
- **Run** — exactly that session. Fails if the run is not live.
- **Channel** — every subscribed member. Names are `[a-z0-9][a-z0-9._/-]*`.
  `epic/<id>` channels exist implicitly: their members are computed at send time
  as every task whose `parent` is the epic (`host.implicitMembers`), plus any
  explicit joins. Epics have no creation hook (they are tasks with
  `kind: 'epic'`), so computing membership avoids a table that could drift.

Roles are out of scope; a later version can model them as channels whose
membership a role manages.

### Envelope

```ts
type MessageKind =
  | 'message' // ordinary chat
  | 'question' // expects an `answer` reply; open until one arrives
  | 'answer' // replyTo a question; may carry `choice`
  | 'handoff' // "take this over"; answered with choice accept|decline
  | 'notice' // FYI, no reply expected
  | `x-${string}`; // custom; stored and delivered, never interpreted

interface Ref {
  type: 'task' | 'run' | 'file' | 'commit' | 'message';
  id: string;
  at?: string; // commit sha for `file`
}

interface Message {
  id: string; // m-<ulid>
  thread: string; // root message id
  replyTo: string | null;
  from: Address; // actor or run
  session?: string; // external agent session id, informational
  to: Address[]; // ≥ 1
  kind: MessageKind;
  body: string; // markdown
  refs: Ref[];
  data?: JsonValue; // typed payload per kind (A2A DataPart)
  urgent: boolean;
  blocking: boolean; // question/handoff only
  choices?: string[]; // question/handoff only
  choice?: string; // answer only; must be one of the question's choices
  wake: 'none' | 'request';
  createdAt: string;
}
```

Validation rejects: empty `to`; `blocking` or `choices` on kinds other than
`question`/`handoff`; `answer` without `replyTo` to a `question`/`handoff`;
`choice` not in the question's `choices`; unknown built-in kinds; malformed
addresses. Errors name the field so an agent can correct itself.

IDs are ULIDs so they sort by time and stay unique across daemons (#5).

### Gate payloads

Blocking questions to humans replace the old registries. `data` carries a
discriminated payload the daemon validates:

```ts
type GateData =
  | { type: 'tool-approval'; tool: string; input: JsonValue }
  | { type: 'scope'; paths: string[]; reason: string }
  | { type: 'wake'; target: Address; message: string }
  | { type: 'agent-registration'; agent: string; client: string }
  | {
      type: 'overseer-action';
      conversation: string;
      actionId: string;
      summary: string;
    };
```

`NotificationKind` toggles map onto these: `approval` ↔ `tool-approval`,
`scope-request` ↔ `scope`, `question` ↔ a blocking question with no gate `data`.
`wake` and `agent-registration` notify under `approval`.

### Tables (`messages.db`)

Stored in the machine-local run-state directory
(`$DISPATCH_HOME/.dispatch/runs/<sha256(rootDir)[:12]>/messages.db`), never
committed. Messages are traffic, not board state; they cross machines in #5.

```sql
messages     (id PK, thread, reply_to, from_addr, session, kind, body,
              refs_json, data_json, urgent, blocking, choices_json, choice,
              wake, created_at)
recipients   (message_id, addr)                    -- the `to` list as sent
deliveries   (id PK, message_id, recipient, run_id NULL,
              state,           -- held | pushed | notified | read | answered
              updated_at)
channels     (name PK, created_at, auto)           -- auto = epic channel
members      (channel, addr, joined_at)            -- addr: task/actor, never run
agents       (addr PK, display_name, client, token_hash,
              status,          -- pending | approved | revoked
              muted,           -- deliveries from it skip push/notify, stay readable
              approved_by NULL, created_at)
```

A message is stored once; each resolved recipient gets a delivery with its own
state. A six-member channel message is one message and six deliveries.

## Delivery engine

`DeliveryEngine.send(input, sender)`:

1. **Authorize sender.** Approved agent, human, or a run with a daemon-issued
   run token. Pending/revoked senders are rejected.
2. **Validate** the envelope (above).
3. **Resolve recipients.** Expand channels to members. `task:` → its live run,
   else held. `run:` → must be live, else the send fails. Humans → the host's
   notifier. De-duplicate; never deliver to the sender.
4. **Choose a mode per delivery.**
   - Live recipient, direct address or `urgent` → **push** (queued for the next
     turn boundary).
   - Live recipient via a channel → **notify** (a digest line at the agent's
     next step).
   - Not live → **held**. If `wake: 'request'`, run the wake policy.
5. **Commit** message + deliveries in one transaction, then call host hooks. The
   store is an outbox: hooks run only after commit.

```ts
interface MessagingHost {
  liveRunFor(task: string): string | null;
  isLiveRun(run: string): boolean;
  push(runId: string, rendered: string): Promise<void>;
  notify(runId: string, digest: string): Promise<void>;
  notifyHuman(actor: string, msg: Message): void;
  wake(target: Address, msg: Message): Promise<WakeResult>;
  decide(req: PolicyRequest): 'allow' | 'ask' | 'deny';
  owner(target: Address): string; // human to ask for a wake gate
  implicitMembers(channel: string): Address[]; // e.g. epic children
  onAnswered(question: Message, answer: Message): Promise<void>; // gate effects
  now(): Date;
}
```

`onAnswered` is how gates take effect: answering a `tool-approval` question
calls the orchestrator's `approve`, a `scope` answer records the grant, a `wake`
answer calls `wake`, an `agent-registration` answer approves the agent.

**Wake.** `allow` → `host.wake` calls `dispatchOrResume` for the task: a new run
resuming the task's latest session. It never pushes into a finished run — Claude
runs end at their first `result` and Codex runs have one turn. `deny` → stays
held; the sender gets a `notice`. `ask` → the engine sends a blocking `question`
with `GateData { type: 'wake' }` to `host.owner(target)`; approving it calls
`host.wake`.

**Run start.** When a run starts, the host calls
`engine.deliverHeld(runId, taskId)`: every held delivery for the task (and its
channels, as notify) is bound to the run and pushed or notified.

**Guardrails** (defaults, overridable in `config.yml` under `messaging:`):

- `urgentPerHour: 10` per sender. Over quota → downgraded to notify, and the
  sender is told in the send result.
- `agentTurnsPerThreadPerHour: 20` agent-authored messages per thread. When
  exceeded, further agent sends to the thread are rejected and the thread is
  flagged with a `notice` to the project owner.
- `agentBlockingTimeoutSec: 600` for blocking messages to agents. On timeout the
  sending tool returns "no answer yet — it will arrive in your inbox" and the
  delivery stays open.
- Blocking messages to humans wait up to 30 minutes in the MCP tool (the in-run
  MCP tool timeout is 31). On expiry a plain question stays open and its answer
  is pushed to the run later, or held for its task. An expired `scope` gate
  closes as denied, matching today's `request_scope`. `tool-approval` gates are
  not MCP calls — they park the executor's `canUseTool` — and have no timeout.

**Rendering.** Pushed messages render as
`[message from <sender> · <kind> · <id>]` followed by the body and refs, so an
agent can tell them apart from its own prompt and reply by id. Digests render
one line per message:
`📬 #epic/e-c25f · notice from t-88: api shape changed (m-…)`.

**Restart.** On daemon start, `engine.recover()` re-evaluates every non-terminal
delivery: pushed-but-unconfirmed deliveries to runs that are gone revert to
held.

## Identity

**Runs.** On dispatch the daemon mints a run token and passes it as
`DISPATCH_RUN_TOKEN` beside `DISPATCH_RUN_ID` (add it to the env allowlist in
`orchestrator/dispatchMcp.ts`). It is valid while the run lives and scoped to
that run, its task and its task's channels. A run sends as `run:<id>`. Today
every run shares the daemon file's `agentToken` and names itself by an env var;
the messaging routes accept only run tokens, registered-agent tokens and the app
token, never the shared `agentToken`.

**Gate answers need the `decide` tier.** A reply to a question carrying
`GateData` is accepted only from a `decide`-tier caller (the app token), exactly
as `POST /api/runs/:id/approval` and scope `decide` are today. Agents can answer
plain questions; they can never approve their own tool calls, scope, wake-ups or
registrations.

**What identity guarantees locally.** Any process running as the same OS user
can read the daemon file and token files, so on one machine identity gives
attribution and consent, not a security boundary. It becomes a boundary when
messages cross the network (#5).

**External agents.** `dispatch mcp` without a run token:

1. Reads `$DISPATCH_HOME/agents/<name>.token`. `name` comes from
   `DISPATCH_AGENT_NAME`, else the MCP `clientInfo.name` plus the hostname,
   normalized to the handle grammar (e.g. `claude-code.macbook`).
2. With no token, calls `POST /api/agents/register`. The daemon stores a
   `pending` agent, returns a token that does nothing until approved, and sends
   a blocking question with `GateData { type: 'agent-registration' }` to the
   project owner.
3. Until approved, every messaging tool returns "awaiting approval in Dispatch".
   Revoking kills the token immediately.

The identity is the agent install, not the session: all sessions of
`agent:wyat/claude-code.macbook` share its mailbox; `session` records which one
sent a message.

## Transport

Daemon routes (FSL):

```text
POST   /api/messages                     send; Idempotency-Key header honored
GET    /api/threads/:id                  thread with delivery states
GET    /api/inbox?address=&state=        mailbox for a caller-owned address
POST   /api/deliveries/:id/read
GET    /api/channels                     list
POST   /api/channels                     create
POST   /api/channels/:name/members       join
DELETE /api/channels/:name/members/:addr leave
GET    /api/agents                       roster
POST   /api/agents/register
POST   /api/agents/:addr/approve | /revoke
GET    /api/decisions                    open blocking questions to humans
```

A token reads only mailboxes it owns. The desktop app (human owner) reads all.
WebSocket event `message.new` carries the message inline (every client fetches
it immediately; see the rule in `events.ts`); `delivery.changed` is a bare
refetch signal.

## MCP tools

The same tools for runs and external agents, in `packages/mcp`:

| Tool                                                                          | Replaces                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `msg_send(to, kind, body, refs?, data?, urgent?, blocking?, choices?, wake?)` | `agent_message`, `message_user`, `ask_user`, `request_scope` |
| `msg_reply(messageId, body, choice?)`                                         | answering questions, accepting handoffs                      |
| `inbox_read(state?, limit?)`                                                  | —                                                            |
| `thread_read(threadId)`                                                       | —                                                            |
| `channel_join(name)` / `channel_leave(name)` / `channel_list()`               | —                                                            |

The CLI's own `ApiClient` (`packages/cli/src/apiClient.ts`) and its test fakes
mirror the new routes.

## Replacements

| Today                                                   | After                                                                                                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/runs/:id/inject`, `agent_message`            | Removed. Injection survives only as the daemon's internal `push` hook.                                                                       |
| `POST /api/runs/:id/message`                            | `msg_send` from `human:<owner>` to `run:<id>`                                                                                                |
| `message_user`                                          | `message`/`notice` to a human                                                                                                                |
| `ask_user`, `QuestionRegistry`                          | blocking `question` to a human                                                                                                               |
| tool approvals, `awaiting-approval` flag                | blocking `question`, `GateData tool-approval`, choices approve/deny                                                                          |
| `request_scope`, `ScopeRequestRegistry`                 | blocking `question`, `GateData scope`; autonomy auto-grant reads `data`                                                                      |
| `decisionFeed.ts`                                       | query over open blocking questions to humans                                                                                                 |
| overseer chat, its pending actions and tool approvals   | a thread between the owner and `agent:<owner>/overseer`; actions become `overseer-action` gates and its tool approvals `tool-approval` gates |
| ledger `handoff` kind (written only by demo data today) | `handoff` messages; `handoff` leaves the writable ledger kinds                                                                               |

`awaiting-approval` becomes derived: a run is awaiting when it has sent an
unanswered blocking question to a human. `RunStatePill`, `ApprovalCard` and
`pendingApprovals.ts` keep their rendering and change their source.

**Not replaced:** the brain-dump inbox (`.dispatch/inbox/`) and ledger
decisions/hazards/constraints belong to memory (#2) and docs (#4); plan, enrich
and draft sessions are authoring tools bound to their editors.

**Cutover:** no in-flight migration. The cutover requires no live runs; past
questions and approvals stay readable in run transcripts. Removals and the new
bus land together — no aliases.

## Desktop UI

- **Threads view** (new `ProjectView` in `lib/appNav.ts`, on the Sidebar rail
  after `inbox`). Left rail groups **Needs you** (open blocking questions and
  pending handoffs addressed to you), **Channels**, **Direct**. The right pane
  shows the thread with kind badges, clickable refs and choice buttons, built
  from `@dispatch/ui` `ai/` pieces (`ChatMessage`, `PromptBar`, `ApprovalCard`).
  The composer completes addresses on `@`.
- **Task page** (`components/tasks/page/TaskPage.tsx`): a `thread` tab for
  everything to or from `task:<id>`.
- **Run chat** (`TaskChatTab` → `RunLogView`): pushed and notified messages
  render inline where the agent saw them; `QuestionCard`, `ApprovalCard` and
  `ScopeRequestCard` render from open gate questions instead of the old
  registries. `InboxView` does the same.
- **Settings → Agents:** roster with status, mute and revoke.

The desktop's data layer (`hooks/useDispatchProject.ts`) swaps its question,
approval, scope-request and decision state for one query over open blocking
questions to humans, refreshed by `message.new`/`delivery.changed`. The views
that receive `openQuestions`/`pendingApprovals` (`controlRoom`, `inboxQueue`,
`taskAttention`, `notificationEdges`, `OverviewView`) keep their inputs, derived
from that query.

## Failure handling

- `push` fails (run died) → delivery reverts to held; delivered on the task's
  next run.
- `wake` fails → sender gets a `notice` with the reason; message stays held.
- Daemon restart → `recover()` (above). No state lives only in memory.
- Invalid envelope or unknown address → rejected at send with a field-specific
  error.

## Testing

- `@dispatch/protocol`: unit tests for validation, address resolution, mode
  selection, quotas, the ping-pong breaker, blocking timeouts, wake policy and
  recovery, against in-memory SQLite and a recording fake host.
- `@dispatch/server`: route tests, token scoping, registration approval, derived
  `awaiting-approval`, and gate payloads driving the autonomy policy. Avoid the
  in-process daemon traps (no `spawnSync` against the in-process server;
  `realpathSync` temp dirs).
- `@dispatch/mcp`: tool tests against a fake daemon.
- `apps/desktop`: component tests for Threads view logic, and one e2e flow: an
  agent asks a blocking question, the human answers in Threads, the run resumes.
