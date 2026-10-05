# The sealed relay: frame contract and acceptance

Federation F4 (Task 21, Task 22). The sealed relay is the paid transport: a team
switches to it from git with a signed `transport` roster op, and its daemons
then exchange their federation logs through one WebSocket each, with mail
arriving in under a second. The relay itself lives in the private repository.
This document fixes what it must do so that this repository's
`RelayFederationTransport` (`packages/server/src/team/federation/relay.ts`)
works against it, and how its acceptance is judged.

The in-repo fake relay (`packages/server/test/team/federation/fakeRelay.ts`)
implements this contract for tests. Where the two disagree, this document wins
and the fake is fixed.

## What the relay can read

Everything that is not sealed: the board, team memory and team docs, the roster
with the team's license key, presence, and who messaged whom and when. It cannot
read message contents. Every client shows this sentence (`RELAY_DISCLOSURE`)
before a team switches, and a switch needs it confirmed.

## Endpoints

- `POST /v1/teams` registers a team from its `found` op and its founder's `key`
  op. The team id is the first 32 hex characters of the `found` op's hash. The
  hosted relay refuses a team without a license key in its roster; a self-hosted
  relay runs keyless for up to three people. See "Registration" below.
- `GET /v1/teams/<teamId>` upgrades to the WebSocket below. Any other team id
  answers 404.

### Registration

The relay serves no team it has not registered, so a switch registers the team
before it signs anything. `POST /api/team/transport` with `kind: 'relay'` does
this once the URL, FW-R39 caps, legacy window, admin role and disclosure checks
pass, and before it signs the `transport` op:

- **Where.** The request goes to the relay URL's HTTP base: the same host, port
  and path, with `wss://` read as `https://` (and `ws://` as `http://` for a
  relay on this machine in tests), then `/v1/teams`.
- **Body.** `{ key, found, ops }`, all from the founder's log:
  - `key` is the founder's key op and `found` its found op;
  - `ops` holds the founder's ops between them and on through its latest
    `license` op, so a hosted relay sees the license. Without a license op,
    `ops` holds only what lies between `key` and `found`.

  Every entry is whole and signed, and they run unbroken from the key op, since
  the relay verifies them as one chain. On the founder they come from its own
  log. On another admin they come from the current transport's scan of the
  founder's log; a machine that does not hold them yet is refused and asked to
  pull first.

