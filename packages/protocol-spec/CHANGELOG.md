# Changelog

All notable changes to the Dispatch Messaging Protocol. Entries are tagged
`[editorial]`, `[clarification]`, `[additive]` or `[breaking]` and name their
vector ids (see §14.2).

## Unreleased

- [additive] The `task-proposal` gate type is permanent: only the system address
  raises it, only a deciding principal answers it, and its answer chooses
  `approve` or `decline` (§8.6, App. C.3). Vectors:
  `core.gates.task-proposal-is-raised-only-by-the-system`,
  `core.gates.task-proposal-needs-a-deciding-answer`,
  `core.gates.task-proposal-is-answered-with-approve-or-decline`,
  `a2a.projection.row-8-a-handoff-waits-on-its-proposal`.
- [additive] The `work/v1` extension is permanent, with the task-state rows for
  handoffs: a request's limits, a write's repository rule, and rows 2, 4, 6, 8,
  9 and 10 for a handoff (§8.6, §8.7). Vectors:
  `a2a.work-ext.accepts-a-handoff-with-every-field`,
  `a2a.work-ext.accepts-a-status-request`,
  `a2a.work-ext.refuses-an-unknown-skill`,
  `a2a.work-ext.refuses-a-handoff-without-a-title`,
  `a2a.work-ext.refuses-a-title-over-200-bytes`,
  `a2a.work-ext.refuses-a-multi-line-title`,
  `a2a.work-ext.refuses-more-than-20-acceptance-criteria`,
  `a2a.work-ext.refuses-a-criterion-over-500-bytes`,
  `a2a.work-ext.refuses-a-multi-line-criterion`,
  `a2a.work-ext.refuses-more-than-50-writes`,
  `a2a.work-ext.refuses-a-write-outside-the-repository`,
  `a2a.work-ext.refuses-a-write-over-512-bytes`,
  `a2a.work-ext.refuses-an-unknown-priority`,
  `a2a.work-ext.refuses-more-than-10-labels`,
  `a2a.work-ext.refuses-a-request-that-is-not-an-object`,
  `a2a.projection.row-2-a-declined-handoff`,
  `a2a.projection.row-2-a-handoff-dropped-by-the-owner`,
  `a2a.projection.row-4-a-deleted-handoff`,
  `a2a.projection.row-6-a-landed-handoff`,
  `a2a.projection.row-8-a-handoff-waits-on-its-proposal`,
  `a2a.projection.row-9-a-working-handoff`,
  `a2a.projection.row-9-a-handoff-in-review-has-a-stage`,
  `a2a.projection.row-9-a-status-of-the-hosts-own`,
  `a2a.projection.row-10-an-approved-draft-is-submitted`,
  `a2a.projection.row-10-needs-approval`.
- [additive] The `memory` gate type is permanent: only the system address
  raises it, never a human, a session or an agent; its shape is fixed, naming a
  proposal and never its text; and only a deciding principal answers it
  (App. C.3). Vectors: `core.gates.memory-is-raised-only-by-the-system`,
  `core.gates.memory-is-refused-from-a-session-or-an-agent`,
  `core.gates.memory-needs-a-deciding-answer`,
  `env.envelope.a-memory-gate-names-a-proposal`,
  `env.envelope.a-memory-gate-has-a-project-or-team-scope`,
  `env.envelope.a-memory-gate-names-its-action-and-kind`,
  `env.envelope.memory-gates-have-a-fixed-shape`.
- [editorial] Appendix B lists the `memory_*` tools (§B.3), and Appendix C.4
  says the system's `x-expired` answer also expires a memory proposal.
- [additive] The `doc` ref type is permanent, in the Dispatch profile: a local
  send may ref a document by its id and a section anchor (§4.3, App. C.1).
  Vectors: `core.refs.a-local-doc-ref-is-accepted`.
- [clarification] A vector that needs a profile ref type is a `dispatch` vector
  (§12.3). Vectors: `core.refs.a-local-doc-ref-is-accepted`.
