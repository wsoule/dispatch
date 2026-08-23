# Business

How Dispatch makes money. Supersedes
`docs/archive/design/open-source-monetization.md`, which was written against a
git-native multiplayer assumption; the pivot to a team server
(`docs/TEAM-SERVER.md`) changes the enforcement story, so this rewrite is the
current plan. Written 2026-08-23.

## The narrative

Dispatch is a commercial product with a genuinely free, genuinely local solo
tier. The team tier is a server — hosted by us or self-hosted under license —
and the server is the paid boundary.

- **Free — solo.** One developer, their machine, their API key. Everything that
  exists today: tasks, runs, review, merge queue, MCP, CLI. No account. This is
  the adoption engine and it never gets worse.
- **Team — the server.** Presence, claims, run visibility across machines, task
  mirror, web dashboard (phases 1–4 in `TEAM-SERVER.md`). $25–40/seat/mo.
- **Enterprise.** Self-hosted server, SSO/SAML, audit export, roles, retention
  controls (phase 5). Annual, $15–25k floor.

The enforcement lever is structural, not legal: team features require the
server, and the server is ours. No license checks in the client to strip out, no
forkable moat. This is why the licensing question (below) got simpler.

## Licensing

- **The repo is private today; the license is FSL-1.1-ALv2.** Whether to publish
  the source at launch is the real decision. With the moat in the server there
  is little left to protect by keeping the client closed, and readable source is
  most of the answer to "why should we trust a one-person vendor's daemon on our
  laptops." Staying closed is viable — distribute binaries from a public
  releases-only repo — but it costs the trust story. Decide once, at launch —
  not by drift.
- **The team server is commercial and private** — separate repo, consuming
  published `@dispatch/core` (open decision §7.3 in `TEAM-SERVER.md`).
- **Consider MIT for `@dispatch/mcp`** so any agent can drive Dispatch through
  its tools. With tasks leaving markdown (`TEAM-SERVER.md` §3) the MCP tool
  surface, not a file format, is the interop layer worth opening.
- **CLA before outside PRs land** (CLA Assistant, not DCO) — still required
  while the client is source-available and code may move across the license
  boundary into the server.
- Never call FSL code "open source." "Source available, becomes Apache 2.0 in
  two years" is accurate and survives scrutiny.

## What the server tier costs us

Real COGS and obligations arrive with the pivot — the old plan's near-zero
marginal cost is gone:

- Hosting, on-call, and identity/auth for the hosted tier.
- **We now hold customer data** — presence, task mirrors, and (pending
  `TEAM-SERVER.md` §7.2) run transcripts containing code excerpts. "Nothing
  leaves the machine" survives only for the solo tier; the team story must be
  "code and keys never leave, coordination data does, and you can self-host."
  Self-hostable from day one is what keeps enterprise deals alive for a
  one-person vendor.
- Eventually SOC 2 for the hosted tier. Self-host is the interim answer.

## The employer deal

Unchanged from the previous plan, still the top of the list:

1. Written IP acknowledgment that Dispatch is yours — employment agreements
   commonly assign "related to the company's business," and a dev tool plausibly
   qualifies.
2. A real contract, not a manager's verbal yes.
3. Permission for a named case study with numbers. The reference is worth more
   than the subscription — and now it's also the design-partner template.

## Go-to-market

Target: **five paying design partners** before phase 2 of the server exists. A
design partner pays something real (even $500/mo), has 3+ devs actually running
coding agents, and takes a weekly 30-minute call. Qualifying question: have they
already lost an afternoon to two agents touching the same file?

Channels, in order of expected conversion:

1. Warm graph — 20 named-intro asks ("who owns AI tooling budget at your
   company?"), targeting 8 discovery calls.
2. The employer case study, published.
3. Practitioner answers where the pain is discussed (Claude Code / Cursor /
   aider communities, HN) — mention Dispatch once, at the end.
4. Operational writing: declared writes, scope escalation, verify gates, budget
   caps, agent audit trails. "How do you govern multiple coding agents on one
   repo" has search volume and no good answers, and it reaches the buyer
   (engineering managers). Compounding channel.

Skip for now: cold email, ads, conferences, Product Hunt.

Instrumentation gap: still no analytics and no waitlist. Minimum fix is a
landing page on `apps/site` with a Teams waitlist (email, company, team size) —
that both measures demand and produces the outbound list.

## Sequencing rule

Phases 1–2 of the server (connect, presence, run visibility) are small enough to
build for the employer alone. **Do not build phase 3+ until at least three more
design partners have paid.** The waitlist plus warm-graph motion decides whether
that happens; if it can't produce three teams, that is the signal, and it is
cheap.

## Risks

- One person now owns a product _and_ a service. On-call for someone else's team
  board is a different life than shipping a desktop app. Self-host reduces this;
  it does not remove it.
- The runner layer is being commoditized by model vendors. Durable assets: the
  policy/audit/coordination layer, the task format, and the recorded history of
  what agents did and why. Weight the roadmap there.
- Never remove a shipped feature from the free tier; add to paid instead.
