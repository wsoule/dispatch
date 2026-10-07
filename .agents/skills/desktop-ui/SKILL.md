---
name: desktop-ui
description:
  Use when building or changing any UI in apps/desktop (views, components,
  pages, peeks, menus, rows, buttons) or in packages/ui.
---

# Desktop UI

Every interactive element and repeated pattern in `apps/desktop` comes from
`packages/ui`, imported as `@/ui/*`. Do not hand-roll a `<button>`, row, toggle,
card or menu with one-off Tailwind; that is what made the Two views beta feel
inconsistent.

## Where to look first

- **shadcn primitives** (`packages/ui/src/*.tsx`): `Button` (variants `default`
  · `secondary` · `outline` · `ghost` · `link` · `destructive`; sizes `xs` ·
  `sm` · `default` · `lg` · `icon-xs` · `icon-sm` · `icon` · `icon-lg`),
  `ToggleGroup`, `Tooltip`, `Badge`, `Collapsible`, `ScrollArea`,
  `DropdownMenu`, `Popover`, `Command`, `Sheet`, `Dialog`, `Tabs`, `Kbd`,
  `Separator`, `Empty`, `Skeleton`, `Textarea`, `Avatar`.
- **App-level components** (`packages/ui/src/ai/*`): `IconButton`, `Pill` and
  `PillButton`, `PageHeader`, `GroupHeader`, `ListRow`, `TaskRows`, `Segmented`,
  `ToolChip`, `ApprovalCard`, `PromptBar`, `Search`, `SelectionActions`,
  `Switch`, `InitialsAvatar`, `Thinking`.

## Rules

- **Reach for the library first.** Search `packages/ui` before writing markup;
  an icon-only control is `IconButton` with a `label`, a text action is `Button`
  (usually `ghost`/`link`, `xs`/`sm`), a status chip is `Pill` or `Badge`, a
  choice of two or three is `Segmented` or `ToggleGroup`, a hint is `Tooltip`.
- **Missing variant? Add it to `packages/ui`,** as a named variant or a small
  component, and use it everywhere it applies. Never restyle a primitive locally
  to get a one-off look.
- **Keep the shared scale:** row heights, paddings, radii (`rounded-control`,
  `rounded-card`, `rounded-pill`) and text sizes come from the primitives, so
  neighbouring surfaces line up.
- **Accessibility comes with the primitive:** focus rings, `aria-*` and keyboard
  behaviour. Keep accessible names and `data-testid`s stable when swapping
  markup, or update the tests deliberately.
- **Review before merging:** `grep -n "<button" <changed files>`. Each hit needs
  a reason the library could not cover it.