- [additive] The `doc` gate type is permanent: only the system address raises
  it, its shape is fixed, naming a document and its proposed revision and never
  the text, and only a deciding principal answers it (App. C.3). With it, every
  gate type in the registry is permanent, so a Dispatch-profile claim now
  requires the adapter to declare all eight: `wake`, `tool-approval`, `scope`,
  `agent-registration`, `overseer-action`, `task-proposal`, `memory` and `doc`
  (§12.1). Vectors: `core.gates.doc-is-raised-only-by-the-system`,
  `core.gates.doc-needs-a-deciding-answer`,
  `env.envelope.a-doc-gate-names-its-doc-and-proposal`,
  `env.envelope.doc-gates-have-a-fixed-shape`.
- [editorial] Appendix A, complete since draft 1, names memory and documents
  among the daemon routes outside DMP, and no appendix is a stub.
- [clarification] A `scope`, `memory` or `doc` gate fails `invalid` only for
  breaking a rule App. C.3 lists for it; other members of its data are not
  checked. Vectors: `env.envelope.scope-gates-have-a-fixed-shape`,
  `env.envelope.memory-gates-have-a-fixed-shape`,
  `env.envelope.doc-gates-have-a-fixed-shape`.
- [additive] The `a2a` address scheme is permanent, in the A2A binding: an
  `a2a:<alias>` address names an outbound peer by an alias of at most 40
  characters in the handle grammar, and a delivery to a peer, direct or through
  a channel, is held for the host to relay (§3.4, §8.9). No registry entry is
  provisional any more. Vectors: `a2a.peers.parses-an-alias`,
  `a2a.peers.an-alias-is-at-most-40-characters`,
  `a2a.peers.a-delivery-to-a-peer-is-held`.

## 1.0.0-draft.1 (2026-09-28)

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
  push from an external sender quotes every line that carries its text: its
  body, choices, choice and refs, and any text a host line echoes from the
  message it replies to. A host line that carries none of it, such as one naming
  only the id replied to or the prompt to answer, need not be quoted. Vectors:
  `core.markers.close-is-honored-only-from-the-system`,
  `core.render.an-external-sender-is-quoted-throughout`,
  `core.render.an-external-reply-quotes-its-text-not-the-reply-line`,
  `core.render.an-external-question-quotes-its-text-not-the-prompt`,
  `core.render.dispatch-external-push-format`.
- [clarification] §4.6 rewrites an ended session among a reply target's `to`
  addresses as it does the target's sender, and §6.1 refuses a human's wake
  request naming a session that stands for no work item:
  `core.answers.a-reply-to-an-ended-recipient-goes-to-its-work-item`,
  `core.answers.a-reply-to-an-ended-recipient-reaches-the-successor-session`,
  `core.answers.a-reply-naming-an-ended-session-its-target-never-reached-fails`,
  `core.wake.a-humans-wake-to-a-session-of-no-work-item-fails`.
- [additive] The A2A binding (§8) and the `a2a-binding` vector class:
  `envelope/v1` and `gate/v1` are permanent, while `work/v1`, the task-state
  rows for handoffs and the `a2a` scheme stay provisional, with no vectors yet;
  gate data and answers to gates never reach a client, an external sender never
  speaks as the system address, a client reaches only its recipient list, and a
  client's data is wrapped under the `envelope/v1` URI. Vectors:
  `a2a.egress.gate-data-never-reaches-a-client`,
  `a2a.egress.a-gate-with-a-local-recipient-is-refused-whole`,
  `a2a.egress.a-reply-to-a-gate-never-reaches-a-client`,
  `a2a.external.never-speaks-as-the-system`,
  `a2a.external.an-answer-from-a-client-is-never-a-close`,
  `a2a.external.a-client-reaches-only-the-owner`,
  `a2a.external.gate-shaped-data-is-wrapped`,
  `a2a.envelope-ext.refuses-a-bad-recipient`,
  `a2a.projection.row-7-never-a-question-with-gate-data`,
  `a2a.projection.row-8-gate-v1-lists-id-type-and-time`, and every other vector
  under `vectors/a2a-binding/`.
