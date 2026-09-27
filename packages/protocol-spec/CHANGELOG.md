# Changelog

All notable changes to the Dispatch Messaging Protocol. Entries are tagged
`[editorial]`, `[clarification]`, `[additive]` or `[breaking]` and name their
vector ids (see §14.2).

## Unreleased

- [editorial] The core text: §0-7, §9-14.
- [breaking] Gate data travels only on questions and handoffs, and a gate of a
  type the host does not implement is refused; a stored gate of an unknown type
  is decide-only, and an agent's question with unknown data stays plain (C1).
  Vectors: `core.gates.unregistered-type-refused`,
  `core.gates.gate-data-on-a-notice-refused`,
  `core.gates.an-unimplemented-registered-type-is-refused`,
  `core.gates.unknown-stored-gate-is-decide-only`,
  `core.gates.agent-question-with-free-data-stays-plain`,
  `core.gates.choiceless-gate-takes-a-choiceless-answer`,
  `core.gates.recover-leaves-an-unknown-gate-unapplied`.
- [breaking] Only an answer from a deciding human or the system takes effect;
  recovery voids any other answer to a gate, reopens the gate and tells the
  owner (C2). Vectors: `core.gates.an-agent-answer-is-voided-on-recover`,
  `core.gates.voiding-tells-the-owner`.
- [breaking] An address is at most 256 bytes, and each handle, operator, id and
  channel segment in it at most 64 (C3). Vectors:
  `env.caps.handles-and-segments-are-at-most-64-bytes`,
  `env.caps.an-address-is-at-most-256-bytes`.
- [breaking] Only a `human:` address or the system address may decide, and each
  gate type's `raisedBy` says who may raise it (C5). Vectors:
  `core.gates.only-humans-and-the-system-decide`,
  `core.gates.wake-is-raised-only-by-the-system`.
- [breaking] A reply to a message the sender does not take part in fails
  `not-found`, exactly as a reply to an absent id or an empty `replyTo`, before
  the input is validated; the reply shorthand authorizes its sender before it
  looks up the target; the read rule is tested through `canRead` (C6). Vectors:
  `core.participation.absent-and-foreign-look-alike`,
  `core.participation.a-bystander-session-cannot-reply`,
  `core.participation.comes-before-validation`,
  `core.participation.an-empty-reply-to-names-no-message`,
  `core.participation.a-reply-authorizes-before-its-target`,
  `core.read.can-read-participants`, `core.read.can-read-not-bystanders`,
  `core.read.can-read-any-as-a-deciding-principal`,
  `core.read.can-read-no-absent-id`.
- [additive] A ref received from another host keeps a type the host does not
  know, when the type is an identifier (C7). Vectors:
  `core.refs.received-unknown-type-is-kept`,
  `core.refs.local-unknown-type-is-refused`,
  `core.refs.a-received-type-is-an-identifier`.
- [breaking] A channel is never a channel's member: a join of one is refused and
  a stored one is skipped (C8). Vectors:
  `core.channels.a-channel-cannot-join-a-channel`,
  `core.channels.a-stored-channel-member-is-skipped`.
- [additive] A sender's idempotency key replays its first send, per sender and
  never for a revoked sender. Vectors:
  `core.idempotency.replays-the-first-message`,
  `core.idempotency.keys-are-per-sender`,
  `core.idempotency.a-key-is-one-line-of-at-most-200-bytes`,
  `core.idempotency.a-revoked-sender-gets-no-replay`,
  `core.idempotency.a-retried-answer-replays`.
- [additive] System markers mean something only from the system address, and a
  push from an external sender quotes every line after its header. Vectors:
  `core.markers.close-is-honored-only-from-the-system`,
  `core.render.an-external-sender-is-quoted-throughout`.
