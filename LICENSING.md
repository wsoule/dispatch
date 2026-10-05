# Licensing

Dispatch is open core. This file is the plain-language map of what is licensed
how, and why. The legal texts are the per-package `LICENSE` files and the root
[`LICENSE`](LICENSE); where this summary and a license text disagree, the
license text wins. Decided 2026-08-23; the team tier moved into this repo, under
the Elastic License 2.0, on 2026-09-23.

## The split

| Code                                                                                                                                 | License                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `packages/core`, `packages/client`, `packages/cli`, `packages/mcp`, `packages/protocol` (with its `federation` wire), `packages/a2a` | MIT                                      |
| `packages/protocol-spec` (the published protocol: DMP text, registries, schemas, vectors, conformance runner)                        | Apache-2.0 (its own `LICENSE`)           |
| Everything else in this repo (desktop app, `dispatchd` + orchestrator, web/ui, demo, site)                                           | FSL-1.1-ALv2 ([root `LICENSE`](LICENSE)) |
| Team features: `packages/federation`, `packages/server/src/team/` and `packages/server/test/team/`                                   | Elastic-2.0 (their own `LICENSE` files)  |

Four tiers, one rule each:

- **MIT — the interop surface.** The task model and types (`core`), the message
  bus (`protocol`), the daemon API client (`client`), the CLI, and the MCP
  server are how other tools, agents, and scripts integrate with Dispatch. We
  want that integration to happen without anyone needing a license review, so
  these packages are plain MIT.
- **FSL — the product.** The desktop app and the daemon/orchestrator are
  source-available under the
  [Functional Source License 1.1, Apache 2.0 Future License](https://fsl.software)
  (`FSL-1.1-ALv2`): read, build, modify, self-host, and redistribute for any
  purpose except shipping a competing product or service — and **each release
  converts to Apache-2.0 two years after it ships**, irrevocably.
- **Elastic License 2.0 — the team tier.** What lets more than one person use
  Dispatch together lives in `packages/federation` and
  `packages/server/src/team/`: teammates' tokens on a shared host, board sync
  between teammates' own machines, and the license key that says how many people
  that may be. Free for up to **three people** with every feature; more needs a
  license key. ELv2 allows use, modification and redistribution, but not moving,
  disabling or circumventing the license key, and not offering the software as a
  hosted service — the two things the FSL's "internal use" grant could not rule
  out, which is why this code is not FSL. See "The team tier, plainly" below.
- **Private: the sealed relay.** The hosted relay that a team may switch to
  instead of a git branch is not in this repo. It stores and forwards signed ops
  and can read nothing that is sealed.
- **Apache-2.0: the published protocol.** Text and tests anyone may implement,
  under Apache-2.0. It makes no patent promise to implementers; that waits for
  the Community Specification License step.

## The team tier, plainly

- **Who counts.** A person is a Dispatch handle (git email → `team.yml`). On a
  shared host: the operator plus everyone holding a live invite. On a team
  founded over board sync: every handle the signed roster admits, however many
  machines each uses, and every handle a member's machine hosts; an admitted
  observer (a read-only machine such as an audit server) is not counted.
- **At the limit.** A fourth invite is refused with the reason (HTTP 402,
  `seat_limit`). If more people hold invites than there are seats — a license
  lapsed, a file edited by hand — the people invited first keep working and the
  rest are told why at sign-in. On a synced board the first people to sync keep
  syncing; anyone past the seats pauses, keeps working locally, and catches up
  when seats are added. Nothing is deleted either way.
- **The key.** An Ed25519-signed `dispatch1.…` string carrying the organization,
  seats and expiry, checked on the machine against the public key in
  `packages/federation/src/license.ts` — no phone-home. On a team, the key is
  shared with every teammate through the signed roster (and with the relay, once
  a team switches to it), so each machine checks the same seats. Install it in
  Settings → License, `dispatch license set <key>`,
  `$DISPATCH_HOME/.dispatch/license.key`, or the `DISPATCH_LICENSE` environment
  variable. An expired or invalid key reads as the free plan with the reason; it
  never locks anyone out.
- **Issuing keys.** `bun scripts/license-keygen.ts <path>` once, to make the
  signing key pair (paste the printed public key into `LICENSE_PUBLIC_KEY`);
  `bun scripts/license-issue.ts --key <path> --org … --seats … [--expires …]`
  per customer. The private key never goes in this repo.
- **What stays FSL.** Everything a person working alone uses, plus the plumbing
  that does nothing without a second person's credential: the permission tiers,
  HTTPS, browser sign-in, presence, teammate previews, the receipt log and its
  push and restore.

## Fine print, stated plainly

- **Releases up to and including v0.13.1 were published under Apache-2.0** and
  remain Apache-2.0 forever.
- **`@dispatch/cli` and `@dispatch/mcp` currently depend on `@dispatch/server`
  (FSL).** The MIT grant covers those packages' own source; a built artifact
  that bundles the daemon includes FSL-licensed code, so the bundle as a whole
  is governed by FSL's terms until that dependency is severed (tracked on the
  board). Talking _to_ a running daemon or MCP server is not affected — using a
  program over its API is not redistribution.
- **Never call the FSL code "open source."** It is source-available; the OSI
  definition does not admit a non-compete. The accurate sentence is: "the
  integration packages are MIT; the app is source-available and becomes Apache
  2.0 two years after each release."
- **Contributions require a CLA.** Outside PRs are welcome on any part of the
  repo, but code here may move across the license boundary (as the team tier
  did, from FSL to ELv2), so we need a contributor license agreement — CLA
  Assistant on the repo, signed once per contributor. DCO is not enough: it
  proves provenance but does not permit relicensing.
- **The name.** "Dispatch" the mark is claimed by the project regardless of what
  the licenses permit you to do with the code. A fork must not present itself as
  Dispatch. An implementation holding a passing DMP conformance report may say
  it "implements the Dispatch Messaging Protocol (DMP) 1.0 (Core)" (or its other
  claims). That nominative use of the protocol's title is the only use of the
  Dispatch mark the protocol grants; it does not license "Dispatch" in a
  product, package or service name.
