# Dispatch core, phase 12: the Overseer agent — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 12 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phase 7 for teams; the
single-machine parts need only phase 4.

## Goal

Every machine runs an Overseer. Each one tells its own person what needs them
and looks after its own machine's sessions. One at a time, named by the server,
acts for the whole team.

**Done when** (the spec's check): the lead acts once on a stalled task; when its
machine drops, the server names another and it takes over.

## Not in this phase

The rules layer. Who holds what, what collides and what is stalled are already
worked out on every core by phase 2's rules; nothing here adds to them.

## Decisions this plan makes

1. **The Overseer is an agent like any other**: a Claude Code or Codex session
   the core starts in a held terminal, with an Overseer prompt and tools. It is
   not a special process inside the core.
2. **Its tools are ordinary API methods**, read-only over the whole team, plus a
   short list of actions.
3. **Actions on shared work ask its operator first**, through a gate, unless the
   operator has granted that kind of action in advance.
4. **The lead is a fact in the line.** The server writes it for a team; the
   project's home core writes it for one person with several machines.
5. **A team-wide action from a core that is not the lead is refused by the
   rules**, so an Overseer that went offline believing it led does no harm.
6. **It can be turned off**, and a person can decline to lead.

## Steps

| #   | Step             | What it adds                                                                                       | Test that proves it                                                       |
| --- | ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Conversation     | An Overseer conversation a person can talk to; it rolls over to a fresh session when it grows long | A long conversation continues from a recap, and old grants end            |
| 2   | Read tools       | Sessions, claims, runs, tasks and gates across everything this core can see                        | It answers "who is stuck" and "what collides" correctly on a fixture team |
| 3   | Own-machine care | Notice this machine's blocked, stalled and finished sessions; nudge, restart or report             | A stalled local session is reported to its operator once, not repeatedly  |
| 4   | Attention        | "What needs me": gates, reviews and refusals waiting on this person                                | The list matches the open gates addressed to them                         |
| 5   | Actions          | Re-queue, reassign, split a task, start a run; each a gate unless granted                          | A denied action is not taken, and the Overseer is told                    |
| 6   | Grants           | A person allows a kind of action for a while; a grant can be withdrawn                             | An action outside its grants always asks                                  |
| 7   | Willing to lead  | Each core says, in the clear, whether its Overseer is on and willing                               | A core with the Overseer off is never named                               |
| 8   | Naming the lead  | The server picks one connected, willing core by the team's order of preference                     | With the preferred core connected, it is the lead                         |
| 9   | Handover         | A silent lead is replaced within two minutes                                                       | The spec's example: the lead drops and the next core takes over           |
| 10  | Refusing others  | The rules refuse a team-wide action from a core that was not the lead at that point                | A core that acts after losing the lead is refused, and it is told why     |
| 11  | Cost             | What the Overseer spent, per person; a cap                                                         | An Overseer at its cap stops thinking and says so                         |

## Notes for whoever builds it

- **Today's Overseer is the reference**: `packages/server/src/orchestrator/`
  `overseer.ts`, `overseerTools.ts`, `overseerGrants.ts`, `overseerHold.ts`,
  `overseerPrompt.ts`, `overseerStore.ts` and the `overseers/` adapters. The
  rollover at 150,000 tokens, the grants and the action gate all carry over.
- **Step 1 depends on phase 4's adapters.** The Overseer is one more thing the
  runner can start, so it gets approvals, cost and resume for free.
- **The lead has no extra reach.** It reads what every member's core reads and
  holds no special key. Leading only means its agent is the one that thinks
  about team-wide events.
- **A team that wants the cost shared** runs an always-on core of its own with a
  team model key and puts it first in the order of preference.
- **Steps 7 to 10 need a change on the server**, in `dispatch-server`: reading
  the willing flag and writing the lead. It is small and reads no content.

## What I have not verified

- How well an agent CLI serves as a long-lived Overseer, compared with today's
  in-process one. Step 1 will show it.
- Whether "connected longest" is a good default when a team sets no order.
- How noisy step 3 is in practice. Reporting too often will get it turned off.
