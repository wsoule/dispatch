# 4 Messages

A message is one JSON object, stored once. A sender gives a **send input**; the
host checks it, assigns the fields only a host may set, and stores the result
with one delivery per resolved recipient.

## 4.1 Envelope

A stored message has these sixteen fields. `session`, `data`, `choices` and
`choice` are absent when not set; every other field is always present.

| Field       | Type                | Set by | Meaning                                                                                                    |
| ----------- | ------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `id`        | message id          | host   | unique, sorts in creation order ([§1.4](01-introduction.md#s1.4))                                          |
| `thread`    | message id          | host   | the id of the thread's first message: the reply target's `thread` for a reply, else the message's own `id` |
| `replyTo`   | message id or null  | sender | the message this one replies to                                                                            |
| `from`      | address             | host   | the authenticated sender ([§9.1](09-identity-and-authorization.md#s9.1))                                   |
| `session`   | string              | sender | which session of an agent install sent it; informational                                                   |
| `to`        | addresses           | sender | the recipients, after a reply's rewriting ([§4.6](04-messages.md#s4.6))                                    |
| `kind`      | string              | sender | [§4.2](04-messages.md#s4.2)                                                                                |
| `body`      | string              | sender | the text, in Markdown                                                                                      |
| `refs`      | list of refs        | sender | what the message is about ([§4.3](04-messages.md#s4.3)); empty when none                                   |
| `data`      | JSON value          | sender | a structured payload: gate data ([§5.1](05-gates.md#s5.1)), private data, or a marker                      |
| `urgent`    | boolean             | sender | push even to a recipient reached through a channel; the host may drop it ([§6.6](06-delivery.md#s6.6))     |
| `blocking`  | boolean             | sender | the sender is waiting for the answer; questions and handoffs only                                          |
| `choices`   | list of strings     | sender | the answers a question or handoff offers ([§4.7](04-messages.md#s4.7))                                     |
| `choice`    | string              | sender | the choice an answer makes                                                                                 |
| `wake`      | `none` or `request` | sender | `request` asks the host to wake a recipient that is not live ([§6.5](06-delivery.md#s6.5))                 |
| `createdAt` | timestamp           | host   | when the host stored it ([§1.4](01-introduction.md#s1.4))                                                  |

A send input has the sender's fields above, all optional except `to`, `kind` and
`body`, plus `idempotencyKey` ([§4.9](04-messages.md#s4.9)), which is not stored
in the envelope. `refs` defaults to empty, `urgent` and `blocking` to false,
`wake` to `none` and `replyTo` to null. A handoff without `choices` gets
`accept` and `decline` ([§4.7](04-messages.md#s4.7)). A stored message keeps
every field of its send input unchanged, except that a handoff may gain those
default choices, a reply's `to` is rewritten ([§4.6](04-messages.md#s4.6)), and
the urgent quota may drop `urgent` ([§6.6](06-delivery.md#s6.6)).

## 4.2 Kinds and private use

| Kind       | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `message`  | ordinary mail                                                    |
| `question` | expects one answer; open until it has one                        |
| `answer`   | replies to a question or handoff, and may make a choice          |
| `handoff`  | asks the recipient to take the work over; answered with a choice |
| `notice`   | information that expects no reply                                |

A kind matching `x-[a-z0-9][a-z0-9-]*` is private use: a host stores and
delivers it as it does a `message` and never interprets it. Private kinds are
never registered. A host MUST refuse any other kind as `invalid` on `kind`.
Adding a built-in kind is a major change ([§14.1](14-versioning.md#s14.1)).

## 4.3 Refs

A ref points at something a message is about: `{ "type", "id" }`, with an
optional `at`.

| Type      | `id` names   | `at`                           |
| --------- | ------------ | ------------------------------ |
| `task`    | a work item  | none                           |
| `run`     | a session    | none                           |
| `file`    | a file path  | the commit the path is read at |
| `commit`  | a commit     | none                           |
| `message` | a message id | none                           |

A ref's `id` is required and non-empty. `id` and `at` are each one line of at
most 512 bytes. A local send whose ref has a type the host does not know MUST
fail `invalid` on `refs[i].type`. The registry of ref types is
[§11.5](11-registries.md#s11.5); a host MAY implement any type it lists.

## 4.4 Refs received from other hosts

A message that arrives from another host or an external client through a binding
is validated as **received**. A received ref whose `type` is an identifier the
host does not know MUST be accepted when its `id` and `at` meet
[§4.3](04-messages.md#s4.3)'s limits; the host stores it unchanged and presents
it like any other ref. A received ref whose `type` is not an identifier is
refused as `invalid` on `refs[i].type`. This is what lets a later minor version
add a ref type without a peer of an earlier version refusing the whole message.

## 4.5 Validation and limits

A host MUST refuse a send input that breaks any rule below, with the error and
field shown. When one input breaks several rules, the host returns the error of
one of them.

| Field            | Rule                                                                                        | Error                                                             |
| ---------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `to`             | 1 to 50 entries                                                                             | `invalid` on `to`                                                 |
| `to[i]`          | an address ([§3](03-addresses.md#s3))                                                       | `invalid` on `to[i]`                                              |
| `kind`           | a built-in or private kind ([§4.2](04-messages.md#s4.2))                                    | `invalid` on `kind`                                               |
| `body`           | a string, not blank, except that an answer that carries a `choice` may have a blank body    | `invalid` on `body`                                               |
| `body`           | at most 64 KiB                                                                              | `invalid` on `body`                                               |
| `data`           | at most 64 KiB, measured as [§1.4](01-introduction.md#s1.4) says                            | `invalid` on `data`                                               |
| `data`           | gate data only as [§5](05-gates.md#s5) allows                                               | as [§5](05-gates.md#s5)                                           |
| `session`        | one line, at most 200 bytes                                                                 | `invalid` on `session`                                            |
| `idempotencyKey` | one line, at most 200 bytes                                                                 | `invalid` on `idempotencyKey`                                     |
| `refs`           | at most 50 entries, each as [§4.3](04-messages.md#s4.3) and [§4.4](04-messages.md#s4.4) say | `invalid` on `refs` or `refs[i].type`, `refs[i].id`, `refs[i].at` |
| `blocking`       | true only on a question or handoff                                                          | `invalid` on `blocking`                                           |
| `choices`        | only on a question or handoff; 1 to 20 distinct entries, none blank                         | `invalid` on `choices`                                            |
| `choices[i]`     | one line, at most 200 bytes                                                                 | `invalid` on `choices[i]`                                         |
| `choice`         | only on an answer; one line, at most 200 bytes; as [§4.7](04-messages.md#s4.7) says         | `invalid` on `choice`                                             |
| `replyTo`        | required on an answer, and must name a question or handoff                                  | `invalid` on `replyTo`                                            |

These limits are the same for every host, binding and receiver: a limit a host
enforced more loosely would let one send exceed another host's ceiling.

**The order of checks in a send.** A host checks a send in this order, and the
first check that fails is the send's error (pinned rule 1; vectors:
`core.gates.only-humans-and-the-system-decide`,
`core.idempotency.a-revoked-sender-gets-no-replay`,
`core.idempotency.a-retried-answer-replays`,
`core.participation.absent-and-foreign-look-alike`,
`core.participation.comes-before-validation`,
`core.participation.an-empty-reply-to-names-no-message`,
`core.participation.a-reply-authorizes-before-its-target`):

1. **Authorize the sender** ([§9](09-identity-and-authorization.md#s9)): refuse
   an agent that is not approved, and a sender that claims to decide from an
   address that is neither a `human:` address nor the system address, as
   `forbidden` on `from`.
2. **Replay an idempotency key** ([§4.9](04-messages.md#s4.9)): a hit returns
   the first send's result and nothing below runs.
3. **Participation** for a reply ([§4.6](04-messages.md#s4.6)): a `replyTo` that
   names no message (an empty string included), or a message the sender does not
   participate in, fails `not-found` on `replyTo`.
4. **Validate** the input: this section, and the gate rules of
   [§5](05-gates.md#s5).
5. **The breaker** for a reply from an agent or session
   ([§6.6](06-delivery.md#s6.6)): `limited` on `replyTo`.
6. **One answer**: an answer to a question that already has one fails `conflict`
   on `replyTo` ([§4.7](04-messages.md#s4.7)).
7. **The urgent quota** ([§6.6](06-delivery.md#s6.6)), which drops `urgent`
   instead of failing.

Resolution ([§3.5](03-addresses.md#s3.5)) and the initial states of
[§6.1](06-delivery.md#s6.1) follow, and can fail the send too. A send that fails
stores no message and no delivery of its own.

## 4.6 Threads and participation

A message that replies to nothing starts a thread; a reply joins the thread of
the message it replies to ([§4.1](04-messages.md#s4.1)).

**Participation.** A sender participates in a message when it is the message's
sender, or a recipient of one of its deliveries, counting a session as every
address it acts for ([§2.2](02-terminology.md#s2.2)) and as the recipient of
every delivery bound to it. The system address and deciding principals are
exempt: they may reply to, and read, any message.

A send that sets `replyTo`, of any kind, MUST come from a participant of the
message it names. A `replyTo` that names no message, and one that names a
message the sender does not participate in, MUST both fail `not-found` on
`replyTo`, at the participation step of [§4.5](04-messages.md#s4.5), before the
input is validated. A non-participant therefore cannot tell a message that
exists from one that does not ([§13.5](13-security-and-privacy.md#s13.5)).

**Replies to an ended session.** In a reply, an entry of `to` that is the reply
target's sender or one of the target's `to` addresses, when that entry is a
session that is no longer live and stands for a work item, is rewritten to that
work item, so the work item's live or next session hears the reply. Entries that
become equal are collapsed, and the stored `to` is the rewritten list. A reply
to an ended auxiliary session is not rewritten; its delivery is held on the
session ([§6.1](06-delivery.md#s6.1)). Any other ended session a reply names
fails as [§6.1](06-delivery.md#s6.1) says. (pinned rule 5; vectors:
`core.answers.a-reply-to-an-ended-session-goes-to-its-work-item`,
`core.answers.a-reply-reaches-the-successor-session`,
`core.answers.a-reply-rewrites-and-collapses-an-ended-session`,
`core.answers.a-reply-to-an-ended-auxiliary-session-is-held-on-it`,
`core.answers.a-reply-to-an-ended-recipient-goes-to-its-work-item`,
`core.answers.a-reply-to-an-ended-recipient-reaches-the-successor-session`,
`core.answers.a-reply-naming-an-ended-session-its-target-never-reached-fails`)

**Replying to a message.** A host MAY offer a shorthand that replies to one
message: it sends to the target's sender, as an `answer` when the target is a
question or handoff and as a `message` otherwise, with `replyTo` set to the
target. When the target does not exist it fails `not-found` on `replyTo`. The
shorthand is a send and keeps the order of [§4.5](04-messages.md#s4.5): a sender
refused at the first step fails `forbidden` on `from` whether or not the target
exists.

## 4.7 Questions, answers and handoffs

A question or handoff is **open** until it has an answer. It takes exactly one:
a second answer, including one after a close ([§4.8](04-messages.md#s4.8)), MUST
fail `conflict` on `replyTo`. When the answer is stored, every delivery of the
question moves to `answered` ([§6.1](06-delivery.md#s6.1)).

A handoff without `choices` gets the choices `accept` and `decline`. An answer
carrying a `choice` may have a blank body. An answer to a gate or a handoff MUST
carry one of the question's `choices` when the question has any, and MUST carry
none when it has none. An answer to any other question MAY carry a `choice`,
which MUST be one of the question's `choices`; it may instead answer in its body
alone. A choice that breaks this fails `invalid` on `choice`. (pinned rule 6;
vectors: `env.envelope.body-is-required-unless-an-answer-chooses`,
`env.envelope.a-gate-answer-must-choose`,
`env.envelope.a-handoff-answer-must-choose`,
`env.envelope.a-choice-must-be-one-of-the-questions`,
`env.envelope.free-text-may-answer-a-plain-question`,
`core.answers.a-handoff-defaults-to-accept-or-decline`)

Answering a gate needs a deciding principal ([§5.4](05-gates.md#s5.4)).

## 4.8 Close

A host MAY close an open question or handoff itself, for example when the
session that asked it has ended. A close is an answer from the system address,
to the question's sender, whose `data` is `{ "type": "x-closed", "reason": … }`
and whose body gives the reason (its wording is not normative). A close applies
no gate effect, creates no delivery and dispatches nothing: the question's
deliveries move to `answered`, and the close is published to readers like any
other message. Closing a question that already has an answer fails `conflict` on
`replyTo`; closing a message that is not a question or handoff fails `invalid`
on `replyTo`; closing a message that does not exist fails `not-found` on
`replyTo`. `x-closed` data is a close only when the system address sent it
([§13.14](13-security-and-privacy.md#s13.14)). (pinned rule 8; vectors:
`core.close.answers-without-effect-or-deliveries`,
`core.close.moves-the-question-to-answered`,
`core.close.an-absent-question-is-not-found`,
`core.close.an-answered-question-conflicts`,
`core.close.a-non-question-is-invalid`,
`core.markers.close-is-honored-only-from-the-system`)

## 4.9 Idempotency and replay

A send input MAY carry an `idempotencyKey`: one line of at most 200 bytes,
scoped to its sender, so that two senders may use the same key. A host MUST keep
each key as long as the message it names, across restarts, so a retry after a
crash still finds it.

A send whose sender already sent a message with the same key MUST return that
first message and its current deliveries, with `replayed: true`, and MUST run no
hooks and create nothing. The lookup comes right after the sender is authorized
and before every other check of [§4.5](04-messages.md#s4.5): a retried answer
replays instead of meeting `conflict`, and a retry after the breaker has tripped
replays instead of meeting `limited`. Because it comes after authorization, a
sender whose authorization was revoked gets no replay. A key reused with a
different input still returns the first message; hosts are not required to
detect it. (pinned rule 15; vectors:
`core.idempotency.replays-the-first-message`,
`core.idempotency.keys-are-per-sender`,
`core.idempotency.a-key-is-one-line-of-at-most-200-bytes`,
`core.idempotency.a-revoked-sender-gets-no-replay`,
`core.idempotency.a-retried-answer-replays`)
