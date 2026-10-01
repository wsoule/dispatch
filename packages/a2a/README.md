# @dispatch/a2a

The A2A 1.0 bridge for Dispatch, under the MIT license. It holds everything that
decides how a Dispatch project looks to an A2A client:

- `handleA2A(req, port, options)`, a fetch-style server for the HTTP+JSON
  binding of A2A 1.0 (the agent card, send, stream, get, list, cancel and
  subscribe);
- the codec between Dispatch envelopes and A2A messages, the three Dispatch
  extensions (envelope, gate and work), the task-state projection, the policy
  functions, the card builder and the `a2a.db` store.

A host implements one seam, `BridgePort`: it gathers facts about a task and
applies the effects the handler asks for. dispatchd is one such host. An
embedder can also publish artifacts of its own through
`TaskFacts.hostArtifacts`. They are published unchanged and ahead of Dispatch's
own artifacts, because clients read the first artifact as the result.

It uses `@a2a-js/sdk` 1.2.0 for the wire types, ProtoJSON, SSE framing and the
client, never for its server. The package never imports server code.

## MUST deviations

**A blocking send is bounded** (A2A §3.2.2; the TCK's
`CORE-EXECUTION-MODE-001`). A `message:send` without `returnImmediately` waits
until the task is terminal, `INPUT_REQUIRED` or `AUTH_REQUIRED`, or until
`blockingWaitSec` passes: 60 s by default, 600 s at most, and a project may set
a shorter wait. It then returns the task as it stands, usually `WORKING`.

An answer from a person can take hours, and tunnels and proxies cut idle HTTP
requests long before that. The ask skill on the agent card says so.

A green TCK run says nothing about this deviation: the SUT (`test/tck/sut.ts`)
finishes every scenario within seconds, well inside the wait.
`test/wait.test.ts` asserts the deviation directly.

**dispatchd refuses a `contextId` it does not know**, which the TCK's
`CORE-MULTI-002a` counts as a failure. dispatchd reads a client's `contextId` as
a Dispatch thread. A new task may name only a thread the client is in; any other
gets 400 `INVALID_ARGUMENT` on `message.contextId`, and dispatchd never replaces
it with a `contextId` of its own. A2A §3.4.1 allows this: an agent that cannot
accept a client's `contextId` rejects the request. The TCK's test sends an
unknown `contextId` and passes only when the send succeeds, so a TCK run against
dispatchd would fail it. The SUT keeps any client `contextId`, the other
behaviour §3.4.1 allows, and `test/tck/sut.test.ts` checks it is never replaced.

## SHOULD deviations

- **Responses are `application/json`**, not `application/a2a+json` (§11.1). The
  TCK's `HTTP_JSON-SVC-001` requires `application/json`. Requests may send
  either.
- **Push configs are read back without their secrets.** Create, get and list
  return a config's `id`, `taskId`, `url` and `authentication.scheme`, never its
  `token` or `authentication.credentials`, so a leaked client token cannot read
  back a webhook's credentials. The TCK's push tests compare no returned fields.
- **No SHOULD requirement is marked expected-to-fail.** Any that is gets its
  reason here.

## Clients

- Send `A2A-Version: 1.0` on every request. A request without it is read as A2A
  0.3 and refused.
- Authenticate with a bearer token from `dispatch a2a clients add <name>`. A
  client can call once the project owner approves it, in Needs you or with
  `--approve`.
- Send asks with `returnImmediately: true`, then stream, subscribe or poll.
- A `message:stream` ends at `INPUT_REQUIRED`, where the client must answer
  (§11.7). A `:subscribe` stream stays open until the task is terminal (§3.1.6).
  Both stay open through `AUTH_REQUIRED`.
- A stream coalesces a task's changes over one second. An `artifactUpdate`
  always carries the whole artifact (`append: false`, `lastChunk: true`), so
  replace your copy of it rather than appending.

## Signed card

dispatchd signs its card with an ES256 key kept per project in the 0600
`~/.dispatch/credentials.json`, and serves the public key at
`/.well-known/jwks.json`; the signature's `kid` is the key's RFC 7638
thumbprint. A key is made only when none is stored. A stored key that is
malformed or does not work, or a credentials file that cannot be parsed, turns
signing off with a warning in the listener status, and nothing is written.
Losing the credentials file makes a new key, so the `kid` changes and clients
that pinned the old key must fetch the JWKS again.

## Standalone host

Use `dispatch a2a serve` when the public A2A listener should run on another
machine than the owner's (a relay or hosted box), reaching the owner's daemon
over its team-local TLS listener.

On the owner's machine (the operator):

```bash
dispatch a2a hosts allow          # open /api/a2a/port to standalone hosts
dispatch a2a hosts add relay      # mint a host token, shown once
```

Put the token in a file only its owner can read (`chmod 600`) on the relay
machine, then:

```bash
dispatch a2a serve --host 0.0.0.0 --public --port 443 \
  --public-url https://agent.example.com \
  --tls-cert cert.pem --tls-key key.pem \
  --daemon https://<daemon>:<tls port> --host-token-file ./host-token
```

- The listener binds `127.0.0.1` unless `--public` is given; every network
  interface also needs TLS and `--public-url`.
- A remote daemon is reached over https only. A self-signed team-local
  certificate is trusted through `NODE_EXTRA_CA_CERTS=<cert.pem>`, read when the
  process starts.
- A host token opens only `/api/a2a/port/*`, and only while hosts are allowed;
  `dispatch a2a hosts remove <id>` revokes one at once. The app, agent, run and
  teammate tokens never open those routes, and an A2A client's token never works
  on `/api` at all.
- The card is built for the host's configured public URL, never from a request's
  `Host` or `X-Forwarded-*` headers.
- A standalone host offers no push configs; push is the daemon's own.

## Running the TCK

The official [A2A TCK](https://github.com/a2aproject/a2a-tck) runs against
`test/tck/sut.ts`: `handleA2A` over a `BridgePort` that plays the TCK's
scenarios by `messageId` prefix. It tests the binding, not Dispatch semantics.

```bash
moonx a2a:tck --ignore-ci-checks
```

It needs Python 3.11, [uv](https://docs.astral.sh/uv/) and the network: it
clones the TCK at a pinned commit into `.agents/ignore/a2a-tck/`, runs its MUST
level and copies `reports/compatibility.json` to
`.agents/ignore/a2a-tck-compatibility.json`. It is not part of `moon ci`;
`.github/workflows/a2a-tck.yml` runs it on changes under `packages/a2a/`.

## Before a release

1. `moonx a2a:tck --ignore-ci-checks`: the MUST run is green, and the report
   matches the deviations above.
2. Run the [A2A Inspector](https://github.com/a2aproject/a2a-inspector) against
   a daemon with the listener on (`dispatch a2a listen`) and one approved
   client: load the card from `/.well-known/agent-card.json`, send an ask,
   answer it in Needs you, and confirm the inspector shows
   `TASK_STATE_COMPLETED` with the `answer` artifact and no validation errors.
   Note the inspector's commit in the release notes.
