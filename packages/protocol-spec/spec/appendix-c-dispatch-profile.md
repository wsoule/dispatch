# Appendix C Dispatch profile

This appendix is informative for Core. It is also the rule set a
Dispatch-profile claim is measured against ([§12.1](12-conformance.md#s12.1),
[§12.3](12-conformance.md#s12.3)): the `dispatch` vectors check what it says,
and a host that claims the profile does all of it. Dispatch's host is its
daemon, one per project on each machine.

The profile computes one kind of implicit member ([§3.6](03-addresses.md#s3.6)):
the members of `channel:epic/<id>` are the work items whose parent is that epic.
They are added when a message is sent, never stored, and cannot leave the
channel. No other channel has implicit members.

## C.1 Identifiers

| Identifier   | Dispatch form                                                                             | Example                          |
| ------------ | ----------------------------------------------------------------------------------------- | -------------------------------- |
| work item id | `[te]-[0-9a-f]{6,12}`: `t-` for a task, `e-` for an epic                                  | `t-4a8cce`, `e-c25f9c`           |
| session id   | `r-[0-9a-f]{6,12}`: a session is one Dispatch run                                         | `r-9f2c01`                       |
| message id   | `m-` and a lowercase [ULID](https://github.com/ulid/spec)                                 | `m-` and 26 characters           |
| delivery id  | `d-` and a lowercase ULID                                                                 | `d-` and 26 characters           |
| agent        | `agent:<operator>/<name>`: the handle of the human it registered under, then its own name | `agent:wyat/claude-code.macbook` |

The profile narrows the grammar of work item and session ids, and refuses an id
outside these forms as `invalid` on the field that carried it
([§3.1](03-addresses.md#s3.1)). Vectors:
`env.address.dispatch-grammar-admits-epic-ids`,
`env.address.refuses-a-task-id-outside-the-dispatch-grammar`,
`env.address.refuses-a-run-id-outside-the-dispatch-grammar`.

A ULID is 48 bits of milliseconds and 80 random bits, written as 26 characters
of Crockford base 32. Dispatch writes them in lowercase and keeps each host's
ids strictly increasing, even for sends in the same millisecond or after the
clock steps back, so its ids sort in creation order
([§1.4](01-introduction.md#s1.4)) and carry the entropy
[§13.7](13-security-and-privacy.md#s13.7) asks for. In the `dispatch` profile
the kit checks this form on every id a host generates
([§12.4.5](12-conformance.md#s12.4.5)).

## C.2 System address and owner

The system address is `agent:dispatch` ([§2.3](02-terminology.md#s2.3)). Only
the daemon's own code sends as it, and it never receives a delivery.

The owner Dispatch names for every target is the project's owner: the human the
daemon runs for. The owner is asked whether to wake a target
([§C.8](appendix-c-dispatch-profile.md#sC.8)), told when the breaker stops
agents in a thread ([§C.7](appendix-c-dispatch-profile.md#sC.7)) and told when
an answer to a gate is set aside ([§5.7](05-gates.md#s5.7)). The system also
raises the `tool-approval`, `agent-registration`, `overseer-action` and
`task-proposal` gates to the owner
([§C.3](appendix-c-dispatch-profile.md#sC.3)). Which humans may decide follows
from the daemon's credential tiers
([Appendix A](appendix-a-daemon-api.md#sA.1)).

## C.3 Gate types

Dispatch implements `wake` ([§5.9](05-gates.md#s5.9)) and the six permanent
types below, and a host that claims the profile declares all seven
([§12.1](12-conformance.md#s12.1)). Each effect is idempotent and applied as
[§5.5](05-gates.md#s5.5) says.

| Type                 | Raised by         | Choices                        | Data besides `type`                                                            |
| -------------------- | ----------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `tool-approval`      | system            | approve, approve-session, deny | `requestId`, `runId` or `conversation`, `tool`, `input`, `truncated`?, `floor` |
| `scope`              | session           | grant, deny                    | `paths`, `reason`                                                              |
| `agent-registration` | system            | approve, deny                  | `agent`, `client`, `requestedBy`?                                              |
| `overseer-action`    | system            | confirm, cancel                | `conversation`, `actionId`, `summary`                                          |
| `task-proposal`      | system            | approve, decline               | `task`, `proposedBy`, `message`                                                |
| `memory`             | system-or-decider | approve, reject                | `proposalId`, `action`, `scope`, `kind`                                        |

**`tool-approval`.** The system raises it to the owner as a blocking question
when a session or the overseer parks a tool call for approval, with refs to the
run and its work item. `requestId` names the parked call, `runId` the session
(or `conversation` the overseer conversation) it is parked in, and `tool` the
tool. `input` is the call's input when its JSON fits in 8 KiB, and otherwise
that text cut on a code point to 8 KiB, with `truncated: true`; the host keeps
the full input ([§13.11](13-security-and-privacy.md#s13.11)). `floor` says
whether Dispatch's irreversible-action floor holds the call, judged on its full
input. `approve` releases the call once, `approve-session` releases it and
allows the same tool for the rest of the session, and `deny` refuses it, with
the answer's body as the reason when it is not blank. When the project's
autonomy policy allows the call at the task's rung, the system answers for the
owner with an `x-policy` marker ([§C.4](appendix-c-dispatch-profile.md#sC.4)),
never for a call the floor holds. Vectors:
`env.envelope.agents-may-not-forge-tool-approval-gates`,
`core.answers.a-gate-effect-runs-before-the-answer-is-published`.

**`scope`.** A session asks its human to let it write outside its declared
paths. Only a session raises it, and its shape is fixed
([§5.3](05-gates.md#s5.3)): kind `question`, `blocking` true, `choices` exactly
`grant` then `deny`, and data `{ "type": "scope", "paths", "reason" }`, with a
non-empty list of non-empty paths and a reason that is not blank. Any other
shape fails `invalid` on `data`, `data.paths` or `data.reason`. `grant` widens
the session's writes by the paths; `deny` leaves them as they were. The system
grants a request the autonomy policy allows, with an `x-policy` marker, and
denies one that no one decided within 29 minutes, with an `x-expired` marker
([§C.4](appendix-c-dispatch-profile.md#sC.4)). Vectors:
`env.envelope.only-sessions-raise-scope-gates`,
`env.envelope.scope-gates-have-a-fixed-shape`,
`env.envelope.a-scope-gate-names-a-path`,
`env.envelope.a-scope-gate-names-no-empty-path`,
`env.envelope.a-scope-gate-gives-a-reason`.

**`agent-registration`.** The system raises it to the owner when an agent
install registers: `agent` is the address it asks for, `client` the program it
runs in, and `requestedBy` the human who asked, under whose handle it registers.
`approve` approves the agent; `deny` revokes it. Vector:
`core.answers.a-human-decides-an-agent-registration-gate`.

**`overseer-action`.** The system raises it to the owner when Dispatch's
overseer, the project's own assistant, wants to take an action it queued:
`conversation` names the overseer conversation, `actionId` the action, and
`summary` says what the action does. `confirm` runs the action; `cancel` drops
it. Vector: `core.answers.a-human-decides-an-overseer-action-gate`.

**`task-proposal`.** The system raises it to the owner when an A2A client hands
off work ([§8.6](08-a2a-binding.md#s8.6)), as a blocking question replying to
the handoff: `task` names the drafted work item, `proposedBy` the client, and
`message` the handoff. `approve` moves the draft to ready; `decline` drops it,
and the client's task is rejected ([§8.7](08-a2a-binding.md#s8.7)). Vectors:
`core.gates.task-proposal-is-raised-only-by-the-system`,
`core.gates.task-proposal-needs-a-deciding-answer`,
`core.gates.task-proposal-is-answered-with-approve-or-decline`.

**`memory`.** A proposed memory entry waits on it
([§B.3](appendix-b-agent-tools.md#sB.3)). The system raises it to the owner when
a principal proposes to add, supersede or retire a `project` or `team` entry and
the project's autonomy policy does not accept the proposal itself; a deciding
human may raise one too. Its shape is fixed ([§5.3](05-gates.md#s5.3)): kind
`question`, `blocking` true, `choices` exactly `approve` then `reject`, and data
`{ "type": "memory", "proposalId", "action", "scope", "kind" }`. `proposalId` is
`mp-` and an uppercase ULID, and names the proposal, whose text stays with the
host and never travels in the gate. `action` is `add`, `supersede` or `retire`,
`scope` is `project` or `team`, and `kind` is one of `preference`, `convention`,
`constraint`, `hazard`, `decision`, `fact` or `reference`. Any other shape fails
`invalid` on `data` or the field. `approve` applies the proposal; `reject`
discards it. The system rejects a proposal no one decided within the project's
`proposalTtlDays` (14 by default) with an `x-expired` marker
([§C.4](appendix-c-dispatch-profile.md#sC.4)). Vectors:
`core.gates.memory-is-raised-by-the-system-or-a-deciding-human`,
`core.gates.memory-is-refused-from-a-session-or-an-agent`,
`core.gates.memory-needs-a-deciding-answer`,
`env.envelope.a-memory-gate-names-a-proposal`,
`env.envelope.a-memory-gate-has-a-project-or-team-scope`,
`env.envelope.a-memory-gate-names-its-action-and-kind`,
`env.envelope.memory-gates-have-a-fixed-shape`.

**Provisional types.** One more type is registered as provisional
([§11.6](11-registries.md#s11.6)), and joins the profile when the Dispatch
feature that raises it ships with vectors:

| Type  | Raised by | Choices         | Data besides `type`                    | Effect                                     |
| ----- | --------- | --------------- | -------------------------------------- | ------------------------------------------ |
| `doc` | system    | approve, reject | `doc`, `proposal`, `taskId`?, `runId`? | apply or reject a proposed document change |

## C.4 Markers

Besides the core system markers `x-closed` and `x-breaker`
([§11.7](11-registries.md#s11.7)), Dispatch's system address sends two markers
of its own. They are listed here for information, are not registry entries, and
mean something only from the system address.

| Marker      | Data                                                                         | Meaning                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `x-policy`  | `{ "type": "x-policy", "gate", "rung" }`, `gate` being `approval` or `scope` | on the system's answer to a `tool-approval` or `scope` gate: the project's autonomy policy decided it at that rung                                                             |
| `x-expired` | `{ "type": "x-expired" }`                                                    | on the system's `deny` answer to a `scope` gate that no one decided within 29 minutes, and its `reject` answer to a `memory` gate that no one decided within `proposalTtlDays` |

Both are answers from the system address, so the gate's effect applies as for
any deciding answer ([§5.5](05-gates.md#s5.5)). A close carries
`{ "type": "x-closed", "reason" }` ([§4.8](04-messages.md#s4.8)), and the
breaker's notice `{ "type": "x-breaker", "thread" }`
([§6.6](06-delivery.md#s6.6)).

## C.5 Retention

Dispatch keeps messages and deliveries for the life of a project's local run
state: one database in the machine-local run-state directory of the project,
never committed to its repository. A voided answer stays stored as a `message`
([§5.7](05-gates.md#s5.7)). Dispatch offers no deletion of messages or
deliveries in 1.0. This is the documentation
[§13.8](13-security-and-privacy.md#s13.8) requires.

## C.6 Presentation

**Pushes.** Dispatch pushes a message into a session as this text:

```text
[message from <from> · <kind> · <id>]
│ <first line of the body>
│ <each later line of the body>
(in reply to <replyTo>)
choices: <choice> | <choice>
choice: <choice>
refs: <type>:<id>@<at>, <type>:<id>
The sender is waiting. Answer with msg_reply(messageId: "<id>").
```

- The header marks an urgent message, and an external sender
  ([§2.1](02-terminology.md#s2.1)), like this:

  ```text
  [message from <from> · <kind> · urgent · <id>]
  [message from <from> (external) · <kind> · <id>]
  ```

- The body is split at every line break of [§1.4](01-introduction.md#s1.4), and
  each of its lines, blank ones included, follows the quote prefix: `│` (U+2502)
  and a space.
- `(in reply to …)` appears on a reply; `choices:` on a message that offers
  choices, joined by `|` with a space on each side; `choice:` on an answer that
  makes one; `refs:` on a message with refs, each as `<type>:<id>`, with `@<at>`
  when it has an `at`, joined by a comma and a space; and the last line on a
  blocking message.
- For an external sender, the `choices:`, `choice:` and `refs:` lines follow the
  quote prefix too, since they carry the sender's text
  ([§6.8](06-delivery.md#s6.8)). `(in reply to …)` names only the id of the
  message replied to, and the last line only the message's own id, so they stay
  as they are:

  ```text
  [message from <from> (external) · <kind> · <id>]
  │ <each line of the body>
  (in reply to <replyTo>)
  │ choices: <choice> | <choice>
  │ refs: <type>:<id>@<at>, <type>:<id>
  The sender is waiting. Answer with msg_reply(messageId: "<id>").
  ```

**Digests.** Dispatch notifies a session with one line, which names the channel
when the message was sent to one: the first channel among its recipients,
without the `channel:` scheme.

```text
📬 <kind> from <from>: <first line> (<id>)
📬 #<channel> · <kind> from <from>: <first line> (<id>)
📬 <kind> from <from> (external): <first line> (<id>)
```

The first line ends at the first line break of [§1.4](01-introduction.md#s1.4).
One longer than 80 code points is cut to its first 79 and `…` (U+2026).

**Declared forms.** Dispatch's adapter declares these forms
([§12.4.7](12-conformance.md#s12.4.7)), as the `render` member of its hello:

```json
{
  "quotePrefix": "│ ",
  "header": "^\\[message from ",
  "hostLines": [
    "^\\(in reply to ",
    "^choices: ",
    "^choice: ",
    "^refs: ",
    "^The sender is waiting\\. "
  ],
  "digestLead": "^📬(?: #[^ ]+ ·)? [^ ]+ from [^ ]+(?: \\(external\\))?: "
}
```

Vectors: `core.render.dispatch-push-format`,
`core.render.dispatch-external-push-format`,
`core.render.dispatch-digest-format`,
`core.render.dispatch-digest-cuts-a-long-first-line`.

**Notices.** The wording of a notice is not normative in Core
([§12.3](12-conformance.md#s12.3)). Dispatch's are:

| Notice                        | Body                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| a close, on its answer        | `Closed: <reason>`                                                                                             |
| the breaker, to the owner     | `Agents have sent <n> messages in thread <thread> this hour; further agent replies are paused.`                |
| a voided answer, to the owner | `An answer from <from> to gate <id> was set aside; only deciding humans answer gates. The gate is open again.` |
| the wake notices              | [§C.8](appendix-c-dispatch-profile.md#sC.8)                                                                    |

## C.7 Guardrail defaults

| Setting                      | Default | Meaning                                                                                      |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `urgentPerHour`              | 10      | the urgent quota of each agent or session ([§6.6](06-delivery.md#s6.6))                      |
| `agentTurnsPerThreadPerHour` | 20      | the breaker's limit of agent-authored messages in one thread ([§6.6](06-delivery.md#s6.6))   |
| `agentBlockingTimeoutSec`    | 600     | the longest blocking wait on an agent, at most 1800 ([§B.2](appendix-b-agent-tools.md#sB.2)) |

A project overrides them in its configuration as positive integers, read once
when the daemon starts; a malformed file falls back to the defaults. A blocking
wait on a human lasts at most 30 minutes
([§B.2](appendix-b-agent-tools.md#sB.2)). The breaker's owner is the project's
owner ([§C.2](appendix-c-dispatch-profile.md#sC.2)), who gets one notice per
thread and hour.

## C.8 Wake policy

Dispatch rules on each wake ([§6.5](06-delivery.md#s6.5)) as follows:

- A `run:` target: `allow` when the sender is a `human:` address, else `deny`.
- A `task:` target: `deny` when the work item does not exist, is an epic, or is
  landed or dropped. Otherwise `allow` when the sender is a `human:` address,
  since waking a work item is that human's own call, at every rung and with no
  gate. For any other sender, the project's autonomy policy for `wake` at the
  task's rung, capped by the task's risk: `allow` when the policy acts on its
  own there, else `ask`.
- Any other target: `deny`.

On `allow`, Dispatch starts a run. A human's wake of a work item continues its
latest run when that run ended unreviewed with a session and is not a failed run
waiting to be resumed; otherwise, and always for another sender, it starts a run
that resumes the work item's latest session. A human's wake of a session
continues exactly that run, when it ended unreviewed with a session and a
worktree and nothing has continued it yet. A wake never pushes into a finished
run.

On `ask`, the system raises a `wake` gate to the owner whose body names the
sender and the target and quotes the held message's first line, cut as a
digest's is ([§C.6](appendix-c-dispatch-profile.md#sC.6)):

```text
<from> wants to wake <target>:

> <first line>
```

Approving the gate does nothing while the work item has a live run that can take
its mail. Otherwise Dispatch checks the work item again and wakes it, or tells
the sender why not. Either way the gate's effect is recorded as applied.

The notices a wake sends its sender are:

| Case                                      | Body                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- |
| the wake failed                           | `Could not wake <target>: <reason>. Your message is waiting for it.` |
| the policy denied it                      | `Waking <target> was not allowed. Your message is waiting for it.`   |
| an approved gate found it cannot be woken | `Not woken: task <id> is <state>.`                                   |
| an approved gate could not read it        | `Not woken: task <id> could not be read: <error>.`                   |

`<state>` is `missing`, `an epic`, `landed` or `dropped`.

Vectors: `core.wake.a-failed-wake-notice-names-the-reason`,
`core.wake.deny-notice-says-waking-was-not-allowed`,
`core.wake.the-wake-gate-quotes-the-first-line`,
`core.wake.the-wake-gate-quote-ends-at-any-line-break`,
`core.wake.a-first-line-at-the-body-cap-still-raises-the-gate`,
`core.wake.an-ended-session-notice-names-the-reason`.
