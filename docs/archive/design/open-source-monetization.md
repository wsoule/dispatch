# Open Source + Monetization: Plan

Working plan for keeping Dispatch source-available while selling it to teams.
Written 2026-08-22. Status: nothing here is started.

## Where things stand

- `LICENSE` is FSL-1.1-ALv2 (source-available, non-compete, converts to Apache
  2.0 after two years). The whole monorepo is under it.
- No contributor agreement of any kind is in place.
- No product analytics anywhere — we have no idea who runs Dispatch.
- `apps/site` is a bare static server with no landing page.
- One likely paying team (the author's employer), on a handshake.

## The paid/free line

**Free = one developer, on one machine. Paid = more than one person, or a
machine you don't own.**

Everything shipped today is single-player and stays free forever: task files,
CLI, MCP server, `dispatchd`, worktree isolation, verify gates.

Paid tier is only things that are inherently server-shaped, so gating them isn't
a rug-pull:

- Coordination — shared run history, who's-running-what dedupe, assignment
  across humans and agents, merge queue for agent branches, review routing.
- Governance — org policy (allowed `writes` paths, model allowlists, mandatory
  verify gates), audit log of agent actions, retention, SSO/SAML/SCIM, RBAC.
- Spend control — pooled org billing with centralized `maxBudgetUsd` caps and
  per-team spend reporting. BYO key stays free.
- Managed remote runs — per-run sandboxes (see `lovable-direction.md`), priced
  at cost plus margin.

Never gate: task counts, the file format, the CLI, seats on the local app. Never
remove something from the free tier once shipped there.

## Legal and licensing

- [ ] **Set up a CLA before any outside PR lands.** CLA Assistant on the repo.
      Not DCO — DCO proves provenance but does not let us relicense, and the
      plan depends on moving code across a license boundary. Retrofitting means
      emailing every past contributor and rewriting the code of anyone who
      doesn't reply.
- [ ] Split the licenses:
  - MIT or Apache 2.0 — the `.dispatch/tasks/*.md` format spec, `packages/cli`,
    `packages/mcp`, `packages/core`, `packages/client`. These want maximum
    adoption; other agents reading our task format is the point.
  - FSL (as today) — `apps/desktop`, `packages/server`, the orchestrator.
  - Commercial — the team/cloud server, in a separate private repo from day one.
    Untangling an `ee/` directory later is miserable.
- [ ] Write `LICENSING.md` explaining the split in plain language.
- [ ] Stop saying "open source" for FSL code. Say "source available (FSL —
      becomes Apache 2.0 in two years)". Accurate and survives scrutiny.
- [ ] Look into trademarking the name. The license doesn't stop a confusing
      fork; the mark does. Caveat: "Dispatch" is generic and may not be
      registrable — check before spending on it.

## The employer deal

- [ ] Get written acknowledgment that Dispatch IP is the author's. Most
      employment agreements assign work created on company time or "related to
      the company's business" — a dev tool built by a dev at a software company
      plausibly falls inside that clause.
- [ ] Get a real contract, not a verbal yes from a manager. It evaporates at
      procurement.
- [ ] Get permission to write them up as a named case study with numbers — hours
      saved, rework avoided, agent spend brought under a cap. The reference is
      worth more than the subscription.

## Finding more teams

Goal is **five design partners**, not volume. A design partner pays something
real (even $500/mo), has more than three devs actually running coding agents,
and takes a 30-minute call weekly. Twenty free-tier logos teach us nothing.

Qualifying question: have they already had the moment where two agents touched
the same file and someone lost an afternoon untangling it? If not, they won't
buy.

Channels, in order of what actually converts:

- [ ] Ask 20 people in the warm graph for a **named** intro — ex-colleagues who
      moved on, open source collaborators, the employer's vendors and partners.
      "Who owns the AI tooling budget at your company?", not "let me know if you
      hear of anyone."
- [ ] Publish the employer case study.
- [ ] Answer the "how do you stop three agents stepping on each other" question
      wherever it comes up (Claude Code / Cursor / aider communities, HN,
      Lobsters) as a practitioner. Mention Dispatch once, at the end.
- [ ] Write up the operational ideas as standalone posts — declared `writes`
      paths, human-gated scope escalation, verify gates, budget caps, audit
      trails for agent actions. "How do you govern multiple coding agents on one
      repo" is a real search with almost no good content, and it targets
      engineering managers, who are the buyers. This is the compounding channel.

Skip at this stage: cold email, paid ads, conferences, Product Hunt.

Sales angle worth leading with: enterprise security review kills most one-person
vendors, and we mostly dodge it. Nothing leaves the machine, no account, runs
against their checkout with their key. "There's nothing to review, it's a local
binary" is an opening the cloud agent platforms can't make.

## Fix the "who is using this" blind spot

Local-first is great positioning and terrible for go-to-market. Least invasive
first:

- [ ] Put a real landing page on `apps/site` with a **Teams waitlist** — email,
      company, team size. Zero product code, immediate signal, and it measures
      demand for the team server before we build it.
- [ ] Consider an optional, clearly-disclosed anonymous install ping. Off by
      default or prompted on first run. Being loud about opt-in defuses most of
      the backlash.
- [ ] Mine what already exists: GitHub issue authors, stargazers, anyone who
      emails. Look up their employer — that's the outbound list.

## Pricing shape (draft)

| Tier         | Price                     | Contents                             |
| ------------ | ------------------------- | ------------------------------------ |
| Free         | $0 forever, BYO key       | Everything local and single-player   |
| Team         | $25–40/seat/mo            | Coordination, pooled billing, policy |
| Enterprise   | Custom, annual, $15–25k+  | SSO, on-prem, audit export           |
| Managed runs | Metered, cost plus margin | Add-on to a seat                     |

Comparables: Copilot Business $19, Graphite ~$20, Linear $8–14. Top of the band
is defensible because the thing being governed — token spend — is itself
expensive.

## Next 30 days

1. CLA set up, licenses split, `LICENSING.md` written.
2. Employer IP and contract settled in writing.
3. Waitlist page live.
4. 20 intro asks out, 8 discovery calls booked.
5. Two operational posts published.
6. 3–5 paid design partners under an agreement that trades a discount for weekly
   feedback, a logo, and a case study — contractually, not as a favor.

**Do not write a line of team-server code until design partners exist.** If five
teams can't be found from a warm graph plus two good posts, that's real signal
about the bet, and it's much cheaper to learn now.

## Risks

- Local-first is a strong free product and a weak paid one. "No account, no
  server, nothing uploaded" is the best marketing line today and it directly
  contradicts what we'd sell. The story has to be: OSS stays local-only, the
  team plane is opt-in and self-hostable. The free product must not start
  phoning home.
- The runner layer is being commoditized fast by the model vendors. The durable
  asset is the policy/audit/coordination layer and the task format, not the
  worktree orchestration. Weight the roadmap accordingly.
