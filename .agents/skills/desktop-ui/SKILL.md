---
name: desktop-ui
description:
  Use when building or changing any UI in apps/desktop (views, components,
  pages, peeks, menus, rows, buttons) or in packages/ui-legacy.
---

# Desktop UI

Every interactive element and repeated pattern in `apps/desktop` comes from
`packages/ui-legacy`, imported as `@/ui/*`. Do not hand-roll a `<button>`, row,
toggle, card or menu with one-off Tailwind; that is what made the Two views beta
feel inconsistent. `packages/ui-legacy` (`@dispatch/ui-legacy`) is the shadcn
library that used to live at `packages/ui`; the new `@dispatch/ui` landing at
`packages/ui` will be Better-Tracker's library.

## The app shell

The frame around every view is `@dispatch/ui`'s `AppShell` (sidebar with the
destinations and the Projects section, topbar with crumbs and search), mounted
by `apps/desktop/src/components/shell/DispatchShell.tsx` and fed by the pure
adapters in `src/adapters/shell.ts` and `src/lib/shellRoutes.ts`. New shell and
adapter code uses `@dispatch/ui` (its components, tokens and a CSS module beside
the component), never Tailwind or `@/ui` (ui-legacy). The rest of this skill
describes the legacy library the views still use; it is rewritten when
`packages/ui-legacy` is deleted.

## Where to look first

- **shadcn primitives** (`packages/ui-legacy/src/*.tsx`): `Button` (variants
  `default` · `secondary` · `outline` · `ghost` · `link` · `destructive`; sizes
  `xs` · `sm` · `default` · `lg` · `icon-xs` · `icon-sm` · `icon` · `icon-lg`),
  `ToggleGroup`, `Tooltip`, `Badge`, `Collapsible`, `ScrollArea`,
  `DropdownMenu`, `Popover`, `Command`, `Sheet`, `Dialog`, `Tabs`, `Kbd`,
  `Separator`, `Empty`, `Skeleton`, `Textarea`, `Avatar`.
- **App-level components** (`packages/ui-legacy/src/ai/*`): `IconButton`, `Pill`
  and `PillButton`, `PageHeader`, `GroupHeader`, `ListRow`, `TaskRows`,
  `Segmented`, `ToolChip`, `ApprovalCard`, `PromptBar`, `Search`,
  `SelectionActions`, `Switch`, `InitialsAvatar`, `Thinking`.

## Rules

- **Reach for the library first.** Search `packages/ui-legacy` before writing
  markup; an icon-only control is `IconButton` with a `label`, a text action is
  `Button` (usually `ghost`/`link`, `xs`/`sm`), a status chip is `Pill` or
  `Badge`, a choice of two or three is `Segmented` or `ToggleGroup`, a hint is
  `Tooltip`.
- **Missing variant? Add it to `packages/ui-legacy`,** as a named variant or a
  small component, and use it everywhere it applies. Never restyle a primitive
  locally to get a one-off look.
- **Keep the shared scale:** row heights, paddings, radii (`rounded-control`,
  `rounded-card`, `rounded-pill`) and text sizes come from the primitives, so
  neighbouring surfaces line up.
- **Accessibility comes with the primitive:** focus rings, `aria-*` and keyboard
  behaviour. Keep accessible names and `data-testid`s stable when swapping
  markup, or update the tests deliberately.
- **Review before merging:** `grep -n "<button" <changed files>`. Each hit needs
  a reason the library could not cover it.
