# Dispatch server, phase 7 — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 7 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phase 6.

## Goal

A team has an always-on home that it cannot read. People sign in, join a team,
link their cores, and from then on see each other's work. A team runs the server
itself for free or pays per seat for a hosted one.

**Done when** (the spec's check): two people see each other's sessions and
cannot both claim a task; the server's files hold no readable content.

## Not in this phase

Naming the lead Overseer (phase 12). A web dashboard (there is none). Any
feature that would need the server to read team content.

## Decisions this plan makes

1. **A fresh repository, `dispatch-server`**, Elastic-2.0. It depends on the
   core's `kernel` and `sequence` crates and on nothing else of the core.
2. **The server is the blind home from phase 6**, made multi-team and put behind
   sign-in. It adds accounts; it does not add understanding.
3. **One database file per team**, plus one for accounts.
4. **Hosted and self-hosted are the same binary.** Self-hosting has no billing
   and no seat limit.
5. **The website is four things**: sign in, set up a team, invite, pay.
6. **Run logs are stored sealed and deleted after 30 days.**

## Steps

| #   | Step             | What it adds                                                                              | Test that proves it                                                        |
| --- | ---------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Scaffold         | The repository, license, CI, and a binary that serves a health check                      | CI is green                                                                |
| 2   | Accounts         | Sign in with GitHub or Linear; one person, possibly several sign-in methods               | Signing in two ways lands on one account                                   |
| 3   | Teams            | Create a team, list members, remove a member                                              | A removed member's devices are refused from then on                        |
| 4   | Devices          | A core signs in with a code the person approves on the website; it gets a device token    | A core with a revoked token cannot connect                                 |
| 5   | The link         | The WebSocket over TLS that a core's `link` connects to, checked against the device token | A core from another team cannot reach this team's line                     |
| 6   | Sequencing       | Sealed changes get a number and a time and go to every connected core of the team         | Two cores of one team end with the same board through the server           |
| 7   | Storage          | The sealed log, sealed snapshots, and sealed run logs with their 30-day limit             | Searching every file the server wrote for a known task title finds nothing |
| 8   | Liveness         | The server writes "this device went silent" into the line, in the clear                   | A core that vanishes is marked silent within two minutes                   |
| 9   | Invites          | The server holds the sealed key for an invite and hands it over once                      | An invite cannot be used twice, and the server never sees its secret       |
| 10  | Team isolation   | Each request is bound to one team's database by its sign-in; export and delete a team     | No request, however built, returns another team's rows                     |
| 11  | Seats and Stripe | Seats counted from members; a per-seat subscription; what happens when payment stops      | A team past its paid seats is told, and nothing is deleted                 |
| 12  | Self-host        | A documented way to run it: one container, one volume, no billing                         | A fresh machine serves a team from the published image                     |
| 13  | Website          | Sign in, team setup, invite, billing pages                                                | A new person goes from the invite link to a linked core without help       |
| 14  | Operations       | Backups, limits on request rates and sizes, logs that hold no content                     | A restore from backup serves the same sealed data                          |

## Notes for whoever builds it

- **Accounts already exist** in `apps/web`: `db.ts` (users, teams, members,
  invites, device codes, devices), `server.ts`, `web.ts`, `pages.ts`, and the
  Linear sign-in in `linear.ts`. They are the reference. The team hub
  (`hub.ts`), the hosted MCP endpoint (`mcp.ts`), the machine proxy
  (`machines.ts`) and the hosted planner are not carried over.
- **Today's deployment** is a Railway service with one volume (`apps/web`'s
  README). Step 12's container is the same shape.
- **Paying is never tied to reading.** A team that stops paying loses the hosted
  service after notice, and can export its sealed data and self-host.
- **Logs are a leak.** Request logs must not hold sealed payloads, link secrets
  or tokens. Step 14 has a test for it.
- **Removing a member is two things**: the server stops serving them (step 3),
  and the team's devices start a new key epoch (phase 6). Do both.

## What I have not verified

- Stripe's current way of billing per seat with changing seat counts. Step 11
  starts by reading its documentation.
- Whether one process and one file per team is enough at the size you expect. It
  is the simplest thing that works; a dedicated instance per large team is the
  escape hatch the spec already names.
- What the terms of service and privacy policy need to say. They need writing
  before a team that is not yours uses the hosted service.
