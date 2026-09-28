# 0 Front matter

| Item           | Value                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| Title          | Dispatch Messaging Protocol (DMP)                                                     |
| This version   | the version in this copy's URL, `https://dispatch.foo/protocol/<version>/`            |
| Latest version | `https://dispatch.foo/protocol/`                                                      |
| Source         | `packages/protocol-spec/spec/` in the repository `https://github.com/wsoule/dispatch` |
| Editor         | Wyat Soule                                                                            |
| License        | Apache-2.0, for this text and its registries, schemas, test vectors and runner        |

## 0.1 Abstract

DMP is an addressable, persistent message bus for humans and agents. Every
person, agent, unit of work, running session and channel has an address. A
message is stored once and gets one delivery per recipient, which waits in the
recipient's mailbox until a session of that recipient can take it. Channels
reach many recipients at once, and humans take part as peers of agents.
Questions can carry gates, which ask a deciding principal to approve an action
before the host applies it, and a gate of a type a host does not know fails
closed. Messages are presented to models so that no message body can pass for
text the host wrote. A binding carries DMP messages over
[A2A](https://a2a-protocol.org), so agents that speak A2A can take part. A
language-neutral kit of test vectors and a runner check an implementation's
conformance claims.

## 0.2 Status of this document

This is a draft of DMP 1.0.0. It may change without notice until 1.0.0.

Every released version, drafts included, is frozen at its own URL,
`https://dispatch.foo/protocol/<version>/`, and never changes there. The alias
`https://dispatch.foo/protocol/` names the latest release, or the latest draft
before 1.0.0 exists. An implementation that claims conformance names the version
it was measured against ([§12.7](12-conformance.md#s12.7)).

Sections 1 to 14 are normative except where a section or paragraph says it is
informative. The appendices are informative; Appendix C is also the rule set a
Dispatch-profile claim is measured against ([§12.3](12-conformance.md#s12.3)).

Proposed changes follow [§14.2](14-versioning.md#s14.2). A security flaw in the
protocol is reported privately, never in a public issue
([§14.3](14-versioning.md#s14.3)).

## 0.3 Changes since the last draft

`1.0.0-draft.1` is the first draft. The changelog lists every change by release,
each tagged with its type ([§14.2](14-versioning.md#s14.2)) and naming the
vectors that pin it:
`https://github.com/wsoule/dispatch/blob/main/packages/protocol-spec/CHANGELOG.md`.
