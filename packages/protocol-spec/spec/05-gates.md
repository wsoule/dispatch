# 5 Gates

A gate is a question or handoff that asks a deciding principal to approve
something the host will then do: release a parked tool call, wake a work item,
apply a proposed change. The choice is data, the effect is the host's, and every
rule below exists so that only a deciding principal's choice ever takes effect.

## 5.1 Gate data

A message has **gate data** when its `data` is a JSON object whose `type` member
is a string that does not start with `x-`, whatever the message's kind. A
message is a **gate** when it is a `question` or `handoff` with gate data, and
the host knows `data.type` or the sender is the system address or a `human:`
address ([§5.6](05-gates.md#s5.6)); its gate type is `data.type`. A question or
handoff with gate data of an unknown type from an agent or a session is not a
gate; locality ([§5.8](05-gates.md#s5.8)) still applies to it, since it tests
for gate data alone.

Each gate type is registered ([§11.6](11-registries.md#s11.6)) with:

- who may raise it (`raisedBy`, [§5.3](05-gates.md#s5.3));
- its choices, which a gate of that type offers as its `choices`;
- the members of its data besides `type`;
- its effect ([§5.5](05-gates.md#s5.5)).

Core defines one gate type, `wake` ([§5.9](05-gates.md#s5.9)). The Dispatch
profile's types are described in
[Appendix C](appendix-c-dispatch-profile.md#sC.3); other entries name the public
document that defines them. `data` whose `type` starts with `x-` is private data
or a marker, never gate data, so a sender that wants to attach its own payload
to any message uses an `x-` type.

## 5.2 Deciding principals

Only a deciding principal decides: a `human:` address the host authorized to
decide, or the system address ([§9.2](09-identity-and-authorization.md#s9.2)). A
deciding principal may answer a gate ([§5.4](05-gates.md#s5.4)), raise a gate
type whose `raisedBy` is `system-or-decider` ([§5.3](05-gates.md#s5.3)), reply
in a thread it does not participate in ([§4.6](04-messages.md#s4.6)), and read
any message ([§9.3](09-identity-and-authorization.md#s9.3)). An answer takes
effect only when it comes from a deciding principal, which a stored answer shows
by its `from` being a `human:` address or the system address
([§5.7](05-gates.md#s5.7)).

## 5.3 Raising a gate

A host MUST refuse, as `invalid` on `data.type`, a send whose input has gate
data when its kind is neither `question` nor `handoff`, or when its `data.type`
is not a gate type the host implements ([§5.6](05-gates.md#s5.6)), whoever sends
it. Private payloads use an `x-` type instead.

A host MUST refuse, as `forbidden` on `data`, a gate that the type's `raisedBy`
does not let the sender raise:

| `raisedBy`          | Who may raise the gate                      |
| ------------------- | ------------------------------------------- |
| `system`            | only the system address                     |
| `system-or-decider` | the system address, or a deciding principal |
| `session`           | only a session                              |

A gate type the registry does not list is raised by the system only. A host also
checks each gate of a type it implements against that type's definition: a
`session` type fixes the whole shape of its gate (kind, `blocking`, `choices`
and data), and a gate in another shape, or with bad data, fails `invalid` on
`data` or on the member at fault, such as `data.paths`. (pinned rule 16;
vectors: `core.gates.unregistered-type-refused`,
`core.gates.gate-data-on-a-notice-refused`,
`core.gates.an-unimplemented-registered-type-is-refused`,
`core.gates.wake-is-raised-only-by-the-system`,
`env.envelope.only-sessions-raise-scope-gates`,
`env.envelope.agents-may-not-forge-tool-approval-gates`,
`env.envelope.scope-gates-have-a-fixed-shape`,
`env.envelope.a-scope-gate-names-a-path`)

## 5.4 Answering a gate

An answer to a gate MUST come from a deciding principal; any other sender's
answer fails `forbidden` on `replyTo`. This holds for a stored gate of a type
the host does not implement, as [§5.6](05-gates.md#s5.6) says. The answer
carries one of the gate's choices, or none when the gate has none
([§4.7](04-messages.md#s4.7)). A close ([§4.8](04-messages.md#s4.8)) settles a
gate without deciding it: it is an answer from the system that applies no
effect.

## 5.5 Effects

When a deciding principal answers a gate of a type the host implements, and the
answer is not a close, the host MUST apply the gate's effect in this order:

1. commit the answer, with the question's deliveries moved to `answered`, in one
   transaction;
2. apply the effect, and wait for it to finish;
3. record the effect as applied;
4. only then publish the answer to readers and dispatch its deliveries.

So no one hears of an answer before its effect has been attempted. When the
effect fails, the answer stays committed, is published and dispatched, and the
effect is left unrecorded for recovery to apply again
([§6.3](06-delivery.md#s6.3)). An effect may therefore run more than once for
one answer, and a host MUST make every effect idempotent. Only answers from a
`human:` address or the system address take effect ([§5.7](05-gates.md#s5.7)).
(pinned rule 7; vectors: `core.wake.approve-applies-before-publishing`,
`core.answers.a-gate-effect-runs-before-the-answer-is-published`,
`core.answers.a-failing-effect-still-commits-the-answer`,
`core.recover.replays-an-unapplied-gate-effect`)

## 5.6 Unknown types fail closed

A host's **known gate types** are the types it implements, which it declares
([§2.1](02-terminology.md#s2.1)). Core requires `wake`; the Dispatch profile
requires its own types too ([§12.1](12-conformance.md#s12.1)). A type the
registry lists is not known to a host that does not implement it.

- **At send**, a host refuses gate data on a kind other than `question` and
  `handoff`, and a `data.type` that is not a gate type it knows
  ([§5.3](05-gates.md#s5.3)), even from a sender whose message would not be a
  gate.
- **A stored gate of an unknown type**, written by another build or version of
  the host, stays a gate when its sender is the system address or a `human:`
  address, since those could have raised it. Only a deciding principal may
  answer it ([§5.4](05-gates.md#s5.4)), and the choice rule of
  [§4.7](04-messages.md#s4.7) applies to it. A question with gate data of an
  unknown type from an agent or a session could not have been raised as a gate,
  so it is not one ([§5.1](05-gates.md#s5.1)) and stays a plain question.
- **No effect.** A host MUST NOT apply an effect for a type it does not know,
  and MUST NOT record such a gate as applied, so a host that does know the type
  applies it on its next recovery ([§6.3](06-delivery.md#s6.3)), subject to
  [§5.7](05-gates.md#s5.7).
- **Locality** ([§5.8](05-gates.md#s5.8)) does not depend on the type: it tests
  for gate data, known or not.

A later minor version can therefore add a gate type
([§14.1](14-versioning.md#s14.1)): a host of an earlier version refuses to raise
it and lets only deciding principals answer it.

## 5.7 Ignored answers

An answer to a gate whose `from` is neither a `human:` address nor the system
address never takes effect. The send rules of [§5.4](05-gates.md#s5.4) refuse
such an answer, so a host meets one only when an older build stored it, or when
some path skipped validation. When a host finds one, at send or at recovery, it
MUST, in one transaction, void the answer and reopen the gate:

- the answer's kind becomes `message`, and the host records it as voided, so the
  gate can take another answer;
- each of the gate's deliveries leaves `answered` for the state
  [§6.1](06-delivery.md#s6.1) would give it now (a human `notified`, a live
  session or a work item with a live session `sending`, any other recipient
  `held`), and is dispatched ([§6.2](06-delivery.md#s6.2)).

The host then publishes the voided message and the reopened deliveries. It
SHOULD send the owner of the voided answer's sender a notice, replying to the
gate, saying that the answer was set aside because only deciding principals
answer gates, and that the gate is open again. The gate stays answerable by its
original id, so a host's handler that finds a gate by its id or its data still
finds it.

## 5.8 Locality

Gate data never leaves the host through a binding. A binding MUST NOT export a
message that has gate data, or that replies to a message that has gate data,
whatever its kind and whether or not the host knows the type; it may say that a
gate exists, as [§8.5](08-a2a-binding.md#s8.5) does, but never carry its message
or its data. A host MUST refuse, as `forbidden` on `data`, a send in which the
message, or the message it replies to, has gate data while any resolved
recipient is external ([§2.1](02-terminology.md#s2.1)), before anything is
stored. Each binding states what else it exports
([§13.9](13-security-and-privacy.md#s13.9)); for A2A that is
[§8](08-a2a-binding.md#s8).

## 5.9 The wake gate

The system address raises a `wake` gate when a host's wake policy answers `ask`
([§6.5](06-delivery.md#s6.5)).

| Item    | Value                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| Kind    | `question`, `blocking: true`                                                                                 |
| From    | the system address; `raisedBy` is `system`                                                                   |
| To      | the owner of the target                                                                                      |
| Choices | `approve`, `deny`                                                                                            |
| Data    | `{ "type": "wake", "target": <address>, "message": <message id> }`: the target to wake, and the held message |
| Refs    | a `message` ref to the held message                                                                          |
| Body    | names the sender and the target and quotes the held message's first line; the wording is not normative       |

**Effect.** On `approve`, the host wakes the target for the message
([§6.5](06-delivery.md#s6.5)), unless the target no longer qualifies: a work
item that has a live session able to take its mail needs no wake, and a target
the host's wake policy would now deny (a work item that has finished, say) is
not woken. On `deny`, the message stays held. Either way the effect is recorded
as applied. When the target is not woken, or waking it fails, the host SHOULD
send the held message's sender a notice saying why.
