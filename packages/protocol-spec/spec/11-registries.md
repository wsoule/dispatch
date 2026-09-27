# 11 Registries

This section is generated from `registries/registries.json` by
`scripts/registries.ts`; edit the JSON, not this file. Registration policy is in
11.11.

## 11.1 Address schemes

| Value     | Scope | Status      | Since         | Defined in                     | Vectors |
| --------- | ----- | ----------- | ------------- | ------------------------------ | ------- |
| `human`   | core  | provisional | 1.0.0-draft.1 | [§3.4](03-addresses.md#s3.4)   | none    |
| `agent`   | core  | provisional | 1.0.0-draft.1 | [§3.4](03-addresses.md#s3.4)   | none    |
| `task`    | core  | provisional | 1.0.0-draft.1 | [§3.4](03-addresses.md#s3.4)   | none    |
| `run`     | core  | provisional | 1.0.0-draft.1 | [§3.4](03-addresses.md#s3.4)   | none    |
| `channel` | core  | provisional | 1.0.0-draft.1 | [§3.4](03-addresses.md#s3.4)   | none    |
| `a2a`     | a2a   | provisional | 1.0.0-draft.1 | [§8.9](08-a2a-binding.md#s8.9) | none    |

## 11.2 Address characters

| Value | Scope      | Status   | Since         | Defined in                   | Vectors |
| ----- | ---------- | -------- | ------------- | ---------------------------- | ------- |
| `@`   | federation | reserved | 1.0.0-draft.1 | [§3.3](03-addresses.md#s3.3) | none    |

## 11.3 Envelope fields

| Value            | Scope      | Status      | Since         | Defined in                            | Vectors |
| ---------------- | ---------- | ----------- | ------------- | ------------------------------------- | ------- |
| `id`             | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `thread`         | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `replyTo`        | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `from`           | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `session`        | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `to`             | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `kind`           | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `body`           | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `refs`           | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `data`           | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `urgent`         | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `blocking`       | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `choices`        | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `choice`         | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `wake`           | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `createdAt`      | core       | provisional | 1.0.0-draft.1 | [§4.1](04-messages.md#s4.1)           | none    |
| `idempotencyKey` | core       | provisional | 1.0.0-draft.1 | [§4.9](04-messages.md#s4.9)           | none    |
| `origin`         | federation | appendix    | 1.0.0-draft.1 | [§F.4](appendix-f-federation.md#sF.4) | none    |
| `hlc`            | federation | appendix    | 1.0.0-draft.1 | [§F.4](appendix-f-federation.md#sF.4) | none    |

## 11.4 Kinds

| Value      | Scope | Status      | Since         | Defined in                  | Vectors |
| ---------- | ----- | ----------- | ------------- | --------------------------- | ------- |
| `message`  | core  | provisional | 1.0.0-draft.1 | [§4.2](04-messages.md#s4.2) | none    |
| `question` | core  | provisional | 1.0.0-draft.1 | [§4.2](04-messages.md#s4.2) | none    |
| `answer`   | core  | provisional | 1.0.0-draft.1 | [§4.2](04-messages.md#s4.2) | none    |
| `handoff`  | core  | provisional | 1.0.0-draft.1 | [§4.2](04-messages.md#s4.2) | none    |
| `notice`   | core  | provisional | 1.0.0-draft.1 | [§4.2](04-messages.md#s4.2) | none    |

## 11.5 Ref types

| Value     | Scope | Status      | Since         | Defined in                  | Vectors |
| --------- | ----- | ----------- | ------------- | --------------------------- | ------- |
| `task`    | core  | provisional | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | none    |
| `run`     | core  | provisional | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | none    |
| `file`    | core  | provisional | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | none    |
| `commit`  | core  | provisional | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | none    |
| `message` | core  | provisional | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | none    |
| `doc`     | docs  | provisional | 1.0.0-draft.1 | [§4.3](04-messages.md#s4.3) | none    |

## 11.6 Gate types

| Value                | Scope    | Status      | Since         | Defined in                                  | Raised by         | Choices                        | Effect                                              | Vectors |
| -------------------- | -------- | ----------- | ------------- | ------------------------------------------- | ----------------- | ------------------------------ | --------------------------------------------------- | ------- |
| `wake`               | core     | provisional | 1.0.0-draft.1 | [§5.9](05-gates.md#s5.9)                    | system            | approve, deny                  | wake the target unless it no longer qualifies (5.9) | none    |
| `tool-approval`      | dispatch | provisional | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | system            | approve, approve-session, deny | release or refuse the parked tool call (C.3)        | none    |
| `scope`              | dispatch | provisional | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | session           | grant, deny                    | widen the session's writes (C.3)                    | none    |
| `agent-registration` | dispatch | provisional | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | system            | approve, deny                  | approve or refuse the agent (C.3)                   | none    |
| `overseer-action`    | dispatch | provisional | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | system            | confirm, cancel                | run or drop the overseer's action (C.3)             | none    |
| `memory`             | memory   | provisional | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | system-or-decider | approve, reject                | apply or reject the memory proposal (C.3)           | none    |
| `task-proposal`      | a2a      | provisional | 1.0.0-draft.1 | [§8.6](08-a2a-binding.md#s8.6)              | system            | approve, decline               | promote or drop the drafted work item (8.6)         | none    |
| `doc`                | docs     | provisional | 1.0.0-draft.1 | [§C.3](appendix-c-dispatch-profile.md#sC.3) | system            | approve, reject                | apply or reject the document change (C.3)           | none    |

## 11.7 System markers

| Value       | Scope | Status      | Since         | Defined in                  | Vectors |
| ----------- | ----- | ----------- | ------------- | --------------------------- | ------- |
| `x-closed`  | core  | provisional | 1.0.0-draft.1 | [§4.8](04-messages.md#s4.8) | none    |
| `x-breaker` | core  | provisional | 1.0.0-draft.1 | [§6.6](06-delivery.md#s6.6) | none    |

## 11.8 Delivery states

| Value       | Scope      | Status      | Since         | Defined in                            | Internal | Vectors |
| ----------- | ---------- | ----------- | ------------- | ------------------------------------- | -------- | ------- |
| `held`      | core       | provisional | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | no       | none    |
| `sending`   | core       | provisional | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | yes      | none    |
| `pushed`    | core       | provisional | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | no       | none    |
| `notified`  | core       | provisional | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | no       | none    |
| `read`      | core       | provisional | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | no       | none    |
| `answered`  | core       | provisional | 1.0.0-draft.1 | [§6.1](06-delivery.md#s6.1)           | no       | none    |
| `forwarded` | federation | appendix    | 1.0.0-draft.1 | [§F.4](appendix-f-federation.md#sF.4) | no       | none    |

## 11.9 Error codes

| Value         | Scope  | Status      | Since         | Defined in                  | HTTP status | Vectors |
| ------------- | ------ | ----------- | ------------- | --------------------------- | ----------- | ------- |
| `invalid`     | core   | provisional | 1.0.0-draft.1 | [§10.1](10-errors.md#s10.1) | 400         | none    |
| `forbidden`   | core   | provisional | 1.0.0-draft.1 | [§10.1](10-errors.md#s10.1) | 403         | none    |
| `not-found`   | core   | provisional | 1.0.0-draft.1 | [§10.1](10-errors.md#s10.1) | 404         | none    |
| `conflict`    | core   | provisional | 1.0.0-draft.1 | [§10.1](10-errors.md#s10.1) | 409         | none    |
| `limited`     | core   | provisional | 1.0.0-draft.1 | [§10.1](10-errors.md#s10.1) | 429         | none    |
| `unavailable` | memory | informative | 1.0.0-draft.1 | [§10.3](10-errors.md#s10.3) | 503         | none    |

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
