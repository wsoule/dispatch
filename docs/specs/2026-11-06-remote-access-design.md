# Remote access: the phone app without a VPN — design

2026-11-06. Asked for by Striker: an iOS companion app that reaches the daemon
on their Mac the way Claude Code's remote control does, with no Tailscale or
other VPN. Scope: `packages/remote`, `apps/remote-relay`,
`packages/server/src/remoteAccess`, `dispatch phone`, and `apps/mobile`. Push
notifications are a second change.

## Shape

```text
iPhone (apps/mobile)  ── wss ──▶  relay (apps/remote-relay)  ◀── wss ──  dispatchd on the Mac
        RemoteConnection          routes opaque frames            DaemonLink → loopback API
```

The daemon dials out to the relay, so the Mac needs no open port, no port
forward and no VPN. The phone dials the same relay. The relay pairs the two by
the daemon's id and forwards bytes it cannot read.

The daemon only dials while it could be used: while a phone is paired or a
pairing code is live. A daemon nobody paired never talks to the relay.

## A new relay, not the federation relay

The hosted federation relay (`relay.dispatch.foo`, see
`2026-10-05-sealed-relay-contract.md`) carries signed roster ops between team
daemons. It is the wrong fit for a phone:

- It moves federation logs, not API requests. Run logs, diffs and gates are not
  in those logs, and a phone would have to speak signed federation ops to take
  part.
- What it can read depends on a team's `content-e2e` setting. The phone link has
  to be end to end encrypted always, for everyone, including people with no
  team.
- It lives in the private repository and is the paid transport. The phone link
  is a solo feature and should not depend on a team or a license.

So `apps/remote-relay` is a separate, small Bun service (one file, in-memory
state, no database) in this repository, under FSL like the app.

## Pairing

1. On the Mac, `dispatch phone pair` asks the daemon (`POST /api/remote/pair`,
   operator tier) for an offer and prints it as a QR code. The offer is a
   `dispatch-remote://pair?...` URL with the relay, the daemon id, the daemon's
   X25519 public key, an offer id, a 32-byte one-time code and the Mac's name.
   It expires after 10 minutes, and a new offer replaces it.
2. The phone scans it (the in-app camera, or the system camera through the
   `dispatch-remote` URL scheme) and the person taps Pair. A link alone never
   pairs: there is always a confirm step.
3. The phone makes its own X25519 key pair and opens a handshake that mixes in
   the one-time code, so only a phone that saw the QR code can finish it.
4. The daemon records the phone's public key on the phone's first sealed frame,
   and burns the offer. The phone counts itself paired only after a sealed ping
   comes back, so a phone that drops mid-pairing is never left thinking it is
   paired.

The phone keeps its secret key and the daemon's public key in the iOS keychain,
readable only on that device while it is unlocked. The phone never holds a
Dispatch token.

## Encryption

Each session is a Noise-like handshake over X25519: static keys on both sides
(the daemon's pinned from the QR code, the phone's pinned at pairing), fresh
ephemeral keys per session, three Diffie-Hellman results, and the pairing code
as a pre-shared key while pairing. Frames are ChaCha20-Poly1305 with counter
nonces, one key per direction (`@noble/curves`, `@noble/ciphers`,
`@noble/hashes`, which need nothing from Node and run under Hermes).

What the relay sees: daemon ids, that a phone is talking to one, IP addresses,
timing and frame sizes. What it never sees: requests, responses, events, code,
logs or diffs. A relay that lies can drop or delay frames but cannot read, forge
or replay them.

The daemon signs in to the relay with a 32-byte secret; its public id is a hash
of that secret, so nobody else can register as that daemon.

## How a phone's requests reach the API

The phone's `fetch` and event socket are tunnelled: `RemoteConnection.fetch`
seals the request, the daemon's `DaemonLink` opens it and replays it against its
own listener on `127.0.0.1` with a credential that exists only in memory, one
per paired phone (`dsr_…`, minted at boot).

- That credential speaks for the operator at the **decide** tier. A phone can
  answer gates and questions, cancel runs, merge and discard. Every
  operator-tier route (a shell, file writes, issuing tokens, pairing another
  phone) answers 403. The end-to-end test checks both.
- Only `/api/` paths are relayed, and only `accept`, `content-type`, `if-match`
  and `if-none-match` pass from the phone. Its `authorization` and cookies are
  dropped, and `set-cookie` never goes back.
- Events are the daemon's own `/ws` stream, opened over loopback per phone and
  forwarded frame by frame.

So `@dispatch/client` is reused unchanged on the phone: it is given the tunnel's
`fetch` and socket instead of the platform's.

## Where things are kept

`~/.dispatch/projects/<key>/remote.json`, mode 0600: the relay secret, the
daemon's X25519 secret key, and each paired phone's public key and name. Losing
it unpairs every phone.

`dispatch phone list` shows paired phones; `dispatch phone unpair <id>` removes
one and ends its sessions at once. Forgetting the Mac on the phone removes the
phone's keys but does not unpair it on the Mac.

`DISPATCH_REMOTE=off` turns remote access off: nothing dials out and pairing
refuses. `DISPATCH_REMOTE_RELAY` points the daemon at another relay.

## Hosting

Default: a Railway service in the existing project, built from
`apps/remote-relay/Dockerfile`, at `wss://remote.dispatch.foo`, which is the
daemon's built-in default. Railway fronts it with TLS. The relay keeps no state
on disk, so a restart only makes both sides reconnect.

It runs as the `dispatch-remote` service in the `dispatch` Railway project, set
up in the dashboard and not yet in `.railway/railway.ts`. It deploys from this
branch until the PR merges, then should follow `main`. Railway's health check
hits `/health`. `DISPATCH_REMOTE_RELAY=ws://…` points a daemon at a relay run
locally instead (`bun run apps/remote-relay/src/main.ts`).

## Known limits

- `remote.json` sits under DISPATCH_HOME, which an agent run with shell access
  can read, like the agent token (XH-R7). With it, a run could impersonate the
  daemon to the relay; it could not reach the API any wider than it already can.
- The Mac has to be awake and the daemon running.
- Desktop users have no terminal-free way to pair yet. A QR panel in Settings is
  a follow-up.
- Runs started from the phone would have no operator. The app does not start
  runs in v1.

## Push notifications (second change)

The daemon's `decision.opened` webhook is the seam. A push needs a server that
holds the APNs key, so the plan is: the phone registers its APNs token through
the tunnel, the daemon sends a content-free "something needs you" ping through
the relay, and the relay forwards it to APNs. The notification says nothing
about the content; opening the app fetches it through the tunnel.
