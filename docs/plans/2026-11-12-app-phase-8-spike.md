# Dispatch app, phase 8: the spike — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 8 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phase 1 only, so it can
run beside phases 2 to 7.

## Goal

Prove the app's foundations before the real app is built on them. This phase
produces a written decision and throwaway code, not a product.

**Done when** (the spec's check): a native window lists live sessions from the
core, and one JavaScript mod redraws when its file is saved.

## Not in this phase

Any view a person would use. Layouts, keys and settings as files. The app's own
commands. All of that is phase 9, built on what this phase decides.

## Decisions this plan makes

1. **GPUI is decided** (the spec's decision 22). The spike does not reopen it.
2. **A fresh repository, `dispatch-app`.** The native app shares no code with
   today's desktop app, so it does not belong in this repository.
3. **Two weeks, then a decision.** If a question is still open at the end, the
   answer written down is "unknown, and here is what it would take".
4. **The code is thrown away.** Phase 9 starts clean with the decisions.

## Questions the spike must answer

| #   | Question                         | How it is answered                                                                               |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Which GPUI, pinned how           | Build a window on the published library and on the copy herdr ships; record what each needs      |
| 2   | How mods run                     | Run one JavaScript mod with gpui-kit; then sketch the same with a thin layer of our own; compare |
| 3   | Does reload work                 | Save the mod's file; the panel redraws; a broken file keeps the last good panel                  |
| 4   | Can it follow the core           | The window subscribes to the core, takes the snapshot and applies events                         |
| 5   | Can it show a terminal           | One pane attaches to a held terminal, types into it and resizes it                               |
| 6   | Is it fast enough                | Fifteen sessions updating at once, with the frame time measured                                  |
| 7   | Does it build everywhere we ship | A release build on macOS and Linux; what Windows would need                                      |
| 8   | What a mod author sees           | The type file and guide a mod is written against; how an error is reported                       |

## Steps

| #   | Step          | What it adds                                                            | Result                                 |
| --- | ------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| 1   | Window        | An empty native window that opens and closes cleanly                    | Question 1                             |
| 2   | Client        | A small client for the core's API, generated from the schema            | Feeds question 4                       |
| 3   | Sessions list | A list of live sessions that updates from events                        | Questions 4 and 6                      |
| 4   | One mod       | The list drawn by a JavaScript mod loaded from a file                   | Questions 2 and 8                      |
| 5   | Reload        | Watch the file; redraw; keep the last good version on an error          | Question 3                             |
| 6   | Terminal pane | Attach to a terminal from phase 3, or to a stub if phase 3 is not ready | Question 5                             |
| 7   | Builds        | Release builds, sizes and start times                                   | Question 7                             |
| 8   | Decision      | A short document: the answers, what to build on, what it will cost      | Reviewed by Wyat before phase 9 starts |

## Notes for whoever builds it

- **herdr-app is the reference.** Its `Cargo.toml` shows what it builds on: its
  own pinned copies of GPUI and gpui-kit, a JavaScript engine, and Ghostty for
  terminals. `defaults/AGENTS.md` is the guide its mods are written against;
  `defaults/mods/` are real mods of the size intended.
- **The answer to question 2 may be "our own thin layer".** herdr carries
  patches to both libraries, which says they need upkeep. A smaller surface we
  own could be cheaper than a larger one we patch.
- **Question 5 is easy to underestimate.** Showing an agent's terminal well,
  with colors, resizing and scrollback, is most of what makes herdr feel good.
- **Mods are trusted code.** The spike does not try to sandbox them.

## What I have not verified

- Whether gpui-kit is usable outside herdr at all, or assumes herdr's setup.
- Whether GPUI runs acceptably on Windows today.
- How large the app binary gets with a JavaScript engine and a terminal library
  inside it.
