# 2 Terminology

The terms below are used throughout this document with these meanings.

## 2.1 Hosts and principals

**Host.** An implementation of this document that stores messages and their
deliveries and delivers them for one set of addresses. Dispatch runs one host
per project. The logic of [§3](03-addresses.md#s3) to
[§7](07-mailboxes-and-channels.md#s7) may live in a library the host embeds; the
rules apply to the host either way.

A host knows or does the following. DMP states each as an obligation; how a host
meets it is its own business.

| The host                        | Meaning                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| knows a work item's session     | for a work item, its live session, if it has one ([§2.2](02-terminology.md#s2.2))                                                                                     |
| knows whether a session is live | whether a session can take input now                                                                                                                                  |
| knows a session's work item     | the work item a session stands for, or none for an auxiliary session                                                                                                  |
| pushes                          | puts a rendered message into a live session's context before its next turn ([§6.2](06-delivery.md#s6.2), [§6.8](06-delivery.md#s6.8))                                 |
| notifies a session              | gives a live session a one-line digest of a message                                                                                                                   |
| notifies a human                | tells a human that a message arrived                                                                                                                                  |
| wakes                           | starts or continues a session for a work item or session, for a message ([§6.5](06-delivery.md#s6.5))                                                                 |
| decides wake policy             | rules `allow`, `ask` or `deny` on waking a target for a message                                                                                                       |
| names an owner                  | the human to ask or tell about a target ([§2.3](02-terminology.md#s2.3))                                                                                              |
| computes implicit members       | members of a channel that the host computes when a message is sent ([§3.6](03-addresses.md#s3.6))                                                                     |
| applies gate effects            | runs the effect of an answered gate of a type it implements, idempotently ([§5.5](05-gates.md#s5.5))                                                                  |
| keeps time                      | the current time, for timestamps and guardrail windows                                                                                                                |
| declares its gate types         | the gate types it implements, which always include `wake` ([§5.6](05-gates.md#s5.6))                                                                                  |
| classifies external addresses   | optional: whether an address is reached through a binding, as a `client` or a `peer`, and whether to deliver to it, skip it or refuse it ([§8](08-a2a-binding.md#s8)) |

**Principal.** An authenticated sender: a human, an agent, a session, or the
host itself as the system address ([§2.3](02-terminology.md#s2.3)). A principal
sends as one address and either may or may not decide
([§9](09-identity-and-authorization.md#s9)).

**Human** and **agent.** The principals behind `human:` and `agent:` addresses
([§3.4](03-addresses.md#s3.4)). An agent here is a registered install of an AI
agent that runs outside the host's sessions; its registration is `pending`,
`approved` or `revoked`, and only an approved agent sends. A human or an agent
is an **actor**.

**External.** An address the host reaches through a binding, such as an A2A
client or peer ([§8](08-a2a-binding.md#s8)). Its messages are presented and
checked by stricter rules ([§5.8](05-gates.md#s5.8),
[§6.8](06-delivery.md#s6.8)).

## 2.2 Work items and sessions

**Work item.** A unit of work that outlives any one session, addressed as
`task:<id>`. Mail to a work item reaches its live session, or waits for its next
one.

**Session.** One execution of an agent, such as a model conversation working on
a work item, addressed as `run:<id>`. A session is **live** while it can take
input.

A session stands for at most one work item. A session that stands for none is
**auxiliary** (Dispatch's review and verify sessions): it never receives mail
addressed to a work item and is reachable only as `run:<id>`.

A session **acts for** itself, for its work item, and for that work item's other
sessions. An auxiliary session acts only for itself.

## 2.3 Deciding principals and the system address

**System address.** One agent address that a host announces as its own identity.
Only the host's own code sends as it
([§13.1](13-security-and-privacy.md#s13.1)). It sends gates, notices, closes and
markers, and it never receives a delivery. Dispatch's system address is
`agent:dispatch` ([Appendix C](appendix-c-dispatch-profile.md#sC.2)).

**Deciding principal.** A `human:` address that the host authorized to decide,
or the system address. No other address decides
([§9.2](09-identity-and-authorization.md#s9.2)).

**Owner.** The human a host names for a target: it is asked whether to wake the
target, and told when agents are stopped from looping in a thread or when an
answer to a gate is set aside. Each host chooses its owners; Dispatch names the
project owner.

**Participant.** Of a message: its sender, or a recipient of one of its
deliveries, where a session also counts for every address it acts for and for
every delivery bound to it ([§4.6](04-messages.md#s4.6)).

## 2.4 Mailboxes and deliveries

**Message.** One envelope ([§4.1](04-messages.md#s4.1)), stored once however
many recipients it has.

**Thread.** A message that replies to nothing, and every message that replies,
directly or through other replies, to it. A thread is named by the id of its
first message.

**Delivery.** One recipient's record of one message: the recipient, the route
that reached it (`direct` or `channel`), its state ([§6.1](06-delivery.md#s6.1))
and the session it is bound to, if any.

**Mailbox.** The deliveries of one address. Its `held` deliveries wait for the
recipient ([§7.1](07-mailboxes-and-channels.md#s7.1)).

**Channel.** A named group of work items and actors
([§7.2](07-mailboxes-and-channels.md#s7.2)). A message to a channel reaches its
members; the channel itself never receives a delivery.

**Push**, **notify** and **hold** are the three ways a delivery reaches, or
waits for, its recipient ([§6.2](06-delivery.md#s6.2)).

## 2.5 Gates, gate data and markers

**Gate data.** A message's `data` when it is a JSON object whose `type` member
is a string that does not start with `x-`. The definition does not depend on the
message's kind.

**Gate.** A question or handoff with gate data whose type the host knows, or
whose sender is the system address or a `human:` address
([§5.6](05-gates.md#s5.6)). Any other question or handoff with gate data is a
plain one. A gate's **gate type** is `data.type`. A gate asks a deciding
principal to choose, and the host applies the gate's **effect** when one does
([§5](05-gates.md#s5)). Each gate type is registered with who may raise it, its
choices, its data and its effect ([§11.6](11-registries.md#s11.6)).

**Private data.** `data` whose `type` starts with `x-`. A host never interprets
private data, except a marker from the system address.

**Marker.** Private data whose `type` is a registered system marker, `x-closed`
or `x-breaker` ([§11.7](11-registries.md#s11.7)). A marker means something only
when the system address sent it ([§13.14](13-security-and-privacy.md#s13.14)).

**Notice.** A message of kind `notice`: information that expects no reply. The
system address sends notices to tell a sender or an owner what happened.

**Close.** An answer from the system address that settles a question without
applying any effect ([§4.8](04-messages.md#s4.8)).
