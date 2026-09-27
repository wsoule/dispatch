# 11 Registries

This section is generated from `registries/registries.json` by
`scripts/registries.ts`; edit the JSON, not this file. Registration policy is in
11.11.

## 11.1 Address schemes

| Value     | Scope | Status      | Since         | Defined in                     | Vectors                                                                                      |
| --------- | ----- | ----------- | ------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `human`   | core  | permanent   | 1.0.0-draft.1 | [§3.4](03-addresses.md#s3.4)   | `env.address.parses-each-scheme`, `env.address.refuses-an-operator-on-a-human`               |
| `agent`   | core  | permanent   | 1.0.0-draft.1 | [§3.4](03-addresses.md#s3.4)   | `env.address.parses-each-scheme`, `env.address.parses-an-agent-without-an-operator`          |
| `task`    | core  | permanent   | 1.0.0-draft.1 | [§3.4](03-addresses.md#s3.4)   | `env.address.parses-each-scheme`, `env.address.refuses-an-id-outside-the-identifier-grammar` |
| `run`     | core  | permanent   | 1.0.0-draft.1 | [§3.4](03-addresses.md#s3.4)   | `env.address.parses-each-scheme`                                                             |
| `channel` | core  | permanent   | 1.0.0-draft.1 | [§3.4](03-addresses.md#s3.4)   | `env.address.parses-each-scheme`, `env.address.refuses-an-empty-channel-segment`             |
| `a2a`     | a2a   | provisional | 1.0.0-draft.1 | [§8.9](08-a2a-binding.md#s8.9) | none                                                                                         |

## 11.2 Address characters

| Value | Scope      | Status   | Since         | Defined in                   | Vectors                                    |
| ----- | ---------- | -------- | ------------- | ---------------------------- | ------------------------------------------ |
| `@`   | federation | reserved | 1.0.0-draft.1 | [§3.3](03-addresses.md#s3.3) | `env.address.refuses-the-reserved-at-sign` |

## 11.3 Envelope fields

| Value            | Scope      | Status    | Since         | Defined in                            | Vectors                                                                                                 |
| ---------------- | ---------- | --------- | ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`             | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `core.render.body-lines-never-pass-for-a-header`, `core.render.dispatch-push-format`                    |
| `thread`         | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `core.render.body-lines-never-pass-for-a-header`                                                        |
| `replyTo`        | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `env.envelope.an-answer-needs-reply-to`, `env.envelope.a-reply-to-no-message-is-not-found`              |
| `from`           | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `core.render.body-lines-never-pass-for-a-header`, `env.envelope.only-sessions-raise-scope-gates`        |
| `session`        | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `env.envelope.a-session-is-at-most-200-bytes`                                                           |
| `to`             | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `env.envelope.to-is-a-non-empty-list`, `env.envelope.names-the-bad-recipient-index`                     |
| `kind`           | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `env.envelope.unknown-kind-refused-x-kind-accepted`                                                     |
| `body`           | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `env.envelope.body-is-required-unless-an-answer-chooses`, `env.envelope.body-is-at-most-64-kib`         |
| `refs`           | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `env.envelope.a-local-ref-type-must-be-registered`, `env.envelope.refs-hold-at-most-50-entries`         |
| `data`           | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `env.envelope.data-is-at-most-64-kib-as-jcs`                                                            |
| `urgent`         | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `core.render.body-lines-never-pass-for-a-header`, `core.render.dispatch-push-format`                    |
| `blocking`       | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `env.envelope.blocking-only-on-questions-and-handoffs`                                                  |
| `choices`        | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `env.envelope.choices-only-on-questions-and-handoffs`, `env.envelope.choices-are-distinct`              |
| `choice`         | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `env.envelope.a-choice-must-be-one-of-the-questions`, `env.envelope.a-gate-answer-must-choose`          |
| `wake`           | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `core.render.body-lines-never-pass-for-a-header`                                                        |
| `createdAt`      | core       | permanent | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | `core.render.body-lines-never-pass-for-a-header`                                                        |
| `idempotencyKey` | core       | permanent | 1.0.0-draft.1 | [§4.9](04-messages.md#s4.9)           | `core.idempotency.replays-the-first-message`, `core.idempotency.a-key-is-one-line-of-at-most-200-bytes` |
| `origin`         | federation | appendix  | 1.0.0-draft.1 | [§F.4](appendix-f-federation.md#sF.4) | none                                                                                                    |
| `hlc`            | federation | appendix  | 1.0.0-draft.1 | [§F.4](appendix-f-federation.md#sF.4) | none                                                                                                    |

## 11.4 Kinds

| Value      | Scope | Status    | Since         | Defined in                  | Vectors                                                                                             |
| ---------- | ----- | --------- | ------------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `message`  | core  | permanent | 1.0.0-draft.1 | [§4.2](04-messages.md#s4.2) | `env.envelope.accepts-a-plain-message`                                                              |
| `question` | core  | permanent | 1.0.0-draft.1 | [§4.2](04-messages.md#s4.2) | `env.envelope.blocking-only-on-questions-and-handoffs`                                              |
| `answer`   | core  | permanent | 1.0.0-draft.1 | [§4.2](04-messages.md#s4.2) | `env.envelope.an-answer-needs-reply-to`                                                             |
| `handoff`  | core  | permanent | 1.0.0-draft.1 | [§4.2](04-messages.md#s4.2) | `env.envelope.blocking-only-on-questions-and-handoffs`, `env.envelope.a-handoff-answer-must-choose` |
| `notice`   | core  | permanent | 1.0.0-draft.1 | [§4.2](04-messages.md#s4.2) | `env.envelope.choices-only-on-questions-and-handoffs`                                               |

## 11.5 Ref types

| Value     | Scope | Status      | Since         | Defined in                  | Vectors                                            |
| --------- | ----- | ----------- | ------------- | --------------------------- | -------------------------------------------------- |
| `task`    | core  | permanent   | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | `env.envelope.a-local-ref-type-must-be-registered` |
| `run`     | core  | permanent   | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | `env.envelope.a-local-ref-type-must-be-registered` |
| `file`    | core  | permanent   | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | `env.envelope.a-local-ref-type-must-be-registered` |
| `commit`  | core  | permanent   | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | `env.envelope.a-local-ref-type-must-be-registered` |
| `message` | core  | permanent   | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | `env.envelope.a-local-ref-type-must-be-registered` |
| `doc`     | docs  | provisional | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | none                                               |

## 11.6 Gate types

| Value                | Scope    | Status      | Since         | Defined in                                  | Raised by         | Choices                        | Effect                                              | Vectors                                                                                                                   |
| -------------------- | -------- | ----------- | ------------- | ------------------------------------------- | ----------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `wake`               | core     | permanent   | 1.0.0-draft.1 | [§5.9](05-gates.md#s5.9)                    | system            | approve, deny                  | wake the target unless it no longer qualifies (5.9) | `core.wake.approve-applies-before-publishing`, `core.wake.ask-raises-a-wake-gate-to-the-owner`                            |
| `tool-approval`      | dispatch | permanent   | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | system            | approve, approve-session, deny | release or refuse the parked tool call (C.3)        | `env.envelope.agents-may-not-forge-tool-approval-gates`, `core.answers.a-gate-effect-runs-before-the-answer-is-published` |
| `scope`              | dispatch | permanent   | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | session           | grant, deny                    | widen the session's writes (C.3)                    | `env.envelope.only-sessions-raise-scope-gates`, `env.envelope.scope-gates-have-a-fixed-shape`                             |
| `agent-registration` | dispatch | permanent   | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | system            | approve, deny                  | approve or refuse the agent (C.3)                   | `core.answers.a-human-decides-an-agent-registration-gate`                                                                 |
| `overseer-action`    | dispatch | permanent   | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | system            | confirm, cancel                | run or drop the overseer's action (C.3)             | `core.answers.a-human-decides-an-overseer-action-gate`                                                                    |
| `memory`             | memory   | provisional | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | system-or-decider | approve, reject                | apply or reject the memory proposal (C.3)           | none                                                                                                                      |
| `task-proposal`      | a2a      | provisional | 1.0.0-draft.1 | [§8.6](08-a2a-binding.md#s8.6)              | system            | approve, decline               | promote or drop the drafted work item (8.6)         | none                                                                                                                      |
| `doc`                | docs     | provisional | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | system            | approve, reject                | apply or reject the document change (C.3)           | none                                                                                                                      |

## 11.7 System markers

| Value       | Scope | Status    | Since         | Defined in                  | Vectors                                                                                                                                              |
| ----------- | ----- | --------- | ------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-closed`  | core  | permanent | 1.0.0-draft.1 | [§4.8](04-messages.md#s4.8) | `core.close.answers-without-effect-or-deliveries`, `core.close.moves-the-question-to-answered`, `core.markers.close-is-honored-only-from-the-system` |
| `x-breaker` | core  | permanent | 1.0.0-draft.1 | [§6.6](06-delivery.md#s6.6) | `core.guardrails.breaker-tells-the-owner-once-per-window`                                                                                            |

## 11.8 Delivery states

| Value       | Scope      | Status    | Since         | Defined in                            | Internal | Vectors                                                                                                     |
| ----------- | ---------- | --------- | ------------- | ------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `held`      | core       | permanent | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | no       | `core.send.task-held-without-live-session`, `core.recover.returns-sending-rows-to-held`                     |
| `sending`   | core       | permanent | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | yes      | `core.recover.dispatches-sending-rows-whose-session-is-live`, `core.recover.returns-sending-rows-to-held`   |
| `pushed`    | core       | permanent | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | no       | `core.send.direct-mail-pushes-to-the-live-session`, `core.session-start.claims-held-mail-for-the-work-item` |
| `notified`  | core       | permanent | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | no       | `core.send.human-mail-is-notified`, `core.send.channel-mail-notifies-the-live-session`                      |
| `read`      | core       | permanent | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | no       | `core.mailbox.inbox-lists-and-mark-read-reads`, `core.mailbox.marking-read-leaves-answered-alone`           |
| `answered`  | core       | permanent | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | no       | `core.answers.a-reply-answers-and-closes-the-question`, `core.close.moves-the-question-to-answered`         |
| `forwarded` | federation | appendix  | 1.0.0-draft.1 | [§F.4](appendix-f-federation.md#sF.4) | no       | none                                                                                                        |
| `refused`   | federation | appendix  | 1.0.0-draft.1 | [§F.4](appendix-f-federation.md#sF.4) | no       | none                                                                                                        |

## 11.9 Error codes

| Value         | Scope  | Status      | Since         | Defined in                  | HTTP status | Vectors                                                                                               |
| ------------- | ------ | ----------- | ------------- | --------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `invalid`     | core   | permanent   | 1.0.0-draft.1 | [§10.1](10-errors.md#s10.1) | 400         | `env.envelope.unknown-kind-refused-x-kind-accepted`                                                   |
| `forbidden`   | core   | permanent   | 1.0.0-draft.1 | [§10.1](10-errors.md#s10.1) | 403         | `env.envelope.a-gate-answer-needs-a-deciding-principal`                                               |
| `not-found`   | core   | permanent   | 1.0.0-draft.1 | [§10.1](10-errors.md#s10.1) | 404         | `env.envelope.a-reply-to-no-message-is-not-found`, `core.participation.absent-and-foreign-look-alike` |
| `conflict`    | core   | permanent   | 1.0.0-draft.1 | [§10.1](10-errors.md#s10.1) | 409         | `core.answers.a-question-takes-one-answer`, `core.close.an-answered-question-conflicts`               |
| `limited`     | core   | permanent   | 1.0.0-draft.1 | [§10.1](10-errors.md#s10.1) | 429         | `core.guardrails.breaker-refuses-the-next-agent-turn`                                                 |
| `unavailable` | memory | informative | 1.0.0-draft.1 | [§10.3](10-errors.md#s10.3) | 503         | none                                                                                                  |

## 11.10 Extension URIs

| Value                                      | Scope | Status      | Since         | Defined in                     | Vectors |
| ------------------------------------------ | ----- | ----------- | ------------- | ------------------------------ | ------- |
| `https://dispatch.foo/a2a/ext/envelope/v1` | a2a   | provisional | 1.0.0-draft.1 | [§8.4](08-a2a-binding.md#s8.4) | none    |
| `https://dispatch.foo/a2a/ext/gate/v1`     | a2a   | provisional | 1.0.0-draft.1 | [§8.5](08-a2a-binding.md#s8.5) | none    |
| `https://dispatch.foo/a2a/ext/work/v1`     | a2a   | provisional | 1.0.0-draft.1 | [§8.6](08-a2a-binding.md#s8.6) | none    |

## 11.11 Registration policy

Every entry has a `value`; a `scope` (`core`, `dispatch`, `a2a`, `memory`,
`docs` or `federation`); a `status`; the version it appeared in (`since`); the
`section` that defines it; for a non-core entry, a `reference` to the public
document that defines it; and the ids of its `vectors`. Gate types add who may
raise them, their choices, their data and their effect; delivery states add
whether a host MAY hide them from its external API; error codes add an HTTP
status.

An entry has one of five statuses:

- **permanent**: normative, with at least one vector. An entry becomes permanent
  only in the change that adds its vectors.
- **provisional**: specified, with or without an implementation, and no vectors
  yet. A stable release lists its provisional entries in a separate table marked
  "not part of this version"; they become permanent in a later minor version. A
  receiver meets them through its unknown-value rule (5.6 for gate types, 4.4
  for ref types).
- **appendix**: defined by an informative appendix (Appendix F). A host that
  does not implement the appendix MUST NOT emit it and MUST ignore it on input.
  It becomes permanent when its appendix becomes normative.
- **informative**: listed so implementers recognize it; raised by hosts or
  bindings, never by the engine; no vector.
- **reserved**: held for a stated use. A host MUST NOT use it; its only vectors
  check that it is refused.

New entries follow Specification Required: a public document plus at least one
vector, and the editor's approval. Names starting `x-` are private use and are
never registered, except the two system markers, which keep the `x-` spelling
because stored messages carry it.

Drift rule: for each registry whose values an engine exports (address schemes,
kinds, ref types, gate types, system markers, delivery states and error codes),
every permanent entry is in the export, and every exported value has a permanent
or provisional entry. A value already listed as provisional may be implemented
without a registry change; any other new value needs a provisional entry in the
same change.
