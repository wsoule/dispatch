# @dispatch-foo/protocol

The reference implementation of the
[Dispatch Messaging Protocol](https://dispatch.foo/protocol/) (DMP), under the
MIT license: address parsing, the message envelope and its validation, gates,
the delivery engine and a SQLite message store. Dispatch's daemon runs it; any
host can embed it by implementing `MessagingHost`.

```bash
npm install @dispatch-foo/protocol
```

It runs on Node 22.13 or later, and on Bun. Its entry points:

- `@dispatch-foo/protocol`: the engine, the store and the envelope rules;
- `@dispatch-foo/protocol/browser`: the registry constants and gate predicates
  alone, for code that must not reach `node:sqlite`;
- `@dispatch-foo/protocol/conformance`: the adapter that runs the DMP
  conformance kit against this engine, also installed as the
  `dmp-reference-adapter` bin;
- `@dispatch-foo/protocol/federation`: the federation wire types of DMP's
  Appendix F.

The specification, its registries and its conformance kit are in
`@dispatch-foo/protocol-spec`.
