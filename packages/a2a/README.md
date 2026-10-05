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

## Known limit: runs outside their token

Inside Dispatch, provenance follows lineage: a task that an A2A-origin run
creates, edits or dispatches is A2A-origin too, so its runs act for no one, and
an A2A-origin run reads only its own A2A task. Both rest on the run presenting
its own run token. A run that reads the daemon's shared agent token from the
daemon file, or shells out to the `dispatch` CLI, escapes them: its tasks carry
no lineage and its reads are not narrowed. Its writes are still credited to
`agent:local-cli`, never the owner. This is accepted for now (XH-R7). Closing it
needs sandboxing that denies runs the daemon file.

## Signed card

dispatchd signs its card with an ES256 key kept per project in the 0600
`~/.dispatch/credentials.json`, and serves the public key at
`/.well-known/jwks.json`; the signature's `kid` is the key's RFC 7638
thumbprint. A key is made only when none is stored. A stored key that is
malformed or does not work, or a credentials file that cannot be parsed, turns
signing off with a warning in the listener status, and nothing is written.
Losing the credentials file makes a new key, so the `kid` changes and clients
that pinned the old key must fetch the JWKS again.

The card carries two signatures, made with the same key:

1. `signatures[0]` has `typ: "dispatch-card+jws"` in its protected header. It
   covers the RFC 8785 (JCS) form of the card's JSON exactly as served, minus
   `signatures`. Every field is covered, the auth fields `securitySchemes` and
   `securityRequirements` included. A standard JCS verifier checks it, and so
   does `verifyCardSignature` in this package, which accepts no other signature.
2. `signatures[1]` has `typ: "JOSE"` and covers the canonical form of
   `@a2a-js/sdk` 1.2.0, so the SDK's `verifyAgentCardSignature` accepts the
   card. That form leaves out `securitySchemes`, `securityRequirements`, every
   empty value and any field outside the SDK's card schema, so this signature
   does not protect how a client authenticates.

A client that relies on the auth scheme should verify `signatures[0]`, picked by
its `typ`, against the card's raw text as received.

**Where the key comes from matters.** The card's `jku` is part of what an
attacker controls, so never fetch a key from wherever it points. Pin the key, or
fetch the JWKS only from the origin you fetched the card from, at
`/.well-known/jwks.json`. `verifyCardSignature` hands its `keyFor` the `kid`
alone, and accepts a key only when its RFC 7638 thumbprint equals that `kid`.
Given the raw text, it also refuses a card that repeats a member name (I-JSON),
since two readers could see different values.

## Outbound address checks

