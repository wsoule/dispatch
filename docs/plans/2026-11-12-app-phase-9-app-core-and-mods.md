# Dispatch app, phase 9: app core and mods — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 9 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phases 2 to 4 and the
decisions from phase 8.

## Goal

A native app a person can do their work in. Its own core is small, and every
panel, menu and dialog is a mod kept as a file they can change.

**Done when** (the spec's check): the board, task page and sessions list run as
native mods; a layout file rearranges the window live.

## Not in this phase

Team features that need the server (they light up as phase 7 lands; nothing here
waits for them). The phone app, which stays its own small client.

## Decisions this plan makes

1. **Two programs.** `dispatch-app` is the window; the core runs the work. The
   app finds a running core or offers to install one.
2. **The app core is five things**: the model it gets from the core, layout
   documents, commands, keys, and the mod API. Anything else must pass herdr's
   three questions or it is a mod.
3. **The interface is files** in one app folder: `layouts/`, `mods/`,
   `keys.json`, `settings.json`.
4. **Shipped and personal copies.** Shipped files are replaced on update; a
   person duplicates one to change it and that copy is never overwritten.
5. **The first four mods decide the mod API**: sessions list, terminal pane,
   board, task page. The API is frozen for others only after those four are
   comfortable to write.
6. **Mods are trusted code** with the person's access to the core.

## Steps

### A. The app core

| #   | Step           | What it adds                                                                                           | Test that proves it                                                      |
| --- | -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1   | Client         | The generated client for the core's API; snapshot, then events                                         | The app's model matches the core's after any sequence of events          |
| 2   | Finding a core | Use the running core; start an installed one; offer to install when there is none                      | The app opens usefully on a machine with no core                         |
| 3   | Mod host       | Load a mod from a folder; draw it; reload on save; keep the last good version on an error              | A broken edit leaves the old panel and writes the reason beside the file |
| 4   | Layouts        | A layout file says which mods sit where, and the theme                                                 | Editing the file rearranges the open window                              |
| 5   | Commands       | Every action is a named command with typed arguments; mods and keys call the same ones                 | The command list is generated and matches what runs                      |
| 6   | Keys           | `keys.json` maps keys to commands; one key nothing can rebind returns to the default layout            | A key file that binds everything away is still escapable                 |
| 7   | Settings       | `settings.json`: fonts, zoom, sounds                                                                   | A change applies without a restart                                       |
| 8   | Shipped files  | Shipped layouts and mods written on start; edited ones moved to personal copies                        | An update never overwrites a person's copy                               |
| 9   | Driving it     | `dispatch-app status`, `ls`, `commands`, `check <mod>`, `shot`; a guide and type file written on start | An agent adds a panel using only the guide and the commands              |

### B. The mods

| #   | Mod                             | Replaces today                                 | Notes                                                      |
| --- | ------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| 10  | Sessions list                   | `SessionsHubView`, `AllAgentsView`, `LiveView` | Every session with its status; blocked ones first          |
| 11  | Terminal pane                   | `TerminalsView`                                | Attach, type, resize, scroll back                          |
| 12  | Board                           | `IssuesView` and its table                     | List and board; filters; "not yet synced" marks            |
| 13  | Task page                       | The task peek and page                         | Fields, comments, findings, the task's thread and its runs |
| 14  | Run view                        | The run chat and diff                          | The run log live; approvals answered in place; the diff    |
| 15  | Gates                           | The gate cards                                 | Every question waiting on this person, answerable anywhere |
| 16  | Threads                         | The Threads view                               | Mail and channels                                          |
| 17  | Palette, menus, dialogs, toasts | The command palette and overlays               | Mods like any other; nothing in the frame is special       |
| 18  | Settings and first run          | `SettingsView`, `SetupView`, `FirstRunView`    | Includes adding a machine and joining a team               |
| 19  | Projects, graph, timeline       | `ProjectsView`, `GraphView`                    | After the first four have settled the API                  |
| 20  | Docs and files                  | `DocsView`, `FilesView`                        | Needs phase 10 for docs                                    |
| 21  | Pull requests                   | `PrReviewView`                                 | Needs phase 10                                             |
| 22  | Overseer                        | `OverseerView`                                 | Needs phase 12                                             |

## Notes for whoever builds it

- **herdr-app is the reference** for part A: its `AGENTS.md` (the three
  questions and what ships in the box), `defaults/AGENTS.md` (the guide written
  into every user's folder), `docs/mods.md` and `docs/security.md`.
- **Today's app is the reference for what each mod does**, not how:
  `apps/desktop/src/views/` and `components/` (about 110,000 lines without
  tests). The desktop design rules in `docs/ARCHITECTURE.md` (status colors,
  contrast, the keyboard map) carry over as the default theme and key file.
- **A mod is small.** If one grows past a few hundred lines, something it needs
  is missing from the mod API, or it is two mods.
- **Nothing a mod shows is the app's own state** unless it passed the three
  questions. Mods keep their state in their own storage.

## What I have not verified

- Everything phase 8 is there to answer. This plan assumes its answers are "yes,
  with these libraries".
- How long 110,000 lines of views take to rebuild as native mods. The first four
  will give a real rate; planning the rest before then is guessing.
- Whether the phone app can stay as it is. It talks to today's daemon through a
  relay, and needs pointing at the new API.
