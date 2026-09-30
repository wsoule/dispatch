# Dispatch Messaging Protocol (DMP)

DMP is the protocol Dispatch hosts use to carry messages between agents and
humans: addresses, the message envelope, gates that ask a deciding principal to
approve something, delivery to persistent mailboxes, channels, and a binding
onto A2A. This package holds the specification text under `spec/`, one file per
top-level section, and will also hold its conformance kit: the registries, JSON
Schemas, test vectors and the `dmp-conformance` runner. The text and the kit are
licensed under Apache-2.0 (see `LICENSE`) so anyone may implement the protocol;
the reference implementation in `@dispatch-foo/protocol` stays MIT.

## The conformance kit

The kit is the vectors under `vectors/`, the registries under `registries/`, and
the `dmp-conformance` runner, which judges an implementation through an adapter
you write. It runs on Node 22.13 or later with no runtime dependencies.

**Install.** The package is not on npm yet. In this repository, build it with
`moonx protocol-spec:build` and run `node packages/protocol-spec/dist/bin.js`;
once published, the same command is the package's `dmp-conformance` bin.

**The adapter contract.** The runner starts your command and speaks JSON lines
over its stdin and stdout, one JSON object per line; whatever the adapter writes
to stderr goes to the runner's log. Lines end at LF alone (a CR before it is
dropped), so split input at LF only. The runner writes U+2028 and U+2029 as the
JSON escapes `\u2028` and `\u2029`, so a reader that also breaks lines at them
still sees whole lines, and it reads the adapter's output at LF only, so the
adapter may write the two characters raw or escaped.

1. The runner sends `{"dmp":"hello","kit":"<version>"}`; the adapter answers
   with its hello: implementation, classes, profiles, capabilities, system
   address, gate types and render forms.
2. For each vector the runner sends `{"dmp":"run","vector":{…}}` without the
   vector's `then`, and the adapter runs it against a fresh store and world.
3. The adapter answers with `{"dmp":"observation",…}` (step results, messages,
   deliveries, hook calls, gate effects, voided answers, channels, renders) or
   `{"dmp":"unsupported","id":…,"reason":…}`.
4. A vector times out after 10 seconds; a crash, a timeout or a line that is not
   JSON fails the vector in flight, and the runner restarts the adapter at most
   three times.
5. The runner sends `{"dmp":"bye"}` and the adapter exits 0.

**The command line.**

```text
dmp-conformance --adapter "<command>" [--claim core|envelope|dispatch-profile|a2a-binding]…
                [--vectors <dir>] [--report <file>] [--junit <file>]
                [--tck-attest <file>] [--deviations <file>] [--vectors-only]
                [--timeout-ms 10000]
```

The claim defaults to `core`. The JSON report goes to `--report` (default
`dmp-conformance.json`) and, with `--junit`, a JUnit XML file too. A MUST vector
that fails or is skipped fails its claim, as does a class with no vector that
ran; a SHOULD failure is reported without failing it; a MAY vector runs only
when the adapter declares its capability. The A2A binding claim needs
`--tck-attest`, or `--vectors-only` to report it as `vectors-only`.

**Exit codes.** `0` when every requested claim passes (or is `vectors-only`),
`1` when a claim fails or the run cannot complete, `2` on a usage error.

## Known implementations

The editor tells every implementation listed here about a protocol security fix
7 days before it is released, through the security contact listed with it.

- **Dispatch**, the reference implementation (`@dispatch-foo/protocol`, with
  `@dispatch-foo/a2a` for the A2A binding): implements DMP 1.0.0-draft.1 (Core,
  Dispatch profile), with declared deviations. Its reports:
  [Core and Dispatch profile](https://github.com/wsoule/dispatch/blob/main/packages/protocol-spec/reports/dispatch-1.0.0-draft.1.json)
  and
  [A2A binding](https://github.com/wsoule/dispatch/blob/main/packages/protocol-spec/reports/dispatch-a2a-1.0.0-draft.1.json).
  The A2A binding passes every `a2a-binding` vector and is reported as
  `vectors-only` until an A2A TCK run is attested (§12.3). Security contact:
  [SECURITY.md](https://github.com/wsoule/dispatch/blob/main/.github/SECURITY.md).
