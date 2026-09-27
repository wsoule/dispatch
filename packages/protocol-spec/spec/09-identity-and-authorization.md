# 9 Identity and authorization

## 9.1 Principals

A host authenticates every principal before this document's rules apply to what
it sends; how it does so (tokens, operating system users, a binding's own
authentication) is out of scope. The result is a sender: one address, and
whether it may decide ([§9.2](09-identity-and-authorization.md#s9.2)).

- A **human** sends as its `human:` address.
- An **agent** sends as its `agent:` address. A host MUST refuse a send from an
  agent that has no `approved` registration (it has none, or it is `pending` or
  `revoked`), as `forbidden` on `from`. Every session of one agent install
  shares the install's address; `session` records which one sent
  ([§4.1](04-messages.md#s4.1)).
- A **session** sends as its `run:` address, and acts for its work item and that
  work item's other sessions ([§2.2](02-terminology.md#s2.2)).
- The **system address** is the host itself. Only the host's own code sends as
  it ([§13.1](13-security-and-privacy.md#s13.1)).

A work item and a channel never send. An address a host authenticates is
attribution: it says who sent a message. Whether it is also a security boundary
depends on the deployment ([§13.16](13-security-and-privacy.md#s13.16)).

## 9.2 Deciding principals

A sender that may decide is a **deciding principal**. A host MUST refuse, as
`forbidden` on `from`, a sender that claims to decide from an address that is
neither a `human:` address nor the system address. The system address always
decides. Which humans decide is the host's policy; the Dispatch profile lets a
team member decide at the `decide` tier
([Appendix A](appendix-a-daemon-api.md#sA.1)).

A deciding principal may answer gates ([§5.4](05-gates.md#s5.4)), raise gate
types whose `raisedBy` is `system-or-decider` ([§5.3](05-gates.md#s5.3)), reply
in any thread without participating ([§4.6](04-messages.md#s4.6)), and read any
message ([§9.3](09-identity-and-authorization.md#s9.3)). No other principal can
approve anything through a gate, including its own tool calls, wake-ups or
registration.

## 9.3 Reads

A principal may read a message when it is the system address, a deciding
principal, or a participant of the message ([§4.6](04-messages.md#s4.6)). A
message that does not exist is readable by no one. A thread is readable when any
of its messages is, and then all of it is.

Every surface through which a host lets a principal read messages, their
answers, their deliveries or threads (an HTTP API, a WebSocket stream, a user
interface, an agent's tools) MUST apply this rule, and MUST answer a principal
that may not read a message exactly as it answers for a message that does not
exist ([§13.5](13-security-and-privacy.md#s13.5)). The kit tests the rule
itself, through the `canRead` step ([§12.4](12-conformance.md#s12.4)), but not
each surface ([§12.5](12-conformance.md#s12.5)).
