# 12 Conformance

An implementation conforms to DMP by passing the conformance kit's vectors for a
claim. The kit is a set of JSON test vectors, a runner, `dmp-conformance`, and
an adapter the implementer writes, which runs each vector against the
implementation and reports what happened ([§12.4](12-conformance.md#s12.4)). The
vectors are normative with this text ([§1.4](01-introduction.md#s1.4)).

## 12.1 Claims

| Claim            | Name for the runner | Vectors judged                                                               | Also required                                                                                                                                      |
| ---------------- | ------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envelope         | `envelope`          | the `envelope` class, `core` profile                                         | none                                                                                                                                               |
| Core             | `core`              | the `envelope` and `host-core` classes, `core` profile                       | none                                                                                                                                               |
| Dispatch profile | `dispatch-profile`  | Core's, plus every `dispatch`-profile vector of those classes                | at least one `dispatch`-profile vector ran; the adapter declares every gate type the registry lists as permanent ([§11.6](11-registries.md#s11.6)) |
| A2A binding      | `a2a-binding`       | Core's, plus every `a2a-binding` vector of the `core` profile                | an attested A2A TCK run at the pinned commit whose result is pass and whose only deviations are those of [§8.10](08-a2a-binding.md#s8.10)          |
| Federation       | reserved            | the `federation` class, in the minor version that makes Appendix F normative | two transports implement Appendix F                                                                                                                |

An Envelope claim needs only a validator: its vectors parse addresses and
validate send inputs, and deliver nothing.

**The union rule.** An A2A binding claim made beside a Dispatch-profile claim
also judges the `dispatch`-profile vectors of the `a2a-binding` class. A
Dispatch-profile A2A claim is therefore the union of the two, and a failing
`dispatch`-profile `a2a-binding` vector that is a MUST fails the A2A binding
claim.

**A claim needs vectors.** A claim fails when any class it judges has no vector
that ran (passed or failed), so an empty kit, or an adapter that declares too
little, never passes.

## 12.2 Levels

Every vector carries the BCP 14 keyword of the requirement it tests.

- A **MUST** vector that fails, is skipped, or ends in an adapter error fails
  every claim that judges it. A MUST vector the adapter answers as unsupported
  is skipped, and fails the claim.
- A **SHOULD** vector runs, and its failure is reported (`shouldFailures`)
  without failing the claim. The SHOULD vectors cover the notices a host sends:
  the sender's notice when a wake is denied or fails, the owner's breaker notice
  and the owner's notice about a voided answer. A MUST vector never checks a
  notice that only a SHOULD requires.
- A **MAY** vector names a capability, and runs only when the adapter declares
  it; otherwise it is skipped without failing any claim. The capabilities are
  `implicit-members` ([§3.6](03-addresses.md#s3.6)) and `muted-senders`
  ([§6.7](06-delivery.md#s6.7)).
- A vector that needs a registered gate type the implementation does not
  implement (`$unimplementedGateType`, [§12.4.4](12-conformance.md#s12.4.4)) is
  **not applicable** when there is none left: it neither passes nor fails.

## 12.3 Profiles

A vector's profile is `core` unless it depends on any Dispatch value, which
makes it `dispatch`: the narrowed id grammar
([Appendix C](appendix-c-dispatch-profile.md#sC.1)), `agent:dispatch` as a
literal, the rendering format, the default limits, epic channels, a profile gate
type, a profile marker, or the wording of a notice. `core` vectors use ids valid
under both grammars (`t-4a8cce`, `r-9f2c01`), write the system address as
`$system`, and set limits explicitly, so the reference and any other host run
the same files. Appendix C is the rule set that `dispatch` vectors check.

## 12.4 The kit

The kit ships in the package `@dispatch-foo/protocol-spec`: the vectors under
`vectors/`, the registries, informative JSON Schemas, and the runner. The runner
needs Node 22.13 or later and has no runtime dependency. This section defines
the vector format, the adapter protocol, the reports and the runner. The
expectation `noDeliveries`, the `world` change `agentStatus` and the step
`a2a.inbound` are the format's latest additions.

### 12.4.1 Vector files

A vector file is `vectors/<class>/<area>.json`, holding
`{ "kit": <version>, "class", "area", "vectors": [...] }`. `kit` is the kit
version the file was written for, `class` is its directory, and `area` matches
`[a-z0-9-]+`. A vector has these members, and no others:

| Member       | Meaning                                                                                                                                                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `<prefix>.<topic>.<case>`, matching `[a-z0-9]+(\.[a-z0-9-]+){2}`; the prefix names the class: `env` for `envelope`, `core` for `host-core`, `a2a` for `a2a-binding`, `fed` for `federation`. The topic is free, often the file's area. Unique across the kit, never reused |
| `title`      | one sentence stating what the vector checks                                                                                                                                                                                                                                |
| `class`      | `envelope`, `host-core`, `a2a-binding` or `federation` (reserved: no vectors yet); the same as its file's                                                                                                                                                                  |
| `level`      | `MUST`, `SHOULD` or `MAY` ([§12.2](12-conformance.md#s12.2))                                                                                                                                                                                                               |
| `profile`    | `core` or `dispatch` ([§12.3](12-conformance.md#s12.3))                                                                                                                                                                                                                    |
| `sections`   | the numbered sections of this document it tests; each exists                                                                                                                                                                                                               |
| `capability` | the capability a `MAY` vector needs; only a `MAY` vector has one, and every `MAY` vector does                                                                                                                                                                              |
| `tags`       | optional labels; `structural` marks a refused input whose fault a JSON Schema can express                                                                                                                                                                                  |
| `given`      | the world the adapter scripts its host from ([§12.4.2](12-conformance.md#s12.4.2))                                                                                                                                                                                         |
| `when`       | the steps to run, in order ([§12.4.3](12-conformance.md#s12.4.3))                                                                                                                                                                                                          |
| `then`       | what the runner expects ([§12.4.5](12-conformance.md#s12.4.5)); never sent to the adapter                                                                                                                                                                                  |

A vector retired from the kit moves to `vectors/retired.json`, as
`{ "id", "reason" }`, so a report against an older kit stays readable, and its
id is never used again. The runner refuses a malformed file before any adapter
runs.

### 12.4.2 The world

`given` describes the world at the start of a vector. Each vector starts from an
empty store and a fresh world.

| Member           | Meaning                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clock`          | the host's time at the start, a timestamp; default `2026-09-23T10:00:00.000Z`                                                                                 |
| `seed`           | a number for a deterministic id source; ids are still compared only through symbols ([§12.4.4](12-conformance.md#s12.4.4))                                    |
| `workItems`      | work items, as `{ "id", "liveSession"?, "sessions"? }`: the live session and the earlier sessions, as `run:` addresses                                        |
| `auxSessions`    | live auxiliary sessions, as `run:` addresses                                                                                                                  |
| `agents`         | registered agents, as `{ "address", "status", "muted"? }`, `status` being `pending`, `approved` or `revoked`                                                  |
| `channels`       | channels and their explicit members, as `{ "name", "members" }`                                                                                               |
| `implicit`       | implicit members, as a map from channel name to addresses                                                                                                     |
| `owner`          | the owner the host names for every target                                                                                                                     |
| `rulings`        | the wake policy, as a map from target address to `allow`, `ask` or `deny`; `deny` for any target not listed                                                   |
| `wakeResults`    | what waking a target returns: `{ "ok": true, "session" }` or `{ "ok": false, "reason" }`; success when not listed                                             |
| `failPush`       | sessions whose push and notify fail                                                                                                                           |
| `failOnAnswered` | when true, every gate effect fails                                                                                                                            |
| `limits`         | `urgentPerHour` and `agentTurnsPerThreadPerHour`                                                                                                              |
| `external`       | for `a2a-binding` vectors, a map from address to `client` or `peer` ([§8](08-a2a-binding.md#s8))                                                              |
| `store`          | rows seeded into the store before the first step: `messages` and `deliveries` with literal ids, and `appliedGates`, the ids of gates whose effect is recorded |

Seeded rows stand for state an older build or another host wrote, which a
current send could not produce, such as an agent's answer to a gate.

### 12.4.3 Steps

Each entry of `when` is an object with an `op` and that op's members. A step
that fails fails only itself: later steps still run. Each step's outcome is
`{ "ok": true, "result"? }` or `{ "ok": false, "error": { "code", "field"? } }`
([§10](10-errors.md#s10)).

| Op             | Members                                                                                                      | Result                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `send`         | `as` (`{ "address", "canDecide" }`), `input` (a send input), `origin`?                                       | `{ "message", "downgraded", "replayed"? }`                |
| `reply`        | `as`, `message` (the target), `input` (`body`, `choice`?, `refs`?, `data`?, `session`?)                      | as `send` ([§4.6](04-messages.md#s4.6))                   |
| `close`        | `question`, `reason`                                                                                         | `{ "message" }` ([§4.8](04-messages.md#s4.8))             |
| `markRead`     | `message`, `recipient`: the delivery of that message to that recipient                                       | `{ "state" }`                                             |
| `inbox`        | `recipient`, `states`?                                                                                       | `{ "messages": [ids] }`                                   |
| `thread`       | `thread`                                                                                                     | `{ "messages": [ids] }`                                   |
| `canRead`      | `message`, `as` ([§9.3](09-identity-and-authorization.md#s9.3))                                              | `{ "readable" }`                                          |
| `openBlocking` | none                                                                                                         | `{ "messages": [ids] }`                                   |
| `join`         | `channel`, `member`                                                                                          | `{}`                                                      |
| `leave`        | `channel`, `member`                                                                                          | `{ "removed" }`                                           |
| `deliverHeld`  | `session`, `workItem`: that session of that work item starts ([§6.4](06-delivery.md#s6.4))                   | `{ "deliveries": [{ "message", "recipient", "state" }] }` |
| `recover`      | none ([§6.3](06-delivery.md#s6.3))                                                                           | `{ "retried", "reverted", "replayed", "voided"? }`        |
| `parseAddress` | `input`                                                                                                      | the parsed address ([§3.1](03-addresses.md#s3.1))         |
| `validate`     | `as`, `input`, `replyTarget`? (a message id), `origin`? (`local` or `received`, [§4.4](04-messages.md#s4.4)) | `{}`                                                      |
| `render`       | `message`, `form`? (`push`, the default, or `digest`), `external`?                                           | `{ "text" }` ([§6.8](06-delivery.md#s6.8))                |
| `a2a.validate` | `extension`, `raw`                                                                                           | `{}` ([§8](08-a2a-binding.md#s8))                         |
| `a2a.project`  | `facts`                                                                                                      | `{ "state", "stage"? }` ([§8.7](08-a2a-binding.md#s8.7))  |
| `a2a.inbound`  | `as`, `envelope`, `body`, `parts`?: a message arriving through the A2A binding                               | as `send` ([§8.8](08-a2a-binding.md#s8.8))                |
| `world`        | `change`: exactly one of the changes below                                                                   | no result                                                 |

`validate` runs [§4.5](04-messages.md#s4.5) alone, stores nothing and needs no
delivery. `send`, `reply`, `close` and `a2a.inbound` create a message. A `world`
step changes the world between steps:

| Change           | Value                                                                         |
| ---------------- | ----------------------------------------------------------------------------- |
| `startSession`   | `{ "workItem", "session" }`: the session becomes the work item's live session |
| `endSession`     | `{ "workItem" }`: the work item's live session ends                           |
| `ruling`         | `{ "target", "ruling" }`                                                      |
| `wakeResult`     | `{ "target", "result" }`                                                      |
| `failPush`       | the sessions whose push and notify now fail                                   |
| `failOnAnswered` | whether gate effects now fail                                                 |
| `advanceMs`      | milliseconds to move the clock forward                                        |
| `agentStatus`    | `{ "address", "status" }`: an agent's registration changes                    |

Sessions are always written as `run:` addresses, in `given`, in steps, in
results and in expectations.

### 12.4.4 Symbols

Vectors name messages by role, so an optional message never shifts the name of a
required one:

- `$sN` is the message that step N created (a successful `send`, `reply`,
  `close` or `a2a.inbound`). It may be used only after step N.
- `$gateN` is the N-th question, and `$noticeN` the N-th notice, that the system
  address sent, counted in creation order, skipping messages a step created and
  rows `given.store` seeded.
- `$system` is the system address the adapter declared.
- `$unimplementedGateType` is the first gate type the registry lists as
  permanent or provisional that the adapter did not declare.
- Seeded rows keep their literal ids.

The runner replaces `$system` and `$unimplementedGateType` before a vector
crosses to the adapter; a vector that uses `$unimplementedGateType` when every
listed type is implemented is not applicable. The adapter resolves `$sN`,
`$gateN` and `$noticeN` in a step before running it. Symbols may appear inside
strings, such as an exact rendered text. A delivery is named by its message and
its recipient, never by its id.

### 12.4.5 Expectations

`then` holds any of these members:

| Member            | Checks                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steps`           | per step, `null` (not checked) or the expected outcome. `ok` must match; an error's `code` must match, and its `field` when the vector gives one; a result is matched as a subset. Error text is never compared |
| `messages`        | the named messages exist, once each, in this order relative to each other, with the fields listed; fields not listed are free (so notice bodies stay free)                                                      |
| `noOtherMessages` | when true, no other message exists, except seeded rows, messages the vector names anywhere, and notices from the system address                                                                                 |
| `deliveries`      | for each message the list mentions, its deliveries are exactly the listed recipients, each once, with `via`, `state` and `session` compared where listed                                                        |
| `noDeliveries`    | the listed messages have no deliveries                                                                                                                                                                          |
| `calls`           | the host's hook calls that name a named or seeded message, exactly and in order                                                                                                                                 |
| `callsInclude`    | those calls include the listed ones, in order                                                                                                                                                                   |
| `gateEffects`     | the gates whose effect is recorded as applied, as a set                                                                                                                                                         |
| `voided`          | the answers voided as [§5.7](05-gates.md#s5.7) says, as a set                                                                                                                                                   |
| `channels`        | every channel and its explicit members, as sets                                                                                                                                                                 |
| `render`          | for a `render` step, its exact text (used by `dispatch`-profile vectors)                                                                                                                                        |

The hook calls are `push { session, message }`, `notify { session, message }`,
`notifyHuman { actor, message }`, `wake { target, message }`,
`decide { target, message }`, `onAnswered { question, answer }`,
`published { message }` (the host made the message visible to readers, as it
does for every stored message and every close) and, for `a2a-binding` vectors,
`admitExternal`.

**Always checked.** Whatever `then` says, every message id and every delivery id
is unique and an identifier of at most 64 bytes; generated message ids increase
bytewise in creation order; and in the `dispatch` profile, generated ids are
`m-` or `d-` followed by 26 lowercase Crockford base-32 characters. Seeded rows
keep their literal ids and are exempt from the increase and the Dispatch
grammar.

### 12.4.6 Rendering in Core

A `render` step renders a stored message as the host would push it (or, with
`form: "digest"`, as a digest). Core vectors send bodies whose lines occur in no
text the host writes for the message ([§6.8](06-delivery.md#s6.8)): lines that
imitate a header or a host line without repeating the host's own, every line
break of [§1.4](01-introduction.md#s1.4) and, for external senders, choices and
refs. They then check the rendered text against the forms the adapter declared:
rules 1 to 4 of [§6.8](06-delivery.md#s6.8) and, with `external: true`, that
every line after the header starts with `quotePrefix`. `dispatch`-profile
vectors also compare the exact text.

### 12.4.7 Adapter messages

The runner starts the adapter's command and exchanges JSON lines over its
standard input and output: one JSON object per line. A line ends at LF; a CR
before it is dropped. The runner writes U+2028 and U+2029 as the JSON escapes
`\u2028` and `\u2029`, so an adapter whose line reader also breaks at them still
reads whole lines, and it splits the adapter's output at LF only, so the adapter
may write them raw or escaped. Whatever the adapter writes to its standard error
goes to the runner's log. An implementation that embeds the adapter in its main
program can enter adapter mode with a flag; the kit only needs a command line.

```text
runner  → {"dmp":"hello","kit":"<kit version>"}
adapter ← {"dmp":"hello","implementation":{"name":"…","version":"…"},
           "classes":["envelope","host-core"],"profiles":["core"],
           "capabilities":["implicit-members"],"systemAddress":"agent:…",
           "gateTypes":["wake"],
           "render":{"quotePrefix":"…","header":"…","hostLines":["…"]}}
runner  → {"dmp":"run","vector":{…the vector without then…}}
adapter ← {"dmp":"observation","id":"…","steps":[…],"messages":[…],
           "deliveries":[…],"calls":[…],"gateEffects":[…],"voided":[…],
           "channels":[…],"render":[…]}
       or {"dmp":"unsupported","id":"…","reason":"…"}
runner  → {"dmp":"bye"}                       the adapter exits 0
```

- **Hello.** The adapter declares the classes and profiles it runs, its
  capabilities, its system address, its gate types (which include `wake`,
  [§5.6](05-gates.md#s5.6)) and its render forms (patterns as strings, searched
  in a line as [§1.4](01-introduction.md#s1.4) says). The runner refuses a
  malformed hello.
- **Run.** The adapter builds a host scripted from `given`, so the host's
  synchronous questions (wake policy, owner, implicit members, live sessions)
  never cross the pipe and Core needs no network API. It drives the host's clock
  from `given.clock` and `advanceMs`, and loads seeded rows as given.
- **Observation.** After the last step: `steps`, one outcome per step; every
  message in creation order, with the fields of [§4.1](04-messages.md#s4.1);
  every delivery, as
  `{ "id", "message", "recipient", "session", "via", "state" }`; the hook calls
  in order, as `{ "hook", … }`; `gateEffects`, the gates recorded as applied;
  `voided`, the voided answers; every channel as `{ "name", "members" }`; and
  `render`, the rendered text of each `render` step as `{ "step", "text" }`.
- **Unsupported.** An adapter may answer a vector it cannot run as unsupported,
  with a reason; the vector is skipped ([§12.2](12-conformance.md#s12.2)).
- **Failures.** A vector that takes longer than the timeout (10 seconds by
  default), a crash, or a line that is not JSON fails the vector in flight as an
  adapter error. The runner restarts the adapter at most three times in one run;
  after that every remaining vector is an adapter error.

### 12.4.8 Reports

The runner writes a JSON report and, when asked, a JUnit XML file.

```json
{
  "dmp": "1.0.0-draft.1",
  "kit": "1.0.0-draft.1",
  "implementation": { "name": "dispatch", "version": "0.2.0" },
  "claims": { "core": "pass", "dispatch-profile": "pass" },
  "classes": {
    "envelope": {
      "pass": 88,
      "fail": 0,
      "skipped": 0,
      "notApplicable": 1,
      "shouldFailures": 0
    }
  },
  "vectors": [
    {
      "id": "…",
      "class": "envelope",
      "level": "MUST",
      "profile": "core",
      "outcome": "pass",
      "reasons": []
    }
  ],
  "declaredDeviations": [
    {
      "section": "9.3",
      "summary": "/ws sends message.new to any request-tier token"
    }
  ],
  "runner": "@dispatch-foo/protocol-spec@1.0.0-draft.1",
  "date": "2026-10-01T12:00:00.000Z"
}
```

A claim is `pass`, `fail`, or, for an A2A binding claim run on vectors alone,
`vectors-only`. A vector's outcome is `pass`, `fail`, `skipped`,
`not-applicable` or `adapter-error`, with the reasons; a class's `fail` count
includes adapter errors. With an A2A binding claim the report also has `a2a`:
the attested TCK run (`commit`, `transport`, `level`, `result`,
`attested: true`) and its declared deviations
([§12.6](12-conformance.md#s12.6)).

The JUnit file has one `testsuite` per class and one `testcase` per vector. A
MUST vector that did not pass, and is not `not-applicable`, is a `<failure>`; a
failed SHOULD vector is `<skipped message="SHOULD not met: …">`; every other
vector that did not pass is `<skipped>` with its outcome and reasons.

### 12.4.9 The runner

```text
dmp-conformance --adapter "<command>" [--claim core|envelope|dispatch-profile|a2a-binding]…
                [--vectors <dir>] [--report <file>] [--junit <file>]
                [--tck-attest <file>] [--deviations <file>] [--vectors-only]
                [--timeout-ms 10000]
```

- `--claim` may be repeated; the default is `core`.
- `--vectors` runs another directory of vectors; the default is the kit's own.
- `--report` names the JSON report (default `dmp-conformance.json`); `--junit`
  adds the JUnit file.
- `--tck-attest` names a JSON file describing an A2A TCK run,
  `{ "commit", "transport", "level", "result", "deviations" }`, which the runner
  copies into the report as attested; it never runs the TCK itself.
  `--vectors-only` judges an A2A binding claim on its vectors alone and reports
  it as `vectors-only`.
- `--deviations` names a JSON list of `{ "section", "summary" }`
  ([§12.6](12-conformance.md#s12.6)).
- `--timeout-ms` sets the per-vector timeout.

The runner exits 0 when every claim passes or is `vectors-only`, 1 when a claim
fails or the run cannot complete, and 2 on a usage error: an unknown flag or
claim, an unreadable file, or a deviation that is not allowed.

## 12.5 Requirements the kit does not test

These requirements have no vector, so a claim is honest about what passing
means. An implementation that does not meet one lists it as a declared deviation
([§12.6](12-conformance.md#s12.6)).

| Section                                      | Requirement                                             | Why no vector                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [9.3](09-identity-and-authorization.md#s9.3) | every read surface applies the read rule                | the rule itself is tested through `canRead`; whether every HTTP, WebSocket or user interface surface calls it is a property of the deployment |
| [13.1](13-security-and-privacy.md#s13.1)     | no principal sends as the system address                | authentication happens before the rules of this document; the A2A binding's vectors cover external senders                                    |
| [13.7](13-security-and-privacy.md#s13.7)     | identifier entropy                                      | statistical                                                                                                                                   |
| [13.8](13-security-and-privacy.md#s13.8)     | retention is documented, deletion offered               | documentary                                                                                                                                   |
| [13.9](13-security-and-privacy.md#s13.9)     | gate data never leaves through a binding                | tested for A2A by `a2a-binding` vectors; another binding brings its own                                                                       |
| [13.10](13-security-and-privacy.md#s13.10)   | logs hold no bearer tokens, message bodies or gate data | operational                                                                                                                                   |
| [13.11](13-security-and-privacy.md#s13.11)   | gate data carries references, not content               | a design property of each gate type                                                                                                           |
| [13.16](13-security-and-privacy.md#s13.16)   | local identity is attribution, not a boundary           | a property of the deployment                                                                                                                  |
| [B.2](appendix-b-agent-tools.md#sB.2)        | blocking waits are bounded                              | a timeout in an agent's tool, outside the host's rules                                                                                        |

## 12.6 Declared deviations

A report may declare deviations only from the requirements of
[§12.5](12-conformance.md#s12.5); the runner refuses any other section. A claim
whose report declares any must be quoted with them
([§12.7](12-conformance.md#s12.7)).

For the A2A binding, the attested TCK run may carry only the deviations
[§8.10](08-a2a-binding.md#s8.10) declares: `bounded-blocking-wait` (a MUST
deviation from A2A: a blocking wait is bounded) and `application-json` (a SHOULD
deviation: responses are `application/json`). The runner refuses an attestation
that lists any other.

## 12.7 Claim wording

An implementation whose report passes a claim may say that it implements the
Dispatch Messaging Protocol, naming the version it was measured against and, in
parentheses, each claim that passed: "implements the Dispatch Messaging Protocol
(DMP) 1.0 (Core)", or "implements DMP 1.0 (Core, A2A binding)". When its report
declares deviations, it adds "with declared deviations". Publishing the report
beside the claim lets anyone check it.

Using the protocol's title in such a claim is the only use of the name
"Dispatch" this document grants. It gives no right to use "Dispatch" in the name
of a product, package or service; Apache-2.0 grants no trademark rights.
