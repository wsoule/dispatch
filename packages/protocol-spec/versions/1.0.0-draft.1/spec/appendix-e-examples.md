# Appendix E Examples

This appendix is informative. Each example is the first input of a vector, in a
block that names the vector, followed by what the vector expects. The kit's
tests keep each block equal to its vector's input, so an example cannot drift
from the kit. The examples use the Dispatch profile's id forms and the symbols
of [§12.4.4](12-conformance.md#s12.4.4): `$sN` is the message step N created,
and `$system` the system address.

## E.1 Examples

**An address.** `env.address.parses-each-scheme`

```json vector=env.address.parses-each-scheme
"human:wyat"
```

The first step parses `human:wyat` into
`{ "kind": "human", "handle": "wyat", "address": "human:wyat" }`
([§3.1](03-addresses.md#s3.1)). The later steps parse one address of each core
scheme; `agent:wyat/claude-code.macbook`, for one, gives the `operator` `wyat`
and the `handle` `claude-code.macbook`.

**A valid send input.** `env.envelope.accepts-a-plain-message`

```json vector=env.envelope.accepts-a-plain-message
{
  "to": ["task:t-4a8cce"],
  "kind": "message",
  "body": "hi"
}
```

Validated as the session `run:r-9f2c01`, which cannot decide, the input is
valid: recipients, a kind and a body are all a message needs
([§4.5](04-messages.md#s4.5)).

**A refused kind.** `env.envelope.unknown-kind-refused-x-kind-accepted`

```json vector=env.envelope.unknown-kind-refused-x-kind-accepted
{
  "to": ["task:t-4a8cce"],
  "kind": "shout",
  "body": "hi"
}
```

`shout` is neither a built-in kind nor a private one, so validation fails
`invalid` on `kind`. The vector's second step sends the same input with the
private kind `x-review-ping`, which is valid ([§4.2](04-messages.md#s4.2)). The
vector is tagged `structural`, so `send-input.schema.json` refuses the first
input too ([Appendix D](appendix-d-json-schemas.md#sD)).

**Mail held for a work item.** `core.send.task-held-without-live-session`

```json vector=core.send.task-held-without-live-session
{
  "to": ["task:t-4a8cce"],
  "kind": "message",
  "body": "hi"
}
```

The work item `t-4a8cce` has no live session, and `human:wyat` sends. The send
succeeds and is not downgraded. The message starts its own thread, and its one
delivery, to `task:t-4a8cce`, is `direct`, `held` and bound to no session
([§6.1](06-delivery.md#s6.1)). The only hook call is `published`.

**Mail pushed to a live session.**
`core.send.direct-mail-pushes-to-the-live-session`

```json vector=core.send.direct-mail-pushes-to-the-live-session
{
  "to": ["task:t-4a8cce"],
  "kind": "message",
  "body": "hi"
}
```

This time `t-4a8cce` has the live session `run:r-9f2c01`. The delivery is
`direct` and `pushed`, bound to `run:r-9f2c01`, and the host calls `published`
and then `push` for that session ([§6.2](06-delivery.md#s6.2)).

**Held mail at session start.**
`core.session-start.claims-held-mail-for-the-work-item`

```json vector=core.session-start.claims-held-mail-for-the-work-item
{
  "to": ["task:t-000002"],
  "kind": "message",
  "body": "direct"
}
```

The session `run:r-000001` sends this message to the work item `t-000002`, which
has no live session, and then a notice to `channel:auth`, whose member
`t-000002` is. Both wait `held`. When the session `run:r-000002` of `t-000002`
starts and the host delivers its held mail ([§6.4](06-delivery.md#s6.4)), the
direct message is `pushed` and the channel notice `notified`, both bound to
`run:r-000002`.

**A question and its answer.**
`core.answers.a-reply-answers-and-closes-the-question`

```json vector=core.answers.a-reply-answers-and-closes-the-question
{
  "to": ["human:wyat"],
  "kind": "question",
  "body": "which?",
  "blocking": true,
  "choices": ["a", "b"]
}
```

The session `run:r-000001` asks `human:wyat` this blocking question, and the
human replies with the choice `a` and a blank body. The reply is an answer in
the question's thread, addressed to the asker and pushed to its session. The
question's delivery to the human moves to `answered`, no blocking question stays
open, and no gate effect runs ([§4.7](04-messages.md#s4.7)).

**A gate and its effect.**
`core.answers.a-gate-effect-runs-before-the-answer-is-published`

```json vector=core.answers.a-gate-effect-runs-before-the-answer-is-published
{
  "to": ["human:wyat"],
  "kind": "question",
  "body": "Run Bash?",
  "blocking": true,
  "choices": ["approve", "approve-session", "deny"],
  "data": {
    "type": "tool-approval",
    "requestId": "req-1",
    "runId": "r-000001",
    "tool": "Bash",
    "input": {},
    "floor": false
  }
}
```

A `dispatch` vector. The system raises this `tool-approval` gate to
`human:wyat`, who approves it. The hook calls are `published` and `notifyHuman`
for the gate, then `onAnswered` for the gate and its answer, and only then
`published` for the answer; the gate's effect is recorded as applied
([§5.5](05-gates.md#s5.5)).

**A close.** `core.close.answers-without-effect-or-deliveries`

```json vector=core.close.answers-without-effect-or-deliveries
{
  "to": ["human:wyat"],
  "kind": "question",
  "blocking": true,
  "choices": ["approve", "deny"],
  "body": "wake t-000002?",
  "data": {
    "type": "wake",
    "target": "task:t-000002",
    "message": "m-elsewhere"
  }
}
```

The system raises this `wake` gate, and the host then closes it with the reason
`the run ended`. The close is an answer from the system with data
`{ "type": "x-closed", "reason": "the run ended" }`. It has no delivery and
applies no effect, and the gate's delivery moves to `answered`. A second close
fails `conflict` on `replyTo` ([§4.8](04-messages.md#s4.8)).

**A wake the policy asks about.**
`core.wake.ask-raises-a-wake-gate-to-the-owner`

```json vector=core.wake.ask-raises-a-wake-gate-to-the-owner
{
  "to": ["task:t-000003"],
  "kind": "message",
  "body": "please look\nmore",
  "wake": "request"
}
```

The session `run:r-000001` sends this message, with a wake request, to the work
item `t-000003`, which has no live session, and the wake policy rules `ask` for
`task:t-000003`. The message waits `held`, and the system raises a blocking
question to the owner `human:wyat`, with the choices `approve` and `deny`, data
`{ "type": "wake", "target": "task:t-000003", "message": "$s1" }` and a ref to
the held message ([§6.5](06-delivery.md#s6.5)). It is the only open blocking
question.

**The urgent quota.** `core.guardrails.urgent-over-the-quota-is-downgraded`

```json vector=core.guardrails.urgent-over-the-quota-is-downgraded
{
  "to": ["task:t-000002"],
  "kind": "notice",
  "body": "x",
  "urgent": true
}
```

With an urgent quota of 2 an hour, the session `run:r-000001` sends this urgent
notice three times. The first two stay urgent; the third is stored without
`urgent`, and its send result says `downgraded: true`
([§6.6](06-delivery.md#s6.6)).

**A mailbox.** `core.mailbox.inbox-lists-and-mark-read-reads`

```json vector=core.mailbox.inbox-lists-and-mark-read-reads
{
  "to": ["agent:wyat/claude-code.macbook"],
  "kind": "message",
  "body": "hello"
}
```

`human:wyat` sends this message to the agent `agent:wyat/claude-code.macbook`,
whose delivery waits `held` in its mailbox. The agent's inbox lists it; marking
it read moves the delivery to `read`, after which the inbox of `held` mail is
empty and the inbox of `read` mail lists it
([§7.1](07-mailboxes-and-channels.md#s7.1)).

**Implicit members.** `core.channels.implicit-members-are-notified`

```json vector=core.channels.implicit-members-are-notified
{
  "to": ["channel:eng/web"],
  "kind": "notice",
  "body": "api changed"
}
```

A `MAY` vector with the capability `implicit-members`. The channel `eng/web` has
the implicit members `t-000001` and `t-000002`, both with live sessions, and the
session `run:r-000001` of `t-000001` sends this notice to it. Only `t-000002`
gets a delivery: through the channel, `notified`, in `run:r-000002`
([§3.6](03-addresses.md#s3.6)).

**Recovery replays an effect.** `core.recover.replays-an-unapplied-gate-effect`

```json vector=core.recover.replays-an-unapplied-gate-effect
{
  "to": ["human:wyat"],
  "kind": "question",
  "blocking": true,
  "choices": ["approve", "deny"],
  "body": "wake task:t-000002?",
  "data": {
    "type": "wake",
    "target": "task:t-000002",
    "message": "m-elsewhere"
  }
}
```

Every gate effect fails at first. The system raises this `wake` gate and
`human:wyat` approves it: the answer is committed and published, and its effect
is left unrecorded. Once effects work again, recovery applies the effect again
and records it, reporting one replayed gate; a second recovery replays nothing
([§6.3](06-delivery.md#s6.3)).

**A push in the Dispatch profile.** `core.render.dispatch-push-format`

```json vector=core.render.dispatch-push-format
{
  "to": ["task:t-4a8cce"],
  "kind": "question",
  "body": "Did you change the API shape?\nsecond line",
  "refs": [
    {
      "type": "file",
      "id": "src/api.ts",
      "at": "abc123"
    }
  ],
  "urgent": true,
  "blocking": true,
  "choices": ["yes", "no"]
}
```

A `dispatch` vector. `human:wyat` sends this urgent, blocking question to
`t-4a8cce`, and the host renders its push as exactly this text
([Appendix C](appendix-c-dispatch-profile.md#sC.6)):

```text
[message from human:wyat · question · urgent · $s1]
│ Did you change the API shape?
│ second line
choices: yes | no
refs: file:src/api.ts@abc123
The sender is waiting. Answer with msg_reply(messageId: "$s1").
```
