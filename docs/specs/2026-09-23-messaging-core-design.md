# Messaging core

Status: **design approved 2026-09-23; protocol, daemon host and MCP tools built;
replacements and desktop UI not yet.** First of six sub-projects that turn
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
│ @dispatch/protocol  (MIT)                  │
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
and the driver-blind `SqliteDatabase` type) and is MIT in
`scripts/check-licenses.ts`.

## Data model

### Addresses

One string grammar, reusing `ActorRef` (`packages/core/src/actor.ts`) for
actors. Handles follow `ActorRef`'s `[a-z0-9][a-z0-9._-]*`.

```text
human:wyat                     agent:wyat/claude-code.macbook   actors
task:t-4a8cce                  run:r-9f2c01                     work
channel:epic/e-c25f9c          channel:auth-refactor            many-to-many
```

- **Actor** — one human or agent identity. The daemon itself is
  `agent:dispatch`: it sends gates, notices and breaker flags and never receives
  a delivery.
- **Task** — the task's live execute run, else its next one. Outlives any single
  run. Review and verify runs never receive task mail; they are reachable only
  as `run:<id>`.
- **Run** — exactly that session. A direct send fails if the run is not live.
- **Channel** — every member. Names are `/`-separated segments of
  `[a-z0-9][a-z0-9._-]*`. Members are tasks and actors, never runs. `epic/<id>`
  channels exist implicitly: their members are computed at send time as every
  task whose `parent` is the epic (`host.implicitMembers`), plus any explicit
  joins. Epics have no creation hook (they are tasks with `kind: 'epic'`), so
  computing membership avoids a table that could drift. Any other channel is
  created by its first join.

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
  | `x-${string}`; // custom (x-[a-z0-9][a-z0-9-]*); never interpreted

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

Validation (`validateSendInput`) rejects: empty `to`; `blocking` or `choices` on
kinds other than `question`/`handoff`; empty or duplicate choices; `choice` on
anything but an `answer`; an `answer` without `replyTo` to a
`question`/`handoff`; a `choice` not among the question's `choices`, or a
missing one when answering a gate or handoff; unknown built-in kinds; malformed
addresses. Line breaks (CR, LF, VT, FF, NEL, U+2028, U+2029) are rejected in the
one-line fields: `refs[].id`, `refs[].at`, `choices[]`, `choice` and `session`.

Size limits per send:

| Field                                    | Limit                  |
| ---------------------------------------- | ---------------------- |
| `body`                                   | 64 KiB (UTF-8)         |
| `data`                                   | 64 KiB as JSON         |
| `to` / `refs` / `choices`                | 50 / 50 / 20 entries   |
| `refs[].id`, `refs[].at`                 | 512 bytes each (UTF-8) |
| each of `choices[]`, `choice`, `session` | 200 bytes (UTF-8)      |

Every failure is a `MessagingError` whose `field` names the bad input so an
agent can correct itself; its `code` maps to a status (`invalid` 400,
`forbidden` 403, `not-found` 404, `conflict` 409, `limited` 429).

