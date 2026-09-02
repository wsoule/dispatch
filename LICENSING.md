# Licensing

Dispatch is open core. This file is the plain-language map of what is licensed
how, and why. The legal texts are the per-package `LICENSE` files and the root
[`LICENSE`](LICENSE); where this summary and a license text disagree, the
license text wins. Decided 2026-08-23.

## The split

| Code                                                                                       | License                                  |
| ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `packages/core`, `packages/client`, `packages/cli`, `packages/mcp`                         | MIT                                      |
| Everything else in this repo (desktop app, `dispatchd` + orchestrator, web/ui, demo, site) | FSL-1.1-ALv2 ([root `LICENSE`](LICENSE)) |
| The team server                                                                            | Commercial, separate private repo        |

Three tiers, one rule each:

- **MIT — the interop surface.** The task model and types (`core`), the daemon
  API client (`client`), the CLI, and the MCP server are how other tools,
  agents, and scripts integrate with Dispatch. We want that integration to
  happen without anyone needing a license review, so these packages are plain
  MIT.
- **FSL — the product.** The desktop app and the daemon/orchestrator are
  source-available under the
  [Functional Source License 1.1, Apache 2.0 Future License](https://fsl.software)
  (`FSL-1.1-ALv2`): read, build, modify, self-host, and redistribute for any
  purpose except shipping a competing product or service — and **each release
  converts to Apache-2.0 two years after it ships**, irrevocably.
- **Commercial — the team tier.** Team features (accounts, presence, claims,
  shared run visibility, web dashboard, audit) live in the team server, which is
  a paid service — hosted by us or self-hosted under a commercial license — and
  is not in this repo. The paid boundary is the server, not license checks in
  this code. See `docs/TEAM-SERVER.md`.

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
  repo, but code here may move across the license boundary (including into the
  commercial server), so we need a contributor license agreement — CLA Assistant
  on the repo, signed once per contributor. DCO is not enough: it proves
  provenance but does not permit relicensing.
- **The name.** "Dispatch" the mark is claimed by the project regardless of what
  the licenses permit you to do with the code. A fork must not present itself as
  Dispatch.
