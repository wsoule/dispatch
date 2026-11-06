---
name: desktop-ui
description:
  Use when building or changing any UI in apps/desktop (views, components,
  pages, peeks, menus, rows, buttons) or in packages/ui.
---

# Desktop UI

## The library

`@dispatch/ui` (`packages/ui`) is the only component library. Every interactive
element and repeated pattern comes from it, or from a Dispatch product component
built on it. Icons come from `lucide-react`. `packages/ui/README.md` is the
reference: Styles (page mode; scoped mode is for other hosts), Theme, Fonts,
Status vocabulary, Components, Lists, Timeline options, Shell options for a
desktop host, Task detail slots, the workspace switcher, Edit controls,
Controls, Browser behaviour hosts should know about, Server rendering, Checks.

## The app shell

`AppShell` is mounted by `apps/desktop/src/components/shell/DispatchShell.tsx`
and fed by the pure adapters in `src/adapters/` (`shell.ts`, `palette.ts` and
the rest) and `src/lib/shellRoutes.ts`. Paths below are under
`apps/desktop/src/`.

- Sidebar destinations: Overseer, Issues, Needs you, Timeline, Graph, Threads,
  Docs, Runs (it opens Settings' runs page), Settings, plus the Projects
  section. Projects also appear as workspaces in the brand-row switcher.
- Settings is an overlay place in the main column (`views/SettingsView.tsx`,
  `components/settings/SettingsLayout.tsx`, `lib/appNav.ts`); Escape returns to
  where you were.
- Palette rows come from `adapters/palette.ts` and `lib/paletteEntries.ts`.
  Quick open is a global command (`lib/keyboard.ts`): ⌘P on macOS, where Ctrl+P
  keeps its text meaning and is never claimed, and Ctrl+P elsewhere.
- The theme is stored per origin under `dispatch:theme` (`lib/theme.ts`,
  `hooks/useThemeChoice.ts`).

## Where to look first

| Need                | Use                                                                               |
| ------------------- | --------------------------------------------------------------------------------- |
| action              | `Button` (variants, `busy`, icon-only with `aria-label`)                          |
| status or label     | `Chip` (`tone`, `hue`) or `ChipButton`                                            |
| menu or picker      | `PickerPopover` (single, multi, actions, `onCreate`)                              |
| actions menu        | `Menu` (radio rows, one submenu level)                                            |
| floating panel      | `Popover`                                                                         |
| hint                | `Tooltip`                                                                         |
| form over a page    | modal `SlideOver`                                                                 |
| short focused form  | `Dialog`                                                                          |
| destructive confirm | `ConfirmDialog`                                                                   |
| choice of 2–4       | `SegmentedControl`                                                                |
| rows                | `Register`, `ListItem`, `TaskGroupTable`                                          |
| section             | `SectionHeader`, `Panel`                                                          |
| fold                | `Disclosure`                                                                      |
| text input          | `TextField`, `TextArea`                                                           |
| fields              | `Field`, `Select`, `RadioGroup`, `Switch`, `Checkbox`, `SearchField`, `CopyValue` |
| command list        | `CommandPalette`                                                                  |
| counts row          | `StatsStrip`                                                                      |
| empty               | `EmptyState`                                                                      |
| loading             | `Skeleton`                                                                        |
| in-flight           | `Spinner`                                                                         |
| notices             | `Notice`, `AlertStrip`                                                            |
| code                | `CodeBlock`                                                                       |
| glyphs              | `StateGlyph`, `ProgressPie`, `PriorityGlyph`                                      |

Dispatch components (under `apps/desktop/src/components/`): `PageHead`
(`shell/PageHead.tsx`), `PromptBar` (`chat/PromptBar.tsx`), the transcript
family (`transcript/`: `ToolChip`, `StreamingText`, `ThinkingTrace`,
`ShimmerLabel`), `DecisionCard` and `ToolApprovalCard` (`gates/`), `StateMark`
and `StepStrip` (`status/`), `TaskComposerSlideOver` and `DispatchDialog`
(`tasks/`), `RawText` and `RawDetails` (`gr8r/RawText.tsx`, for raw command
output).

Tone helpers (under `apps/desktop/src/`): `feedStateTone` (`lib/feedState.ts`),
`sessionStatusTone` (`components/sessions/sessionDisplay.ts`), `statusTone` and
`BLOCKED_TONE` (`lib/statusTone.ts`), `phaseTone` (`lib/milestoneSession.ts`),
`mergeLadderTone` (`lib/mergeLadder.ts`), `STATE_TONE`
(`components/runs/PrStatusPills.tsx`), `findingTone` (`lib/findings.ts`),
`docBadgeTone` (`lib/docs.ts`), `messageBadgeTone` (`lib/threadSources.ts`).

## Rules

The binding design rules (tokens, the status hue table, contrast, forced
colours, motion, type, theme, overlays, slide-over versus full page, the
keyboard map) are in `docs/ARCHITECTURE.md` "Desktop design system".

- **Reach for the library first.** Search `packages/ui` before writing markup.
- **Missing variant? Add it to `packages/ui`,** with a test and a README line,
  and use it everywhere it applies. Never restyle a primitive locally.
- **Keep the shared scale:** row heights, paddings, radii and text sizes come
  from the primitives and the tokens, so neighbouring surfaces line up.
- **Accessibility comes with the primitive:** focus rings, `aria-*`, roles and
  keyboard behaviour. Keep accessible names, `data-testid` and `data-slot`
  (through `DataAttributes`) stable, or update the tests deliberately.
- Style with CSS modules on tokens. No hex outside
  `packages/ui/src/styles/tokens.css` (`lib/terminalPalette.ts` is exempt), and
  no retired token names.
- Status colour only through `UiTone`, `data-tone` and `.toneText`, on the hue
  table in `packages/ui/README.md` "Status vocabulary": red overdue and failed;
  amber at risk, blocked, missing input and waiting on you; green on track,
  succeeded and review; blue in progress and live; grey paused and inactive.
  Merged and done are the filled neutral mark, never green or purple. The accent
  never means a status.
- Geist in sentence case. Mono only for machine-read strings (ids, keys, paths,
  commands). Tabular `.num` for counts.
- Shadows only on floating things. `Spinner` only for in-flight work, `Skeleton`
  for loads, and a save shows the new value.
- Escape handlers call `preventDefault()` and `stopPropagation()`; document
  listeners check `defaultPrevented`. Modal surfaces set `aria-modal="true"` so
  `useGlobalKeyboard` (`hooks/useGlobalKeyboard.ts`) stays quiet.
- Overlays render in place on the layer stack
  (`packages/ui/src/shell/layer.ts`), never in a portal. Floating layers
  (`Popover`, `PickerPopover`, `Menu`, `Tooltip`, `Dialog`) use the browser's
  top layer; a modal panel over a scrim uses `useModalSurface`
  (`shell/modal-surface.ts`, as `SlideOver` does) and stays out of it.
- Review before merging: `grep -n "<button\|style={{" <changed files>`. Each hit
  needs a reason the library could not cover it.
- `apps/desktop/src/styles/gr8r-rules.test.ts` scans every file under
  `apps/desktop/src`: hex, retired tokens, unresolved `var()` reads, legacy
  imports, utility classes, removed focus outlines and uppercase text (the
  library's `.eyebrow` is the one uppercase voice).
