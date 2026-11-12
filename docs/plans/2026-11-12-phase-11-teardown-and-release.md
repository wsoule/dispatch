# Phase 11: teardown and release — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 11 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phases 7, 9 and 10.

## Goal

The new Dispatch replaces the old one. People install it, Wyat's own work moves
onto it, and everything it replaced is retired.

**Done when**: a person installs the core with one command and the app from a
download, with nothing from this repository involved; federation, board sync,
the machine hub, the old daemon and the old app are no longer shipped.

## Not in this phase

New features. The Overseer agent (phase 12) can come before or after.

## Decisions this plan makes

1. **Parity is a written list, signed off**, not a feeling. Step 1 makes the
   list from what today's Dispatch does; each line is "kept", "changed" or
   "dropped on purpose".
2. **This repository is archived, not deleted.** It stays readable as the
   reference and the history.
3. **The core takes the name `dispatch`** here, when the old CLI is gone.
4. **Nothing is retired until Wyat has worked on the new one for two weeks.**

## Steps

| #   | Step               | What happens                                                                               | Done when                                                        |
| --- | ------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1   | Parity list        | Every feature of today's Dispatch, marked kept, changed or dropped                         | Wyat has read and agreed the list                                |
| 2   | Release pipeline   | Signed builds of the core and the app for each system; checksums; an update check          | A tagged commit produces installable builds without a person     |
| 3   | Installers         | An install script and a package-manager entry for the core; a download for the app         | A clean machine goes from nothing to a running board in minutes  |
| 4   | Updates            | `dispatch update` for the core; the app updates itself; running agents keep running        | An update with three agents running loses none of them           |
| 5   | Move Wyat's work   | Import each project (phase 2's import), link machines, start a team on the server          | Two weeks of real work on the new one                            |
| 6   | Rename             | `dispatch-core` becomes `dispatch`                                                         | The old CLI is uninstalled and the name is free                  |
| 7   | Plugin             | `dispatch-plugin` points at the new MCP                                                    | A fresh Claude Code install with the plugin reaches the new core |
| 8   | Published packages | The npm packages get a final version that says where Dispatch went, then are deprecated    | Installing an old package prints the notice                      |
| 9   | Protocol           | A new version of the published protocol without federation, or a notice that it is retired | The spec's readers are not left with a dead document             |
| 10  | Hosted services    | The old hosted site, the team hub and the sealed relay are switched off                    | Nothing of the old system is running                             |
| 11  | Words              | The website, the docs, the license page and the privacy policy describe the new system     | No page promises something the new system does not do            |
| 12  | Archive            | This repository and `dispatch-log` are made read-only with a notice at the top             | A visitor is sent to the new repositories                        |

## Notes for whoever does it

- **The privacy policy changes meaning, in the user's favor.** Today's says a
  relay can read the board unless a team turns encryption on. The new one says
  the host reads nothing a team shares. It also has to say plainly what the host
  can see: who is on a team, their devices, when they connect, and sizes.
- **What was dropped on purpose** belongs in the parity list and in the release
  notes: the web dashboard, claude.ai sessions hosted on the server, git-only
  teams, the A2A bridge for now.
- **Step 4 is the promise the new design makes.** If an update kills running
  agents, the holders from phase 3 are not finished.
- **Step 10 is not reversible in practice.** Do it last, after step 5's two
  weeks.

## What I have not verified

- What signing and notarizing the app needs on each system, and what it costs.
- Whether anyone other than Wyat depends on the published npm packages or the
  hosted site today. The answer changes how much notice steps 8 and 10 need.
- What the sealed relay (`wsoule/dispatch-relay`) still does. It was not visible
  from the session that wrote this plan.
