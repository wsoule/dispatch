# 6 Delivery

Each resolved recipient of a message gets one delivery
([§3.5](03-addresses.md#s3.5)). A delivery has an id, the message, the
recipient, the route that reached it (`direct` or `channel`), a state, the
session it is bound to (or null), and the time it last changed.

## 6.1 States

| State      | Meaning                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `held`     | waiting in the recipient's mailbox; bound to no session                                                                        |
| `sending`  | bound to a live session while the host pushes or notifies it; internal, and a host MAY hide it from its API                    |
| `pushed`   | put into the bound session's context ([§6.2](06-delivery.md#s6.2))                                                             |
| `notified` | a digest was given to the bound session, or, for a human, the host's notifier was called                                       |
| `read`     | the recipient marked it read ([§7.1](07-mailboxes-and-channels.md#s7.1)), or its sender is muted ([§6.7](06-delivery.md#s6.7)) |
| `answered` | its message is a question or handoff, and that question has an answer or was closed                                            |

A host MUST NOT expose a state this table does not list, except a state of an
appendix it implements ([§11.8](11-registries.md#s11.8)). Adding a state a host
exposes is a major change ([§14.1](14-versioning.md#s14.1)).

**Initial state.** A delivery starts as follows (pinned rule 3):

| Recipient                                                                            | Initial state and session                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| any recipient, when the sender is muted                                              | `read`, no session                                                                                    |
| `human:`                                                                             | `notified`, no session                                                                                |
| `agent:`                                                                             | `held`, no session                                                                                    |
| `task:` with a live session                                                          | `sending`, bound to that session                                                                      |
| `task:` without one                                                                  | `held`, no session                                                                                    |
| `run:` that is live                                                                  | `sending`, bound to it                                                                                |
| `run:` that is not live, reached through a channel                                   | no delivery                                                                                           |
| `run:` that is not live, being replied to                                            | `held`, no session ([§4.6](04-messages.md#s4.6))                                                      |
| `run:` that is not live, named in a `wake: "request"` message from a `human:` sender | `held`, no session; the host is then asked to wake exactly that session ([§6.5](06-delivery.md#s6.5)) |
| any other `run:` that is not live                                                    | the send fails `invalid` on the caller's `to[i]`                                                      |

The last row covers a wake request from an agent or a session, and a human's
message that does not request a wake. A session is "being replied to" when it is
the sender of the reply's target and [§4.6](04-messages.md#s4.6) did not rewrite
it. A channel is never a recipient: it expands to its members, and it is never a
member ([§7.3](07-mailboxes-and-channels.md#s7.3)).

**Transitions.** A delivery changes state only as follows:

- `sending` to `pushed` or `notified` when the hook returns, or to `held`,
  unbound, when it throws ([§6.2](06-delivery.md#s6.2)) or when recovery finds
  its session gone ([§6.3](06-delivery.md#s6.3));
- `held` to `sending`, bound, at session start ([§6.4](06-delivery.md#s6.4));
- any state but `answered` to `read` when the recipient marks it read;
- any state to `answered` when its question is answered or closed;
- `answered` to `notified`, `held` or `sending` when a voided answer reopens a
  gate ([§5.7](05-gates.md#s5.7)).

## 6.2 Mode selection

Once a message and its deliveries are committed ([§6.3](06-delivery.md#s6.3)),
the host dispatches each delivery:

- A `sending` delivery is **pushed** into its session, and becomes `pushed`,
  when its route is `direct` or the message is `urgent`. Otherwise the session
  is **notified** with a digest, and the delivery becomes `notified`. A push
  reaches the session before its next turn; a digest is a single line.
- When the push or notify fails, the delivery returns to `held` and is unbound,
  so it waits for the recipient's next session.
- A `notified` delivery to a human calls the host's notifier. A failing notifier
  never fails the send; the message is stored and readable.

(pinned rule 4)

## 6.3 Outbox and recovery

A host MUST commit a message and all of its deliveries in one transaction before
it runs any hook for them (push, notify, wake, a gate's effect): the store is an
outbox. Every change of a delivery's state MUST apply only if the delivery is
still in the state the change expects: when two changes race, the one that finds
the delivery already moved does nothing, and the newer state stays.

A host MUST run **recovery** when it starts, before it accepts sends, and MAY
run it at other times. Recovery:

1. dispatches again every `sending` delivery whose bound session is live
   ([§6.2](06-delivery.md#s6.2));
2. returns every other `sending` delivery to `held`, unbound;
3. for every answered gate of a type the host knows whose effect is not recorded
   as applied, and whose answer is not a close: applies the effect again and
   records it ([§5.5](05-gates.md#s5.5)) when the answer is from a `human:`
   address or the system address, and otherwise voids the answer and reopens the
   gate ([§5.7](05-gates.md#s5.7)).

So a crash between commit and hook never loses a message or a decision. (pinned
rule 10)

## 6.4 Session start

When a session of a work item starts, the host MUST claim every `held` delivery
addressed to that work item, and every `held` delivery addressed to one of the
work item's earlier sessions: each is bound to the new session as `sending` and
dispatched as [§6.2](06-delivery.md#s6.2) says (a direct delivery pushed, a
channel one notified unless its message is urgent). Mail left on an ended
session therefore reaches the work item's next session. Deliveries in any other
state are not claimed. (pinned rule 11)

## 6.5 Wake policy

A message with `wake: "request"` asks the host to wake recipients that are not
live, so its mail is seen soon. After dispatching such a message
([§6.2](06-delivery.md#s6.2)), the host considers each of its deliveries that is
then `held` and addressed to a work item, and, when the sender is a `human:`
address, each that is then `held` and addressed to a session. For each, the host
asks its wake policy about exactly that recipient address (`decide`, with the
target and the message), and:

- on `allow`, asks to wake exactly that target (`wake`, with the target and the
  message; a session address for a session). When the wake fails, the message
  stays held, and the host SHOULD send the sender a notice saying why;
- on `deny`, leaves the message held, and SHOULD send the sender a notice;
- on `ask`, raises a `wake` gate from the system address to the owner of the
  target ([§5.9](05-gates.md#s5.9)).

A failing wake, a failing policy and a failing notice never fail the send: the
message is already committed. A notice to a sender that is an ended session goes
to its work item, as a reply would ([§4.6](04-messages.md#s4.6)). Which targets
a host allows, asks about or denies is its own policy; the Dispatch profile's is
in [Appendix C](appendix-c-dispatch-profile.md#sC.8). (pinned rule 9)

## 6.6 Guardrails

A host MUST enforce two guardrails whose numbers are its configuration (the
Dispatch profile's defaults are in
[Appendix C](appendix-c-dispatch-profile.md#sC.7)):

- **The urgent quota.** When a sender that is an agent or a session sends an
  `urgent` message, and its `urgent` messages created in the past hour already
  number at least the quota, the host MUST drop `urgent` from the new message
  and report the downgrade in the send's result (`downgraded: true`). Humans and
  the system address have no quota. (pinned rule 13)
- **The breaker.** Agent-authored messages are those from sessions and agents,
  never from the system address. When an agent-authored send replies into a
  thread whose agent-authored messages created in the past hour number at least
  the limit, the host MUST refuse it as `limited` on `replyTo`. The host SHOULD
  then send the owner of the sender one notice per window, from the system
  address, replying to the target, with `data`
  `{ "type": "x-breaker", "thread": <thread id> }`; it sends none while the
  thread already has an `x-breaker` notice from the system address created in
  the past hour. A human who replies in the thread is not limited. (pinned
  rule 12)

The past hour is the hour ending at the host's current time; a message counts
when its `createdAt` is at or after the start of that hour.

## 6.7 Muted senders

A host MAY let a human mute an agent. The deliveries of a message from a muted
sender MUST start as `read` ([§6.1](06-delivery.md#s6.1)): the message is stored
and readable in its thread, but never pushed, notified or claimed at session
start. Vectors that test muting are `MAY` vectors with the capability
`muted-senders` ([§12.2](12-conformance.md#s12.2)).

## 6.8 Presenting messages to models

A host MUST present every message it puts into a model's context, in whatever
form (a push, a digest, or what a read of a mailbox or thread returns
([§7.1](07-mailboxes-and-channels.md#s7.1))), so that no line of its body can
pass for a header or for a line the host writes, and so that every line after
the header of an external sender's message ([§2.1](02-terminology.md#s2.1)) is
quoted. A host that pushes a message into a model's context MUST do so with
`quotePrefix`: it writes the text of the body only on lines that start with
`quotePrefix`, at least one such line for each line of the body, so no line of
the body forms or starts the header or a host line. A host that notifies a
session ([§6.2](06-delivery.md#s6.2)) MUST give it a digest instead: the host's
own text followed by at most the first line of the body, on one line, so the
text of the body never starts a line. The host declares the forms of its pushes
([§12.4](12-conformance.md#s12.4)); `header` and `hostLines` are patterns,
searched in a line as [§1.4](01-introduction.md#s1.4) says:

- `header`: a pattern that the first line of a pushed message matches;
- `quotePrefix`: the prefix that starts every line carrying body text;
- `hostLines`: patterns for the lines the host adds after the body, such as the
  message replied to, the choices, the choice, the refs and a prompt to answer.

For a pushed message whose sender is external ([§2.1](02-terminology.md#s2.1)),
every line after the header MUST start with `quotePrefix`, including the host
lines, because an external sender's choices and refs are its text too.

The host's own text may repeat a body by chance: an answer whose body is
`approve` also carries the choice `approve`. So the `render` vectors
([§12.4.6](12-conformance.md#s12.4.6)) test these requirements on bodies whose
lines occur in no text the host writes for the message, such as a header naming
another sender, where a line that contains a line of the body can only be
carrying it. Splitting the rendered text and such a body into lines at every
line break of [§1.4](01-introduction.md#s1.4), a pushed message MUST meet all of
these:

1. its first line matches `header` and contains no line of the body;
2. every later line that contains a line of the body starts with `quotePrefix`;
3. at least as many later lines start with `quotePrefix` as the body has lines;
4. every other later line matches one of `hostLines` and contains no line of the
   body.

Blank lines of the body are left out of rules 1, 2 and 4 and of the digest rule,
since every line would contain them. On a body whose lines occur in no text the
host writes, a digest MUST be one line that does not start with body text: it
MUST NOT start with the longest leading part of the body's first line that it
contains (the whole line, or what a host that cuts the line short keeps), and
each later line of the body that it contains MUST be contained in the body's
first line. The Dispatch profile's exact forms are in
[Appendix C](appendix-c-dispatch-profile.md#sC.6).
