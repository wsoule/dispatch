# 13 Security and privacy considerations

This section collects the rules that protect principals from each other. Each
subsection states its keyword and the vector class that tests it; the ones no
vector tests are listed in [§12.5](12-conformance.md#s12.5).

## 13.1 The system address

Only the host's own code sends as the system address. A host MUST NOT let any
principal, binding or receiver present the system address as a message's `from`,
whatever the principal claims and whatever a received message says. Closes,
markers, the voiding of answers and the exemption from participation all trust
the system address, so a forged one would defeat them.

Keyword: MUST. Vectors: `a2a-binding`, which check that an external sender never
maps to the system address; otherwise not tested, since authentication happens
before this document's rules ([§12.5](12-conformance.md#s12.5)).

## 13.2 Deciding principals

Deciding principals are `human:` addresses the host authorized to decide, and
the system address ([§9.2](09-identity-and-authorization.md#s9.2)). A host MUST
refuse a sender that claims to decide from any other address.

Keyword: MUST. Vectors: `host-core`.

## 13.3 Raise and answer authority

Each gate type may be raised only by the senders its `raisedBy` allows
([§5.3](05-gates.md#s5.3)), and answering a gate needs a deciding principal,
whether or not the host knows the gate's type ([§5.4](05-gates.md#s5.4),
[§5.6](05-gates.md#s5.6)). Otherwise an agent could approve its own tool call or
grant itself access.

Keyword: MUST. Vectors: `envelope`, `host-core`.

## 13.4 Effects need a deciding answer

Only an answer from a `human:` address or the system address takes effect. A
host MUST void any other stored answer to a gate and reopen the gate
([§5.7](05-gates.md#s5.7)), so an answer an older build accepted cannot take
effect on a newer one.

Keyword: MUST. Vectors: `host-core`.

## 13.5 Non-participants learn nothing

A non-participant's send, reply or read that names a message by id MUST get the
answer an id that does not exist gets: `not-found` on `replyTo` for a send or
reply ([§4.6](04-messages.md#s4.6)), and the host's absent-id answer for a read
([§9.3](09-identity-and-authorization.md#s9.3)). A principal therefore cannot
probe which messages exist. The A2A binding answers both cases with one error
too ([§8](08-a2a-binding.md#s8)).

Keyword: MUST. Vectors: `host-core` (sends, and the read rule through
`canRead`); a host's read surfaces are not tested.

## 13.6 Reads

Messages, answers and threads are readable by their participants and by deciding
principals ([§9.3](09-identity-and-authorization.md#s9.3)).

Keyword: MUST. Vectors: `host-core`, for the rule itself through `canRead`.

## 13.7 Identifier entropy

Message and delivery ids SHOULD carry at least 80 random bits per millisecond of
creation time. Within one millisecond an implementation may instead increment
the previous id, as ULID's monotonic form does. With
[§13.5](13-security-and-privacy.md#s13.5), a guessed id discloses nothing even
when it exists.

Keyword: SHOULD. Not tested.

## 13.8 Retention and deletion

A host MUST document how long it keeps messages and deliveries, and SHOULD let
principals delete them where its audit duties allow. The Dispatch profile keeps
them for the life of a project's local run state and offers no deletion in 1.0
([Appendix C](appendix-c-dispatch-profile.md#sC.5)).

Keyword: MUST (documentation), SHOULD (deletion). Not tested.

## 13.9 Egress through bindings

Gate data never leaves a host through a binding ([§5.8](05-gates.md#s5.8)). Each
binding MUST state what else it exports. For A2A, the export rules of
[§8](08-a2a-binding.md#s8) are normative; for federation,
[Appendix F](appendix-f-federation.md#sF) states them for information.

Keyword: MUST. Vectors: `a2a-binding`; another binding brings its own
([§12.5](12-conformance.md#s12.5)).

## 13.10 Logging

A host's logs MUST NOT record bearer tokens, and SHOULD NOT record message
bodies or gate data.

Keyword: MUST, SHOULD NOT. Not tested.

## 13.11 Gate payloads as references

Gate data SHOULD carry references (ids, anchors) to what is being decided, not
its content, so that the content stays where its own access rules apply. The
Dispatch profile's `tool-approval` gate carries a preview of a tool's input of
at most 8 KiB by design ([Appendix C](appendix-c-dispatch-profile.md#sC.3)).

Keyword: SHOULD. Not tested.

## 13.12 Injection-safe presentation

A host MUST present every message it puts into a model's context, in whatever
form, so that no body line passes for a header or a host line, and so that a
model can tell an external sender's message from a local one. A push quotes the
body's lines with `quotePrefix`, and every line of an external sender's message
after its header; a digest MUST carry at most the body's first line, after the
host's own text on one line, so no body text starts a line; and a structured
read escapes every line break inside its string values and marks external
senders ([§6.8](06-delivery.md#s6.8)).

Keyword: MUST. Vectors: `host-core` for pushes and digests (structural),
`dispatch` profile (exact text). Reads are not tested: how each read surface
presents messages is listed in [§12.5](12-conformance.md#s12.5).

## 13.13 Size limits

The envelope limits ([§4.5](04-messages.md#s4.5)) and the address limits
([§3.2](03-addresses.md#s3.2)) bound what one send can store or push, for every
host, binding and receiver.

Keyword: MUST. Vectors: `envelope`.

## 13.14 System markers

A close and the system markers mean something only when the system address sent
them. A host MUST honor `x-closed` as a close, and `x-breaker` as the breaker's
flag, only from the system address; from any other sender they are private data
([§4.8](04-messages.md#s4.8), [§6.6](06-delivery.md#s6.6)).

Keyword: MUST. Vectors: `host-core`.

## 13.15 Idempotency scope

Idempotency keys are scoped per sender, so one sender cannot replay, or learn
of, another's message by guessing its key, and a sender whose authorization was
revoked gets no replay ([§4.9](04-messages.md#s4.9)).

Keyword: MUST. Vectors: `host-core`.

## 13.16 Local identity

On one machine, any process that runs as the same operating system user can
usually read the host's credential files, so there identity gives attribution
and consent, not a security boundary. It becomes a boundary when messages cross
a network, where a binding authenticates each peer
([§9.1](09-identity-and-authorization.md#s9.1)).

Informative. Not tested.