Every outbound contact (a peer's card, its interface, a push webhook) resolves
the host name first and refuses private, loopback, link-local and metadata
addresses unless an operator allowed them for that peer. The connection is then
pinned to the address that was checked, with TLS still verified against the
name, so a DNS answer that changes between the check and the connect (DNS
rebinding) cannot redirect it. Redirects are not followed. A name that does not
resolve is retried; a refused address is final.

## Reaching your agent

The listener binds loopback. To let agents on other machines reach it, put a
tunnel in front of it and give the card the tunnel's URL. Commands below were
checked against Tailscale's and Cloudflare's docs in October 2026.

Whatever terminates TLS in front of the listener (Cloudflare, a relay) can read
bearer traffic: a plain A2A client's token and every body. Tailscale Funnel is
not one of them: Funnel's TLS ends on your machine. Pair Dispatch peers
(`dispatch a2a pair offer`) so their requests and replies are signed; an edge
can still read and drop them, but cannot forge or alter them unnoticed.

`--trust-forwarded-for` keys the per-IP limits on the right-most
`X-Forwarded-For` value. The listener honours X-Forwarded-For only when it is
bound to loopback (a tunnel on this machine), as `dispatch a2a serve` does; on a
network bind the flag is ignored, since anyone could send that header. Set
trustForwardedFor only when the proxy in front appends the connecting address to
that header; otherwise a client chooses its own address and steps around the
per-IP lockout. Left off, every client of a loopback tunnel shares one budget,
which is safe. To check a proxy, send a request with
`X-Forwarded-For: 192.0.2.1` through it: the listener's access log should show
your real address, not `192.0.2.1`.

`a2a.requireSignedDispatchPeers: true` in config.yml refuses bearer tokens from
any client whose requests once named Dispatch's signature extension, so a
Dispatch peer that can sign stops falling back to its bearer. The client names
the extension itself, so one that never does keeps its bearer: this setting is a
migration nudge for well-behaved Dispatch agents, not a security boundary.
Upgrade or pair a peer to stop its bearer for good.

### Tailscale

Within your tailnet (needs MagicDNS and HTTPS certificates on the tailnet):

```bash
dispatch a2a listen --port 7450 --public-url https://<machine>.<tailnet>.ts.net
tailscale serve --bg --https=443 http://127.0.0.1:7450
tailscale serve --https=443 off          # stop
```

A tailnet name resolves to a 100.64.0.0/10 address, which the outbound address
checks refuse: a tailnet peer must be added or paired by someone at the operator
tier, as for any private address.

Public, through Tailscale Funnel (also needs the `funnel` node attribute in the
tailnet policy; ports 443, 8443 or 10000):

```bash
dispatch a2a listen --port 7450 --public-url https://<machine>.<tailnet>.ts.net
tailscale funnel --bg --https=443 http://127.0.0.1:7450
tailscale funnel --https=443 off         # stop
```

Funnel's TLS ends on your machine, but Tailscale's docs do not say whether
`serve` or `funnel` add `X-Forwarded-For`: run the check above before turning
`--trust-forwarded-for` on.

### Cloudflare Tunnel

Use a named tunnel with your own hostname. Quick tunnels
(`cloudflared tunnel --url …`) are for testing only: they do not carry
Server-Sent Events, so A2A streaming and task subscriptions fail, and they cap
in-flight requests at 200.

```bash
cloudflared tunnel login
cloudflared tunnel create dispatch-a2a
cloudflared tunnel route dns dispatch-a2a agent.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /Users/<you>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: agent.example.com
    service: http://127.0.0.1:7450
  - service: http_status:404
```

```bash
cloudflared tunnel ingress validate
cloudflared tunnel run dispatch-a2a
dispatch a2a listen --port 7450 --public-url https://agent.example.com \
  --trust-forwarded-for
```

Cloudflare terminates TLS and can read and rewrite traffic: bearer clients are
fully exposed to it, and signatures make any rewrite of a paired peer's request
fail verification. Cloudflare appends the address that connected to it to
`X-Forwarded-For`, so `--trust-forwarded-for` is safe here; `CF-Connecting-IP`
is not read separately. Cloudflare Access in front of the tunnel works only for
clients that can present Access credentials, which plain A2A clients cannot.

### A relay

With neither Tailscale nor a tunnel, or to serve many daemons from one public
host, run a relay that the daemons dial out to; none of them opens a port:

```bash
dispatch a2a keys show                      # on each daemon: its thumbprint
# On the relay machine: the card-key thumbprints it admits, one per line.
dispatch a2a relay --host 0.0.0.0 --public --port 443 \
  --public-url https://relay.example.com \
  --tls-cert cert.pem --tls-key key.pem --tenants-file ./tenants   # chmod 600
```

Each daemon then sets
`PUT /api/a2a/relay {"enabled": true, "url": "https://relay.example.com"}`
(operator) and is served at `https://relay.example.com/t/<thumbprint>`, its card
built for that URL. The relay terminates TLS: it can read bearer traffic and
bodies and can drop them, but cannot forge a paired peer's signed requests,
which are checked against the tenant URL. Run it for your own daemons, never as
a public service.

To change the tenants file while the relay runs, write the new list to a file
beside it, `chmod 600` it and `mv` it over the old one (an atomic replace), then
send the relay SIGHUP: it re-reads the list and drops tenants no longer on it.

Connections that have not authenticated yet are capped per address (8) and in
all (256). Behind `--trust-forwarded-for` on loopback, the per-address cap keys
on the forwarded address. Many addresses together can still fill the overall cap
for a while; each such connection closes after 10 s without a valid auth.

## Standalone host

Use `dispatch a2a serve` when the public A2A listener should run on another
machine than the owner's (a relay or hosted box), reaching the owner's daemon
over its team-local TLS listener.

On the owner's machine (the operator):

```bash
dispatch a2a hosts allow          # open /api/a2a/port to standalone hosts
dispatch a2a hosts add relay --public-url https://agent.example.com
                                  # mint a host token, shown once
```

The public URL is pinned to the host: its card is built for that URL and no
other, so a stolen host token cannot publish a card pointing elsewhere.

Put the token in a regular file you own and only you can read (`chmod 600`; not
a symlink) on the relay machine, then:

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
- Pairing works through a host, but upgrading an existing bearer pair to
  signatures through a standalone host is not supported yet: the host does not
  forward the bearer the upgrade authenticates with. Upgrade over the daemon's
  own listener, or pair afresh.

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

Run it against the SUT, not dispatchd: the TCK's push tests (`PUSH-DELIVER`)
register a webhook on the TCK's own machine, which dispatchd's push guard
refuses as a private address. The SUT delivers push without that guard.

## Before a release

1. `moonx a2a:tck --ignore-ci-checks`: the MUST run is green, and the report
   matches the deviations above.
2. Run the [A2A Inspector](https://github.com/a2aproject/a2a-inspector) against
   a daemon with the listener on (`dispatch a2a listen`) and one approved
   client: load the card from `/.well-known/agent-card.json`, send an ask,
   answer it in Needs you, and confirm the inspector shows
   `TASK_STATE_COMPLETED` with the `answer` artifact and no validation errors.
   Note the inspector's commit in the release notes.
