# Appendix D JSON Schemas

This appendix is informative. The kit ships JSON Schemas (draft 2020-12) for the
wire shapes of this document, under `schemas/` in the kit's package and on the
web at `https://dispatch.foo/protocol/<version>/schemas/<name>.schema.json`,
where `<version>` is this document's version. Each schema's `$id` is that
address.

The schemas are informative ([§1.4](01-introduction.md#s1.4)). JSON Schema
cannot count UTF-8 bytes or express the one-line rule, so the byte limits, the
one-line fields, blank bodies and every rule that depends on another field's
value are left to the text. The text and the vectors govern. The kit's own tests
keep the schemas from contradicting them: `send-input.schema.json` accepts every
input an `envelope` vector accepts, and refuses every input a vector refuses for
a reason a schema can express (the vectors tagged `structural`,
[§12.4.1](12-conformance.md#s12.4.1)); `vector.schema.json` describes every
vector file, and `adapter.schema.json` every `run` line the runner sends.

## D.1 Schemas

| Schema                   | Describes                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.schema.json`    | a stored message: the sixteen fields of [§4.1](04-messages.md#s4.1), and `origin` and `hlc` of [Appendix F](appendix-f-federation.md#sF.4)                                |
| `send-input.schema.json` | a send input ([§4.1](04-messages.md#s4.1)), with the structural rules of [§4.5](04-messages.md#s4.5) only                                                                 |
| `ref.schema.json`        | a ref ([§4.3](04-messages.md#s4.3)), whose `type` may be any identifier, as a received ref's may ([§4.4](04-messages.md#s4.4))                                            |
| `delivery.schema.json`   | a delivery ([§6](06-delivery.md#s6)), as the kit observes it                                                                                                              |
| `gate-data.schema.json`  | the gate data of each permanent gate type ([§11.6](11-registries.md#s11.6)): `wake`, and the Dispatch profile's types ([Appendix C](appendix-c-dispatch-profile.md#sC.3)) |
| `vector.schema.json`     | a vector file ([§12.4.1](12-conformance.md#s12.4.1)); its `runnable` definition is a vector without `then`, as the runner sends it                                        |
| `adapter.schema.json`    | the lines between the runner and an adapter ([§D.2](appendix-d-json-schemas.md#sD.2))                                                                                     |

`message.schema.json` also defines the shapes the others share: an identifier,
an address and a timestamp ([§1.4](01-introduction.md#s1.4)). A schema names
another by a relative reference, so the schemas of one version refer only to
each other.

What the vector schema leaves to the runner: a file's class is its directory,
each vector's `class` is its file's, ids are unique across the kit and never
reused, `then.steps` lists no more results than `when` has steps, each `$sN`
names an earlier step that created a message, and a `render` row names a
`render` step ([§12.4](12-conformance.md#s12.4)).

## D.2 Adapter messages

`adapter.schema.json` describes each line of the adapter protocol of
[§12.4.7](12-conformance.md#s12.4.7) as one definition:

| Definition    | Direction         | Line                                                                                                            |
| ------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `runnerHello` | runner to adapter | `{ "dmp": "hello", "kit" }`: the first line                                                                     |
| `hello`       | adapter to runner | the implementation, classes, profiles, capabilities, system address, gate types and render forms it declares    |
| `run`         | runner to adapter | `{ "dmp": "run", "vector" }`, the vector without `then`                                                         |
| `observation` | adapter to runner | the steps' outcomes, messages, deliveries, hook calls, applied gates, voided answers, channels and render texts |
| `unsupported` | adapter to runner | `{ "dmp": "unsupported", "id", "reason" }`: the vector is skipped                                               |
| `bye`         | runner to adapter | `{ "dmp": "bye" }`: the adapter exits 0                                                                         |

The runner checks more than the schema says: each render form is a pattern that
compiles, and an observation or `unsupported` names the vector it answers.