IDs are ULIDs so they sort by time and stay unique across daemons (#5).

### Gate payloads

Blocking questions to humans replace the old registries. `data` carries a
discriminated payload the daemon validates:

```ts
type GateData =
  | {
      type: 'tool-approval';
      requestId: string;
      runId?: string; // a task run's parked tool call…
      conversation?: string; // …or an overseer conversation's
      tool: string;
      input: JsonValue; // at most an 8 KiB preview…
      truncated?: true; // …set when the input was cut
    }
  | { type: 'scope'; paths: string[]; reason: string }
  | { type: 'wake'; target: Address; message: string } // the held message's id
  | {
      type: 'agent-registration';
      agent: Address;
      client: string;
      requestedBy?: Address; // the human the agent registers under
    }
  | {
      type: 'overseer-action';
      conversation: string;
      actionId: string;
      summary: string;
    };
```

Only runs raise `scope` gates. A scope request must be exactly
`kind: 'question'`, `blocking: true`, `choices: ['grant', 'deny']`; validation
rejects any other shape with the correct one in the error, since agents now
write it through `msg_send`. Every other gate is raised by the daemon or a
deciding human.

The 64 KiB `data` cap applies to gates too, so a `tool-approval` gate carries a
preview of the input; the executor holds the real one.

`NotificationKind` toggles map onto these: `approval` ↔ `tool-approval`,
`scope-request` ↔ `scope`, `question` ↔ a blocking question with no gate `data`.
`wake` and `agent-registration` notify under `approval`.

### Tables (`messages.db`)

Stored in the machine-local run-state directory
(`$DISPATCH_HOME/.dispatch/runs/<sha256(rootDir)[:12]>/messages.db`), never
committed. Messages are traffic, not board state; they cross machines in #5.
`PRAGMA user_version` stamps the schema; a build refuses a newer file.

```sql
messages     (id PK, thread, reply_to, from_addr, session, kind, body,
              refs_json, data_json, urgent, blocking, choices_json, choice,
              wake, created_at)                    -- one answer per reply_to
recipients   (message_id, position, addr)          -- the `to` list as sent
deliveries   (id PK, message_id, recipient, run_id NULL,
              via,             -- direct | channel
              state,           -- held | sending | pushed | notified | read | answered
              updated_at)
channels     (name PK, created_at, auto)           -- auto = epic channel
members      (channel, addr, joined_at)            -- addr: task/actor, never run
agents       (addr PK, display_name, client, token_hash UNIQUE,
              status,          -- pending | approved | revoked
              muted,           -- deliveries from it skip push/notify, stay readable
              approved_by NULL, created_at)
gate_effects (question_id PK, applied_at)          -- gate answers whose effect ran
```

A message is stored once; each resolved recipient gets a delivery with its own
state. A six-member channel message is one message and six deliveries. Delivery
updates are compare-and-set on the expected state, so a lost race leaves the
newer state.

## Delivery engine

`DeliveryEngine.send(input, sender)`:

1. **Authorize sender.** Approved agent, human, the system, or a run the host
   authenticated. Pending/revoked agents are rejected.
2. **Check participation.** A reply (`replyTo` set, any kind) must come from a
   participant of its target: the target's sender or a delivery recipient, where
   an execute run also stands for its task, that task's other execute runs and
   deliveries bound to it. The system and deciding humans are exempt. This runs
   before validation, so a non-participant learns nothing about the target.
3. **Validate** the envelope (above). Agent replies also pass the ping-pong
   breaker, and a second answer to a question is a `conflict`.
4. **Resolve recipients.** Expand channels to members. `task:` → its live
   execute run, else held. `run:` → must be live, else the send fails; a
   not-live run reached through a channel is skipped, and a reply to an ended
   run goes to its task instead (a review or verify run has none, so the reply
   is held on it). `agent:` → held in its mailbox. Humans → the host's notifier.
   De-duplicate (direct beats channel); never deliver to the sender, a run's own
   task, or `agent:dispatch`.
5. **Choose a mode per delivery.**
   - Live recipient, direct address or `urgent` → **push** (queued for the next
     turn boundary).
   - Live recipient via a channel → **notify** (a digest line at the agent's
     next step).
   - Not live → **held**. If `wake: 'request'`, run the wake policy.
6. **Commit** message + deliveries in one transaction (an answer also moves the
   question's deliveries to `answered`), then call host hooks. The store is an
   outbox: hooks run only after commit.

```ts
interface MessagingHost {
  liveRunFor(taskId: string): string | null; // the task's live execute run
  isLiveRun(runId: string): boolean;
  taskOfRun(runId: string): string | null; // null for review/verify runs
  push(runId: string, rendered: string, message: Message): Promise<void>;
  notify(runId: string, digest: string, message: Message): Promise<void>;
  notifyHuman(actor: Address, message: Message): void;
  wake(target: Address, message: Message): Promise<WakeResult>;
  decide(request: PolicyRequest): 'allow' | 'ask' | 'deny';
  owner(target: Address): Address; // human to ask for a wake gate
  implicitMembers(channel: string): Address[]; // e.g. epic children
  onAnswered(question: Message, answer: Message): Promise<void>; // idempotent
  now(): Date;
}
```

A `push` or `notify` that throws puts the delivery back to `held`. The daemon
throws for a run whose executor cannot take mid-run input (the CLI executor) and
for a run being cancelled or asked to stop, so its mail waits for the task's
next execute run.

**Answers and gates.** A question takes one answer; a second, including one
after the daemon closes it (`close()`, a system answer with `x-closed` data and
no effect), is a `conflict`. Answering a gate needs a deciding human.
`onAnswered` is how gates take effect: answering a `tool-approval` question
calls the orchestrator's `approve`, a `scope` answer records the grant, a `wake`
answer wakes the task, an `agent-registration` answer approves or revokes the
agent. The effect is awaited before the answer is published or its deliveries
are dispatched, then recorded in `gate_effects`. Handlers must be idempotent:
`recover()` replays every answered gate with no record.

**Wake.** Only held `task:` recipients of a `wake: 'request'` message are woken.
`host.decide` denies anything but a task that exists and is not an epic, landed
or dropped. Any other wake, whoever sent it, consults the autonomy ladder's
`wake` gate, which stops blocking at rung 3 and is capped by the task's risk:
`auto` → `allow`, otherwise `ask`. So at rungs 1–2 a human's wake also raises a
gate to the owner. Always allowing a human sender's wake, which would retire
`/message {resume: true}`, is not built yet.

- `allow` → `host.wake` calls `dispatchOrResume` for the task as
  `agent:dispatch`: a new run resuming the task's latest session. It never
  pushes into a finished run — Claude runs end at their first `result` and Codex
  runs have one turn. On failure the sender gets "Could not wake …".
- `deny` → stays held; the sender gets a `notice`.
- `ask` → the engine sends a blocking `question` with
  `GateData { type: 'wake' }` and choices approve/deny to `host.owner(target)`,
  quoting the first line of the message at digest width.

Approving a wake gate does nothing while the task has a live execute run that
can take its mail. Otherwise it re-checks the deny conditions (the task may have
landed since) and tells the sender "Not woken: task … is <status>", or wakes,
telling the sender if that fails. Either way the gate is marked applied. Notices
to a sender run that has ended go to its task.

**Run start.** When an execute run starts, the host calls
`engine.deliverHeld(runId, taskId)`: every held delivery for the task — to
`task:<id>`, or stranded on one of its earlier runs — is claimed for the run and
pushed or (channel mail) notified.

**Guardrails** (defaults, overridable in `config.yml` under `messaging:` as
positive integers; read once at daemon start, and a malformed file falls back to
the defaults):

- `urgentPerHour: 10` per agent or run. Over quota the message loses `urgent`
  (channel members get a digest, not a push), and the send result says
  `downgraded: true`.
- `agentTurnsPerThreadPerHour: 20` agent-authored messages per thread. When
  exceeded, further agent replies to the thread are rejected (`limited`) and the
  project owner gets one `notice` per hour flagging it.
- `agentBlockingTimeoutSec: 600`, at most 1800, for blocking messages to agents.
  On timeout the sending tool returns "no answer yet — it will arrive in your
  inbox" and the question stays open. The cap keeps the wait inside the in-run
  MCP tool timeout.
- Blocking messages to humans wait up to 30 minutes in the MCP tool (the in-run
  MCP tool timeout is 31). On expiry a plain question stays open and its answer
  is pushed to the run later, or held for its task. An expired `scope` gate
  closes as denied, matching today's `request_scope`. `tool-approval` gates are
  not MCP calls — they park the executor's `canUseTool` — and have no timeout.

**Rendering.** A pushed message is a header, then every body line quoted with
`│ ` so a body can never pass for a header, then any of `(in reply to <id>)`,
`choices: a | b`, `choice: a`, `refs: …`, and for a blocking message
`The sender is waiting. Answer with msg_reply(messageId: "<id>").`

```text
[message from run:r-9f2c01 · question · urgent · m-01k…]
│ Is the /sessions response final?
│ The client team starts Monday.
choices: yes | no
The sender is waiting. Answer with msg_reply(messageId: "m-01k…").
```

Digests render one line per message, the first body line cut to 80 characters:
`📬 #epic/e-c25f9c · notice from run:r-9f2c01: api shape changed (m-…)`.

**Restart.** Deliveries bound for a run are committed as `sending` and move to
`pushed`/`notified` once the hook returns. On daemon start, after the
orchestrator has reconciled the previous process's runs and before HTTP serves,
`engine.recover()` retries every `sending` delivery whose run is still live,
reverts the rest to `held`, and replays unapplied gate effects, so a crash
between commit and hook never loses a message or an approval.

**Muted senders.** Deliveries from a muted agent are stored as `read`: visible
in threads, never pushed, notified or delivered at run start.

## Identity

**Runs.** On dispatch the daemon mints a run token (an HMAC of the run id under
a per-boot secret, so it dies with the daemon) and writes it to a 0600 file
beside the run's transcript (`<runs dir>/<runId>.token`). The dispatch MCP
server gets only the path, as `DISPATCH_RUN_TOKEN_FILE` beside
`DISPATCH_RUN_ID`, because backends put MCP env on a process's argv. The file is
deleted when the run ends, and the daemon refuses the token once the run is not
live. A run sends as `run:<id>`; an execute run may also act for its task and
the task's other execute runs, while a review or verify run acts only as itself.

The self-authenticated messaging routes (see Transport) refuse the daemon file's
shared `agentToken` with a 403 that points runs at `DISPATCH_RUN_TOKEN_FILE` and
everyone else at `POST /api/agents/register`.

**Gate answers need the `decide` tier.** A reply to a question carrying
`GateData` is accepted only from a human at the `decide` tier or above, exactly
as `POST /api/runs/:id/approval` and scope `decide` are today. Agents can answer
plain questions; they can never approve their own tool calls, scope, wake-ups or
registrations.

**What identity guarantees locally.** Any process running as the same OS user
can read the daemon file and token files, so on one machine identity gives
attribution and consent, not a security boundary. It becomes a boundary when
messages cross the network (#5).

**External agents.** `dispatch mcp` without a run token:

1. Names itself from `DISPATCH_AGENT_NAME`, else the MCP `clientInfo.name` plus
   the short hostname, normalized to the handle grammar (at most 40 characters,
   e.g. `claude-code.macbook`).
2. Reads its cached identity from
   `$DISPATCH_HOME/.dispatch/agents/<sha256(realpath(root))[:12]>/<name>.json`
   (`{ token, address }`, mode 0600, directory 0700), so each project has its
   own.
3. With no cache, calls `POST /api/agents/register` with `{ name, client }`
   (each at most 100 characters; control and line-break characters are
   stripped). The daemon registers `agent:<requester>/<name>` as `pending`,
   where the requester is the calling human (the shared `agentToken` is the
   owner, a teammate's token that teammate); returns a token that does nothing
   until approved; and sends the project owner a blocking question with
   `GateData { type: 'agent-registration' }` naming the requester. A name
   already pending or approved is a 409; if the gate cannot be sent the agent is
   revoked so a retry can register again.
4. Until approved, every messaging tool returns "awaiting approval in Dispatch".
   Revoking kills the token immediately. When the daemon no longer knows a
   cached token, the MCP drops the file and registers once; a revoked agent is
   never re-registered automatically — the tool names the file to delete to ask
   again.

The identity is the agent install, not the session: all sessions of
`agent:wyat/claude-code.macbook` share its mailbox; `session` records which one
sent a message.

## Transport

Daemon routes (FSL):

```text
POST   /api/messages                        send; Idempotency-Key replays the first result
GET    /api/messages/:id
POST   /api/messages/:id/reply              answer if the target asks, else a message
GET    /api/messages/:id/answer[?wait=1]    the answer or null; wait=1 long-polls 30 s
GET    /api/threads?limit=N                 recent threads (default 50, at most 200)
GET    /api/threads/:id                     thread with delivery states
GET    /api/mailbox?address=&state=a,b      mailbox; the caller's own by default
POST   /api/deliveries/:id/read
GET    /api/channels                        list, with each epic's implicit channel
POST   /api/channels/:name/members          join; body { member? }, default the caller
DELETE /api/channels/:name/members[/:addr]  leave; no addr leaves as the caller
GET    /api/decisions/open                  open blocking questions to humans
GET    /api/agents/roster                   request tier; token hashes stripped
POST   /api/agents/register                 request tier
POST   /api/agents/:addr/approve | /revoke | /mute | /unmute    decide tier
```

**Authentication.** Every route above except `/api/agents/*` authenticates
itself: the daemon resolves the caller to a principal right after the Origin
check and fails closed with 401/403 before any handler runs. A principal is a
team member's token (a human, deciding at the `decide` tier), a live run's
token, or an approved agent's token. Approve and revoke answer the open
registration gate as the calling human, so its handler stays the one writer of
an agent's status.

**Authorization: participants or deciding humans.** A principal acts as itself;
an execute run also as its task and that task's other execute runs; a deciding
human as anyone.

- A message, its answer and a thread are readable by their participants (the
  sender, or a delivery recipient the principal acts as) and deciding humans.
  Only the asker (or a deciding human) may long-poll an answer.
- A mailbox, marking a delivery read, and joining or leaving a channel need the
  principal to act as that address. A run's own mailbox merges its address, its
  task and deliveries bound to it.
- Recent threads and open decisions are for deciding humans only.
- An epic's children cannot leave its channel (404 says why).

WebSocket event `message.new` carries the message inline (every client fetches
it immediately; see the rule in `events.ts`); `delivery.changed`
(`{ deliveryId, messageId }`) is a bare refetch signal. `/ws` sends these to any
request-tier token, the shared `agentToken` included. Like the store file, that
is attribution, not a boundary, and must be scoped before federation (#5).

## MCP tools

The same tools for runs and external agents, in `packages/mcp`:

| Tool                                                                          | Replaces                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `msg_send(to, kind, body, refs?, data?, urgent?, blocking?, choices?, wake?)` | `agent_message`, `message_user`, `ask_user`, `request_scope` |
| `msg_reply(messageId, body, choice?)`                                         | answering questions, accepting handoffs                      |
| `inbox_read(state?, limit?, markRead?)`                                       | —                                                            |
| `thread_read(threadId)`                                                       | —                                                            |
| `channel_join(name, member?)` / `channel_leave(name, member?)`                | —                                                            |
| `channel_list()`                                                              | —                                                            |

- `msg_send` retries a dropped connection once with the same `Idempotency-Key`.
  With `blocking: true` it long-polls the answer route in 45 s requests for up
  to 30 minutes when any recipient is a human, else `agentBlockingTimeoutSec`
  (read from `GET /api/config`). The answer also arrives the usual way — pushed
  to a run's session, or held in an external agent's mailbox — and the tool
  result says where, so the agent does not act on it twice.
- `inbox_read` lists the caller's mailbox newest first, at most `limit` items
  (default 50). Without `state` it asks only for unread states (`held`,
  `notified`, `pushed`), so read mail never crowds the limit. It marks the
  returned `held`/`notified` items read unless `markRead: false`, and returns
  the ids it marked.
- `channel_join`/`channel_leave` take a bare channel name; `member` defaults to
  the caller (a run's task).
- Each external-agent MCP process makes a session id at start and sends it on
  every `msg_send` and `msg_reply`; a run is one session and sends none.

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

`awaiting-approval` stays a run state — the executor parks inside `canUseTool`
and `orchestrator.approve` checks it — but it is entered only when a
`tool-approval` gate is sent and left only when that gate is answered or closed,
so the state and the open gate cannot disagree. `RunStatePill`, `ApprovalCard`
and `pendingApprovals.ts` keep their rendering and change their source.

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

- `push` fails (the run died, cannot take mid-run input, or is stopping) →
  delivery reverts to held; delivered on the task's next execute run.
- `wake` fails → sender gets a `notice` with the reason (through its task if its
  run has ended); message stays held.
- A gate effect throws → the answer stands; `recover()` replays the effect at
  the next boot.
- Daemon restart → `recover()` (above). No state lives only in memory.
- Invalid envelope or unknown address → rejected at send with a field-specific
  error.

## Testing

- `@dispatch/protocol`: unit tests for validation, address resolution, mode
  selection, quotas, the ping-pong breaker, participation, wake policy and
  recovery, against in-memory SQLite and a recording fake host.
- `@dispatch/server`: route tests, principal resolution and object-level
  authorization, registration approval, gate handlers, run-token files, derived
  `awaiting-approval`, and gate payloads driving the autonomy policy. Avoid the
  in-process daemon traps (no `spawnSync` against the in-process server;
  `realpathSync` temp dirs).
- `@dispatch/mcp`: tool tests against a fake daemon, including blocking waits,
  token self-healing and revoked guidance.
- `apps/desktop`: component tests for Threads view logic, and one e2e flow: an
  agent asks a blocking question, the human answers in Threads, the run resumes.