- **Token.** When the relay requires one (`REGISTRATION_TOKEN`), registration
  sends `Authorization: Bearer <token>`. The token comes from the switch's
  `registrationToken` field
  (`dispatch team transport relay <url> --yes --registration-token`, which reads
  it from stdin or a prompt that does not echo when given no value, or the token
  field beside the relay URL in the desktop's Machines settings). It is used for
  that one request and never stored: no op, audit row, problem or log carries
  it. Other machines never need it, because only registration does.
- **Idempotent.** A relay that already holds the team answers 200 with its id,
  and the switch goes on. A new team answers 201. Either way the answered team
  id must be this team's.
- **Failure.** If the relay is unreachable, refuses the token (401), needs a
  license (402), rate-limits (429) or refuses the chain (400), the switch
  answers 502 with `code: 'relay_registration_failed'` and a message naming the
  relay and the reason. Nothing is signed, and the team stays on its current
  transport.

The hosted relay is `wss://relay.dispatch.foo`. The self-host image is one
container with a SQLite volume.

## Frames

Every frame is one JSON text message with a `t` field. Requests carry an `id`,
and the answer to a request carries it back as `re`. A frame with an unknown `t`
is ignored. A malformed frame closes the socket, on either side.

- **Frame size.** A frame is at most 8 MiB on the wire. The relay closes a
  socket that sends a larger one, and a client closes one that receives a frame
  over 16 MiB.
- **Publish frames.** A `publish` carries at most 1,000 entries and about 4 MiB.
  A client uploading more sends several in order, and stops at the first one
  whose `stored` answer is short.

| From   | Frame                                       | Meaning                                                                                                                                                                                        |
| ------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| relay  | `{t:'challenge', nonce}`                    | Sent on open. The nonce is random, at least 128 bits, and good for this socket only.                                                                                                           |
| client | `{t:'auth', replica, sig, keyOp?}`          | `sig` signs `"dispatch-relay-v1\n" + URL + "\n" + teamId + "\n" + nonce` with the replica's key. `keyOp` is the replica's own key op, so the relay can check a machine it has not seen before. |
| relay  | `{t:'ready'}` or `{t:'refused', reason}`    | Refusing closes the socket.                                                                                                                                                                    |
| client | `{t:'publish', id, ops}`                    | The client's own log entries, stubs included.                                                                                                                                                  |
| relay  | `{t:'stored', re, through}`                 | The highest seq the relay holds for this replica. The client treats `through` below what it sent as offline, so its outbox waits.                                                              |
| client | `{t:'pull', id, since, replicas?}`          | Entries after each replica's mark, optionally only these replicas.                                                                                                                             |
| relay  | `{t:'ops', re, ops, more?}`                 | At most 1,000 entries; `more` says to pull again from the new marks.                                                                                                                           |
| relay  | `{t:'ops', ops}` with no `re`               | A push: something new is stored. The client runs a pass.                                                                                                                                       |
| client | `{t:'ack', id, through}`                    | This replica has read each publisher through these seqs.                                                                                                                                       |
| relay  | `{t:'acknowledged', re}`                    | Answer to `ack`.                                                                                                                                                                               |
| relay  | `{t:'error', re, reason}`                   | The request failed. The client treats it as offline.                                                                                                                                           |
| relay  | `{t:'presence', online:[{replica, since}]}` | The admitted machines connected now.                                                                                                                                                           |

## Rules

- **URL-bound auth.** The URL in the signed text is the exact base URL the
  client dialed, without a trailing slash. The relay checks the signature
  against its own public URL, so a signature captured by another endpoint cannot
  be replayed to it.
- **Keys come from the fold.** The relay folds the roster with
  `@dispatch/federation`'s `foldRoster` (`relay: true`, so it never pauses). It
  verifies every stored log with `verifyLog`, using the key the fold bound to
  that id (FW-R24, FW-R26).
- **Pending machines.** A machine the roster has not admitted connects only if
  its key op carries a proof for an unexpired invite that no other machine has
  used. At most 10 such connections per team and 3 per source address are
  allowed in a minute. A pending machine sees only the founder's `key` and
  `found` ops. The relay stores only its key op and refuses to store anything
  else (FW-R9). A revoked machine is refused.
- **Seats.** Seats come from the roster's `license` op, verified offline against
  `LICENSE_PUBLIC_KEY`. A machine past the seats publishes nothing, because its
  daemon stops before publishing.
- **The `to` rule.** A sealed op (`mail`, `state`) may name any roster replica
  in `to`. It is delivered whole only to admitted replicas in `to`. Every other
  reader gets its stub, so chains still verify.
- **Retention.**
  - A `mail` or `state` op becomes a stub once every admitted recipient has
    acknowledged it. A recipient that is no longer admitted counts as having
    acknowledged it.
  - Any `mail` or `state` op becomes a stub 30 days after it was stored.
  - Only the latest `presence` op per run and per replica is kept whole.
- **Limits.**
  - An op may be at most 1 MiB.
  - A replica may store at most 1,000 ops a minute. The switch-over upload is
    exempt: the switching admin's ops below the seq of the team's
    `transport {kind: 'relay'}` op, and another replica's ops whose `hlc`
    precedes that op's, compared as clocks (milliseconds, then counter), not as
    text.
- **Idempotence.** A stored `(replica, seq)` is never replaced. A second publish
  of the same seq is acknowledged and ignored.

## Switching

When the folded `transport` op names a transport other than the current one, a
daemon switches only once its outbox is empty. That way the op that made the
switch has also reached the old transport. Before switching, it uploads its
whole own log (`fed.ownLog()`, never the git clone) to the new transport, then
stops writing the old one. Switching back to git uses the same op with
`kind: 'git'`. The route that signs the op is refused in each of these cases:

- the legacy window is open;
- the URL is not `wss://`. Every receiver checks this too, before it dials a URL
  the roster names: a plaintext URL leaves it on git with a problem note, since
  dialing would send its log in the clear;
- any admitted machine, or any invitee waiting to be admitted, does not announce
  the `relay` capability. A machine announces it in its key op's `caps`, or
  re-announces it in a `presence` op after an upgrade; one that announces no
  `caps` lacks it (FW-R39);
- the disclosure is unconfirmed.

## Acceptance (Task 21)

The private relay ships when each of these passes:

- [ ] Its CI runs `@dispatch/federation`'s golden vectors
      (`vectors/roster/*.json`, `vectors/chain/*.json`) unchanged.
- [ ] It passes the frame-contract suite ported from
      `packages/server/test/team/federation/relay.test.ts`, run against the real
      service:
  - URL-bound auth;
  - invite-gated pending connections and their limits;
  - the `to` rule;
  - retention, with stubs and the 30-day cap;
  - presence;
  - the switch-over exemption from the rate limit.
- [ ] Seats come from the roster's license, verified offline. The hosted relay
      refuses a team without a license key, and a self-hosted relay runs keyless
      for up to three people.
- [ ] `POST /v1/teams` registers a team from its `found` and founder `key` ops
      and the founder's later `ops`, idempotently, behind an optional
      registration token.
- [ ] Manual F4 exit, on the relay's staging deployment with two of the owner's
      machines:
  - switch the team from git;
  - send mail and see it arrive in under a second;
  - revoke a replica while mail to it is in flight;
  - confirm that no machine is left stuck and that acknowledged mail is gone
    from the store.

It is blocked until `@dispatch/federation` is published (F-D3, cross-plan edit
XF5). Until then the relay repository may build against a pinned `pnpm pack`
tarball of a tagged commit, but F4-B does not ship on it.
