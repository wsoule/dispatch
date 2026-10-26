# @dispatch/ui

React components for the task UI in Gr8r Studio's layout and look (sidebar
shell, command palette, grouped task lists, Gantt timeline, slide-over drawer;
warm neutral surfaces, soft borders, radius, soft shadows only on floating
things, tinted status colours, sentence-case Geist), with one purple accent
`#9747ff` in Gr8r's accent role (owner decision 2026-10-23;
`docs/architecture.md` §8.2). It was written in Better-Tracker, the Milestone
Planner (a Next.js host, "the planner" below), and moved here with that
project's sunset; the Dispatch desktop app (Vite + Tauri) is its host now.

The package has no framework or domain coupling: no `next/*`, no imports from
another workspace package, no `process.env`, and no `window`/`document` read
during render. Every prop is plain data plus callbacks, and links render through
a component the host injects.

## What a host needs

- **React 19.2** (`react` and `react-dom` are peer dependencies).
- **A bundler that compiles TypeScript source and CSS modules.** There is no
  `dist`: `exports` points at `src/index.ts`, and component styles are
  `*.module.css` files next to each component. Vite handles both natively (Next
  would need `transpilePackages: ['@dispatch/ui']`). The `'use client'`
  directives are for Next and are ignored by Vite.
- **Runtime dependencies** `lucide-react` (icons) and `@dagrejs/dagre` (graph
  layout), installed with the package.
- **TypeScript.** The host type-checks this source with its own compiler and
  flags. It passes TypeScript 5.9 with Dispatch's `apps/desktop` settings (not
  strict, so `strictNullChecks` is off; `lib: ["ES2023", "DOM"]` without
  `DOM.Iterable`, `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`) and with strict on. Keep it that way: narrow unions
  with a type guard rather than `x !== undefined` (which does not narrow without
  `strictNullChecks`), iterate a `NodeList` through `Array.from`, prefix unused
  parameters with `_`. The `typecheck-host` task (`tsconfig.host.json`) checks
  the non-strict side; TypeScript 7 folds `DOM.Iterable` into `DOM`, so the
  `Array.from` rule is checked by review only.

## Installing

The package is a private workspace package (`packages/ui`): a host in this
repository adds `"@dispatch/ui": "workspace:*"` and imports the source. Its two
runtime dependencies (`lucide-react`, `@dagrejs/dagre`) come from the catalog in
`pnpm-workspace.yaml`, and the host's own `react` and `react-dom` satisfy the
peer dependencies, so there is one React and Vite needs no `resolve.dedupe`.
`test/package-manifest.test.ts` keeps the manifest in that shape. (Before the
move it was installed into Dispatch from a `pnpm pack` tarball; that story is
over.)

TypeScript needs a declaration for `*.module.css` and `*.css` imports. Vite's
`vite/client` types provide it; another host can include the package's
`global.d.ts`.

## Styles

Import the global sheet once, **after** the host's own global CSS so the
package's focus ring and reset win inside its components:

```ts
import './styles/global.css'; // the host's
import '@dispatch/ui/styles.css';
```

`styles.css` holds the design tokens (Gr8r's set, light and a soft warm dark;
`src/styles/tokens.css`), the `data-tone` hook, a small reset, and the shared
classes the components use by name. Everything else is in CSS modules.

| tokens                                                                                                                                                                                                                            | for                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--bg`, `--bg-side`, `--surface`, `--surface-2`, `--surface-3`, `--sunken`, `--overlay`                                                                                                                                           | the page, the sidebar, panels and menus, the hover fill, the pressed fill and tracks, recessed wells, the scrim     |
| `--divider` < `--border` < `--border-strong`; `--control-border`                                                                                                                                                                  | row separators, container edges, chip and button outlines (decoration); the 3:1 edge of a field, checkbox or switch |
| `--text`, `--text-2`, `--text-3`, `--text-4`, `--text-inv`                                                                                                                                                                        | primary, secondary, meta, icons only (never words), text on an inverted fill                                        |
| `--accent`, `--on-accent`, `--accent-ink`(`-hover`), `--accent-soft`, `--accent-line`, `--accent-hover`, `--accent-active`                                                                                                        | the purple: primary, focus, selection, progress, today, unread, links; never a status                               |
| `--red`, `--amber`, `--green`, `--blue` (text-safe and 3:1 as marks), `--gray` (inactive mark), each `-soft` / `-line` tint, `--on-<hue>` (`--on-danger`), `--<hue>-ink-inverse` and `--accent-ink-inverse` (on an inverted fill) | status and risk (the mapping in `docs/architecture.md` §8.2)                                                        |
| `--violet`, `--teal`, `--rose`, `--orange`                                                                                                                                                                                        | avatars and swatches only                                                                                           |
| `--st-triage` … `--st-done`                                                                                                                                                                                                       | `StateGlyph`'s workflow colours                                                                                     |
| `--shadow-sm`, `--shadow-raised`, `--shadow-card`, `--shadow-pop`, `--shadow-drag`, `--shadow-drawer`                                                                                                                             | elevation, only for things that float or can be picked up                                                           |
| `--r-xs` 4, `--r-chip` 5, `--r-sm` 6, `--r` 8, `--r-lg` 10, `--r-xl` 12                                                                                                                                                           | radius                                                                                                              |
| `--s-1..12`, `--gutter`; `--h-xs..lg`, `--side-w`, `--side-row`, `--row-h`, `--topbar-h`                                                                                                                                          | spacing and sizes                                                                                                   |
| `--font-sans`, `--font-mono`, `--fs-2xs..2xl`, `--fw-*`, `--lh`, `--lh-long`, `--ls-*`                                                                                                                                            | type                                                                                                                |
| `--ease`, `--spring`, `--ease-drawer`, `--dur`                                                                                                                                                                                    | motion                                                                                                              |
| `--nav-current-bg`, `--nav-current-shadow`, `--drawer-edge`, `--brand-tile-*`                                                                                                                                                     | theme-dependent component looks (so a light wrapper in a dark page stays light)                                     |

The `data-tone` hook gives any element with `data-tone="<UiTone>"` five
variables: `--tone` (the hue), `--tone-ink` (its text, 4.5:1), `--tone-soft`
(its tint), `--tone-line` (a tinted border) and `--on-tone` (text on a solid
fill). The shared classes: `.pageBlock` (a page section's column; not `.block`,
which is Tailwind's display utility in a host that still loads it), `.blockBar`,
`.blockTitle`, `.blockMeta` (a section heading row), `.srOnly`, `.skipLink`,
`.page`, `.key` (a semibold lead-in), `.label` (a 12px quiet label), `.eyebrow`
(the one uppercase voice), `.muted`, `.faint`, `.mono` (ids and keys only),
`.num` (tabular figures), `.accentLink` (underlined), `.button`,
`.buttonPrimary`, `.input`, `.select`, `.textarea` (with Gr8r's focus ring and a
red `aria-invalid` state), `.notice`, `.empty` and `.hatched` (a dashed edge).

The pre-Gr8r names (`--paper`, `--ink`, `--background`, `--foreground`,
`--muted`, `--ink-soft`, `--grey*`, `--tint`, `--hairline-faint`, `--hatch`,
`--red-ink` and the other `-ink` steps, `--muted-inverse`, `--ink-soft-inverse`,
`--hairline-inverse`, `--ease-out-quint`, `--ease-out-expo`) were deprecated
aliases onto the Gr8r tokens while the sheets moved, and are removed:
`tokens.css` no longer declares them, so a host's CSS that still reads one gets
nothing (`RETIRED` in `test/contrast-helpers.ts`; docs/architecture.md §8.2 "Old
token names" maps each to its Gr8r name).

### Page mode (default)

With nothing else set, the sheet styles the whole document: tokens on `:root`,
the reset on every element, the shared classes anywhere. That is what the
planner wants (it owns the page).

### Scoped mode (embedding in an app with its own design system)

Page mode would take over a host such as Dispatch: both define `--accent`,
`--accent-hover`, `--background`, `--foreground`, `--border`, `--muted`,
`--font-sans`, `--font-mono` and `--ease-out-expo` on `:root` (and the page
column is named `.pageBlock` so Dispatch's Tailwind `block` utility never gets
its 1440px max-width, 40px margin and 48px padding); and the unlayered reset
(`button { padding: 0; background: none; border-radius: 0 }`,
`ul { list-style: none }`, `svg { display: block }`) beats Tailwind's layered
utilities on every host element.

Opt out of page mode with two attributes:

```html
<html data-bt-ui-scoped></html>
```

```tsx
<div data-bt-ui="" data-theme={theme}>
  <TaskDetail {...props} />
</div>
```

With `data-bt-ui-scoped` on `<html>`, the tokens are declared on each
`[data-bt-ui]` element only, and the reset and shared classes apply only inside
it. The wrapper also takes the surface colour, the text colour and the body
font. The host's `:root` tokens, `<body>` and its own elements are untouched.
Caveats:

- Host content passed into a component (a `ReactNode` prop such as
  `titleControl`, `sectionMeta`, `toolbarEnd`) renders inside the wrapper, so it
  sees this package's tokens and reset. Pass controls from this package there,
  or expect to restyle them.
- Popovers (`PickerPopover` and the pickers) use the browser's top layer but
  stay DOM children of the wrapper, so they keep its tokens. Nothing is
  portalled to `<body>`.

Colour jobs: `--accent` is the purple for fills, marks, rings and focus (one
value in both themes). Purple **text** uses `--accent-ink` (a lighter purple in
dark, where `#9747ff` falls under 4.5:1 on the surface), `--accent-ink-hover`
when hovered or focused, and `--accent-ink-inverse` on an inverted (`--text`)
fill such as a toast or the bulk bar. Quiet text is `--text-2` (secondary) or
`--text-3` (meta, placeholders, column headers); `--text-4` is for icons and
`aria-hidden` separators only, never words. The purple never means a status.

Status has its own hues (see "Status vocabulary"): `--red`, `--amber`, `--green`
and `--blue` are text-safe (4.5:1 on `--surface`, `--surface-2` and `--sunken`)
and 3:1 as marks (dots, edges, bars, glyphs), and `--gray` is the inactive mark.
Each has a `-soft` tint and a `-line` edge for Gr8r's tinted chips, notices and
alerts (the hue's text holds 4.5:1 on its own tint), `--on-<hue>` for text on a
solid fill (`--on-danger` on the red danger button) and `--<hue>-ink-inverse`
for the hue on an inverted fill (the error toast's icon). Rather than naming a
hue, a component puts `data-tone` on the element and uses the hook's `--tone`
(mark), `--tone-ink` (text), `--tone-soft`, `--tone-line` and `--on-tone`, which
`tokens.css` defines for every `UiTone`.

Nothing floods. Hover is a soft fill (`--surface-2`, or `--surface-3` on the
grey sidebar and on sunken bands), with the text stepping to `--text` at most; a
selected row or option is the `--accent-soft` tint with a 2px accent bar inside
its left edge (the tint alone is under 3:1), a current nav item the raised pill
(`--nav-current-bg`, `--nav-current-shadow`) with its icon in `--accent-ink`.
Only an inverted surface (toast, tooltip, bulk bar, the inverse `Chip`) puts
words on `--text`, in `--text-inv` and the `-ink-inverse` steps. Keyboard focus
is `--focus-ring` (the accent in light, `--accent-ink` in dark so it holds 3:1
on the dark status tints); an inverted surface sets it to
`--focus-ring-inverse`. Write a component's own focus ring with
`var(--focus-ring)`, never the bare accent. `test/styles-contrast.test.ts`
measures every token pair in both themes.

## Theme

Dark mode is `data-theme="dark"`, on `<html>` (page mode) or on `<html>` or the
wrapper (scoped mode; `data-theme="light"` on a wrapper keeps it light under a
dark `<html>`). `data-theme="system"` (on `<html>` or a wrapper) follows the OS
live through `prefers-color-scheme`, with no script: the simplest choice for a
host like Dispatch that wires its own dark mode to the OS. Without any of these
the UI is light, whatever the OS says.

- `themeScript(storageKey)` returns a parser-blocking script for the first child
  of `<body>`: the saved choice, else the OS preference, written to
  `html[data-theme]` before first paint (no flash).
  - Next: `<script dangerouslySetInnerHTML={{ __html: themeScript(KEY) }} />`,
    with `suppressHydrationWarning` on `<html>` (the script changes its
    attribute before React hydrates).
  - Vite: inline it with a plugin:

    ```ts
    import { themeScript } from '@dispatch/ui/lib/theme.ts';

    const btTheme = {
      name: 'bt-ui-theme',
      transformIndexHtml: () => [
        {
          tag: 'script',
          children: themeScript('app-theme'),
          injectTo: 'body-prepend' as const,
        },
      ],
    };
    ```

- `<ThemeToggle storageKey={KEY} />` flips `html[data-theme]` and saves the
  choice under the same key. It assumes `themeScript` ran (it toggles from
  whatever `<html>` says; from `system` it switches to the opposite of what the
  OS shows). Its glyph follows the nearest `data-theme` ancestor.
- A host that follows the OS but needs the value in JavaScript can set the
  wrapper's attribute itself:

  ```tsx
  const query = '(prefers-color-scheme: dark)';
  function useOsTheme(): 'light' | 'dark' {
    return useSyncExternalStore(
      (onChange) => {
        const list = window.matchMedia(query);
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
      },
      () => (window.matchMedia(query).matches ? 'dark' : 'light'),
      () => 'light'
    );
  }
  ```

## Fonts

`--font-sans` is `var(--font-geist, Geist)` then system UI fonts, and
`--font-mono` is `var(--font-geist-mono, 'Geist Mono')` then `ui-monospace`,
Menlo and other monospace fonts. The planner sets `--font-geist` and
`--font-geist-mono` with `next/font`; another host either sets those two
variables or loads the families under those names (for example with
`@fontsource`). The components use Geist at weights 400, 450, 500 and 600
(`ss01` and `cv11` on) and Geist Mono at 400, for ids and keys only.

## Links

Components never import a router. They render `<Link>` from this package, which
renders the host's component from `UiLinkProvider` (a plain `<a>` when none is
provided). `http://` and `https://` URLs always render as a plain `<a>` (usually
with `target="_blank"`), not through the host's component.

```tsx
import { type UiLinkProps, UiLinkProvider } from '@dispatch/ui';

function HostLink({ href, onClick, ...rest }: UiLinkProps) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        navigate(href); // the host's router
      }}
    />
  );
}

<UiLinkProvider link={HostLink}>{app}</UiLinkProvider>;
```

`UiLinkProps` is `href`, `className`, `children`, `aria-current`, `aria-label`,
`title`, `target`, `rel` and `onClick`. The planner's adapter is
`apps/planner/app/(app)/components/next-ui-link.tsx` (`next/link`, with plain
anchors for `/api/*`).

## Status vocabulary

A milestone's status is a 12px diamond coloured by the status hues (the mapping
of the owner decision of 2026-10-22, drawn the Gr8r way since 2026-10-23; the
full table is in `docs/architecture.md` §8.2 "Status colours"). The shape always
differs too, and the label is always there for assistive tech, so colour is
never the only cue:

| `UiStatus` | mark                                                       |
| ---------- | ---------------------------------------------------------- |
| `done`     | solid neutral (`--text`) diamond with a tick (never green) |
| `on_track` | open diamond, 2px green edge                               |
| `at_risk`  | amber diamond, lower half filled                           |
| `overdue`  | solid red diamond                                          |
| `missing`  | dotted `--text-3` diamond (an input is missing)            |
| `open`     | open `--text-2` diamond (no status claim of its own)       |
| `muted`    | prop on `StatusMark`: open `--gray` diamond, any status    |

Done and overdue share the solid diamond, so they differ in lightness as well as
hue: done is the neutral fill with a knocked-out tick, because a green fill is
as light as the red one and the two would look the same without red-green vision
or in greyscale. Green is the on-track edge and done's words. Issue states are
circles (`StateGlyph`), so the two families never look alike. Forced colours
keep every shape.

The other shared vocabularies:

- `UiTone`: `default` (neutral), `muted` (grey: inactive, nothing to do),
  `accent` (the purple: new, unread, selected, progress; never a status) and the
  `SemanticTone`s `danger` (red: overdue, failed, urgent), `warning` (amber: at
  risk, blocked, unassigned, a missing input), `success` (green: on track,
  done's words, succeeded) and `info` (blue: in progress, running, live).
  Components emit it as `data-tone`. `Chip`, `Notice`, `AlertStrip` (default
  `warning`: an alert is always a status, never the purple), `ProgressRule` (the
  fill only; default is the accent), `RegisterCell` (the value only; the `sub`
  line under it stays secondary text unless `toneSub` opts it in, for a reason
  line that is the point: a blocked project's reason, a failed sync's error) and
  `StatsStrip` draw every tone; a `RegisterRow`'s tone is data only (no rule:
  the row says it with a chip or a toned cell). `Button variant="danger"` is a
  red fill. `Checklist` (the rubric) keeps a met item a neutral disc with a
  tick, like done, so a missing item's dashed amber ring and "Missing" chip are
  the only hue in the list.
- `TaskStateKind` (Linear's state types): `triage`, `backlog`, `unstarted`,
  `started`, `completed`, `canceled`, drawn by `StateGlyph` in the `--st-*`
  colours (in progress a blue half disc, done a green disc with a tick, triage
  and backlog dashed grey rings, canceled a struck grey ring, todo the neutral
  ring).
- `TaskPriority`: `0` none, `1` urgent, `2` high, `3` medium, `4` low, drawn by
  `PriorityGlyph` (urgent a red rounded square with a "!", none three dashes,
  the rest `--text-2` bars).
- `ChipTone`: any `UiTone` (default the neutral badge, muted plain quiet text,
  or with `dot` the status pill with a grey dot for an inactive lifecycle
  status, accent the tinted purple badge; a status tone is Gr8r's status pill,
  neutral with a 6px dot in the hue, or with `filled` Gr8r's tinted badge, the
  tone's text on its soft tint, for the stronger claims), or `inverse` (the dark
  slab).
- `ShellNavItem.countTone`: `accent` (new, unread) turns the count into the
  solid accent pill; a status tone (e.g. `warning` for blocked projects) into
  its tinted pill.
- Graph: `GraphNodeTone` (any `UiTone`: `danger` / `warning` / `success` /
  `info` draw a 2px edge in the hue, `muted` a quiet box: `--text-3` words, a
  done one keeping its solid neutral done diamond, any other status diamond
  turning `--gray` with its shape kept (a missing input stays dotted), `accent`
  a purple edge for a host's own emphasis, never a status), `GraphNodeTag` (a
  sentence-case word drawn as a `Chip`: `Unassigned` tinted amber, `Overdue` a
  red dot pill (and under Risk the box's `--red-soft` tint inside a red edge),
  `Cycle` tinted red with a dashed red outline round the box, `On a cycle` /
  `Cycle inside` tinted red, `No lead` an amber dot pill, `Inactive` quiet text,
  or any string, neutral), `GraphEdgeKind` (`default`, `risk` amber, `cycle`
  long red dashes, `cross` short dashes, `resolved` dots). `GraphLegendMark`
  adds `node-warning` (the amber edge), the Status highlight's `node-ready` (1px
  green edge), `node-blocked` (2px amber) and `node-stuck` (2px red), the
  Critical path's `node-chain` (`--text` ring and step disc) and `node-faded`,
  the edges `edge-unblocked` (green dots) and `edge-chain` (2.5px `--text`), the
  Paths row's `path-active` (the accent tint under the ring of the box being
  read), `path-locked` (that tint and ring plus the lock's four rounded accent
  corner ticks), `path-up` (accent ring), `path-down` (`--text` ring),
  `path-next` (the green "Ready next" dot pill) and `path-chain` (as
  `node-chain`), and the frames `cluster` and `cluster-muted`.
- `ToastKind`: `info`, `error`. A `ToastInput` may carry `announce` (what the
  live region says in place of the visible sentence) and `onClose` (called once
  when the toast leaves the stack, however it goes).

Every status mark carries a text label for assistive tech (`label` /
`statusLabel` props). Wording is the host's: components that print built-in
words take a `labels` prop (`DEFAULT_TASK_LABELS`, `DEFAULT_EDIT_LABELS`).

## Components

Props are typed in each family's `types.ts` (the basics in their own files) and
exported from the package root (`TaskDetailProps`, `TimelineChartProps`,
`StatusMarkProps`, `BlockBarProps`, `TabsProps`, `ThemeToggleProps`,
`UiLinkProviderProps`, `PickerMarkViewProps`, …). Required props are listed; see
the types for the rest.

| family   | component                                                                                                              | required props                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| basics   | `StatusMark`                                                                                                           | `status`, `label`                                                  |
|          | `BlockBar` (a section heading row; `index` is ignored)                                                                 | `title`                                                            |
|          | `Tabs` (ids are prefixed per instance; `label` names the tablist; empty renders nothing)                               | `items: TabItem[]` (`id`, `label`, `content`)                      |
|          | `ThemeToggle`                                                                                                          | `storageKey`                                                       |
|          | `InitialsAvatar` (round, a pastel hue from the name; blank = nobody), `avatarHue(name)`                                | `name`                                                             |
| tasks    | `Button` (primary, secondary, quiet, danger; `size` sm / md / lg; `block`)                                             | none (`href` renders a link)                                       |
|          | `Checkbox` (`indeterminate` for a partly selected group), `Switch`, `SegmentedControl`, `Chip`                         | see `tasks/types.ts`                                               |
|          | `TaskGroupTable` (grouped issue list; selection, drag and slots below)                                                 | `sections`                                                         |
|          | `ViewToolbar` (list toolbar: search, the host's Filter / Sort / Group, end actions), `ToolbarBadge`                    | `search`, `controls`                                               |
|          | `FilterChips` ("Project is …" chips joined by "and", + Filter, Clear all)                                              | `chips`                                                            |
|          | `BulkBar` (the floating bar of a selection; confirm strip, busy, note), `useBulkBarHeight()` (its height while up)     | `count`, `onClear`, `children`                                     |
|          | `DeadlineList`, `StatsStrip`, `ProgressRule`                                                                           | `groups`; `cells`; `done`/`total`                                  |
|          | `Register`, `RegisterRow`, `RegisterCell`                                                                              | `columns`, `label`, `children`                                     |
|          | `Notice`, `EmptyState` (a centred icon, optional `label` title, the sentence, an action), `NavTabs`, `Checklist`       | see `tasks/types.ts`                                               |
| shell    | `AppShell` (sidebar, topbar, phone tab bar)                                                                            | `appName`, `brandHref`, `nav`                                      |
|          | `CommandPaletteProvider` + `CommandPalette`                                                                            | none; pass `navigate` (the default is `window.location.assign`)    |
|          | `ToastProvider` + `useToast()`                                                                                         | none                                                               |
|          | `SlideOver` (`contentKey` names what it shows: a new key while open moves focus to the panel)                          | `open`, `onClose`, `title`                                         |
|          | `SignedOutFrame`, `PropertyList`, `AlertStrip`                                                                         | see `shell/types.ts`                                               |
|          | `Skeleton*`, `Kbd`, `KbdKeys`                                                                                          | see `shell/types.ts`                                               |
| timeline | `TimelineChart` (Gantt)                                                                                                | `today`, `windowStart`, `windowEnd`, `zoom`, `groups`, `onOpenBar` |
| graph    | `DependencyGraph`                                                                                                      | `nodes`, `edges`, `ariaSummary`, `emptyMessage`                    |
|          | `GraphLegend`, `MermaidSource`                                                                                         | see `graph/types.ts`                                               |
| task     | `TaskDetail` (`layout="drawer"` or `"page"`)                                                                           | `taskKey`, `title`, `status`, `properties`                         |
|          | `TaskSlideOver` (TaskDetail in a SlideOver)                                                                            | the above plus `open`, `onClose`                                   |
|          | `TaskDescription`, `TaskRelationList`, `TaskCommentList`, `TaskActivityList`, `TaskCrumbs`                             | see `task/types.ts`                                                |
| edit     | `StatePicker`, `AssigneePicker`, `PriorityPicker`, `LabelPicker`, `ProjectPicker`, `MilestonePicker`, `EstimatePicker` | the choices (`states`, `people`, …), `value`, `onChange`           |
|          | `PickerPopover` (the generic picker)                                                                                   | see `edit/types.ts`                                                |
|          | `TaskRelationPicker`                                                                                                   | `label`, `search`, `onSelect`                                      |
|          | `InlineTextField`, `TextAreaEditor`                                                                                    | `label`, `onSave` (and `value` for the field)                      |
|          | `DateField`                                                                                                            | `label`, `value`, `onChange`                                       |

Pure helpers are exported too: the timeline's date scale (`createScale`,
`xForDate`, …), the graph layout (`layoutGraph`, `upstreamChain`, …), the
graph's path walks (`pathContext`, `nodePaths`, `longestChains`, `longestChain`,
`describePaths`, …), the palette's `fuzzyMatch`, the collapsed-group storage
helpers, and the selection helpers (`toggleId`, `rangeIds`, `setIds`,
`pruneSelection`: pure, never mutating, and returning the same set when nothing
changes).

### Lists: selection, drag, slots, toolbar, chips, bulk bar

`TaskGroupTable` takes optional props for a list people act on (the planner's
Issues page). With none of them it renders exactly what it rendered before (a
DOM snapshot of My week's props guards that). Its groups and rows are memoized,
so a selection, a fold or a host render redraws only the rows it touches. A
group is compared by identity (its header is one cheap draw); a row by value:
every field of its `TaskRowData`, `chips` (label, tone, filled) and `note`
(text, tone) by their contents, and of its group only the `id` and `eyebrow` it
draws. So an adapter that maps its store to fresh sections, groups and rows on
every event (Dispatch patching one task on a WS message) needs no per-row
memoisation: only the rows whose data changed redraw, and a group whose object
changed redraws its header alone. A row that skipped a redraw still fires its
callbacks with the group as it is now (the table looks it up by id). The event
callbacks (`onOpenRow`, `onOpenGroup`, `onRowContextMenu`, `selection`'s
`onChange`, `drag`'s) are read when they run and may change every render, but
the render slots (`renderCell`, `rowActions`, `groupActions`), `columns` and
`columnLabels` redraw every row or group when their identity changes: keep them
stable in a host with many rows.

Above `windowAbove` rows in total (folded groups included; default 150) the rows
are **windowed**, per group: every group keeps its heading, its header row and
its own `<ul>`, and inside the `<ul>` only the rows near the scroll viewport
(plus about eight rows of overscan each side, the focused row and the rows being
dragged) are mounted; the rest stand as
`<li role="presentation" aria-hidden data-row-gap="n">` gaps of their measured
height (the running mean of the rows measured so far for rows never drawn), so
the scroll range, document order, roles, the groups as drop targets and the
sticky column header are as in a small list, and each mounted row carries
`aria-posinset` / `aria-setsize`. At or below the threshold every row is drawn,
exactly as before (the snapshot above covers that). The scroll container is
`scrollParent`: an element, a function returning it (read when windowing starts
and again after mount; keep it stable), or `'window'`; by default the nearest
ancestor with `overflow-y: auto` or `scroll`, found in an effect, else the
window. The server render (and the first client render, corrected in a layout
effect before paint) draws the first ~60 rows of the first groups and an
estimated gap for the rest, so a hydration agrees with the server. Rows are
mounted lazily: a host must not keep row elements (query them when needed, as
`rowTitleElement` does) and should act on the `row` and `group` a callback is
given. Measured on Dispatch's 2,000-task board (40 groups): the first rows paint
about 0.2 s after the view opens with 22 rows mounted and about 4,000 DOM nodes,
against 3.3 s and 152,000 nodes drawing every row; the desktop no longer needs
its progressive mount.

- **Data.** Columns `assignee` (the round `InitialsAvatar` and the name; `null`
  reads "Unassigned", or the row's `unassignedLabel` ("Needs assignee"), beside
  the dashed empty avatar, toned by `assigneeTone`: `muted` by default,
  `warning` (amber) when the issue needs a person; give a toned placeholder its
  own words so its hue is never the only difference), `due` (`dueTone`, plus
  `dueNote`, the state in a word under the date in its voice and tone, "Overdue"
  / "Tomorrow", beside it on a stacked card) and `milestone` (the milestone's
  name, then `milestoneProject` muted after " · " and cut first, the full
  "Project › Milestone" as its tooltip; `null` reads "No milestone", muted).
  Rows: `done` (the title muted and struck through), `pending` (the
  `--surface-2` fill, `aria-busy`; no hatch and no fade, so the text keeps its
  contrast) and `note` (a quiet `--fs-xs` line after the title: "Moving to
  Dual-write…" in `--text-3`, or "Not moved · …" in its tone's text colour: the
  planner sends `danger`, red, for every change that did not happen). Row
  `chips` take any `ChipTone` and `filled` (the Blocked chip is the tinted amber
  chip, as on the projects register). Groups: `count` (every match; the header
  and section count it, `rows` may hold fewer), `mark` (a state, priority or
  avatar glyph in the status mark's place), `tags` (the timeline's small
  `--surface-2` pills: "Next", "↑2"), `missingLabel` (an amber `--fs-xs` line
  under the heading, the checklist's "missing" voice), `footer` ("Showing 12 of
  212" in quiet text with the host's actions as `--text-2` buttons; a group with
  no rows and a footer shows only the footer, not the empty line), `emptyLabel`,
  `droppable`. A section without `label` draws no divider.
- **`dropColumns`** (column ids, first to give way first): a table too narrow
  for its columns beside a readable title (260px) steps down at 1160, 1000 and
  860px of its own width, each step dropping as few of these as it needs
  (`data-drop-lg|md|sm` name them, `--task-cols-lg|md|sm` hold the grid without
  them, container queries apply both); below 720px the cards show every column
  again. Without it nothing drops (and the head cells carry no `data-column`).
- **`selection`** `{ selected, onChange, toggleOnClick? }`: the host owns the
  set. A checkbox per row ("Select ENG-12"), a tri-state one per group header
  ("Select the 12 shown issues in Dual-write"; on a folded group it unfolds it)
  and in the column header ("Select all 40 shown issues"), which then stops
  being `aria-hidden` (its labels are). Click toggles and sets the anchor;
  shift-click applies the clicked row's new state to the range from the anchor,
  across groups, in drawn order. A selected row takes the `--accent-soft` tint
  with a 2px accent bar inside its left edge (drawn as a border, so forced
  colours keep it, plus a `Highlight` outline there) and its checkbox fills the
  accent; the checkbox carries the state (list items never get `aria-selected`).
  Rows that stop being drawn (a folded group, a refresh) leave the selection
  through `onChange`. `toggleOnClick` is the phone's selection mode: a plain
  click toggles a row instead of opening it, and the title renders as a checkbox
  (a native input in the title's label: named by the title, checked by the
  selection, the row's focus target) rather than a link that would not open.
  `hideOnTouch` hides the checkboxes in CSS on touch screens and phones
  (`(pointer: coarse), (width <= 640px)`), so the server's markup and the
  hydrated page agree; turn it off in the host's own selection mode (a Select
  button rendered always and shown by the same query).
- **`drag`** `{ canDrop, onDrop, label }`: HTML5 drag from an 18px grip that
  shows on row hover, only under `(hover: hover) and (pointer: fine)` (nothing
  is draggable on the server or on touch). A selected row drags the whole
  selection (in drawn order), otherwise itself; the drag image is an inverted
  card (`--text` fill, `--text-inv` words) reading `label(n)`. Over a group the
  table asks `canDrop(ids, groupId)` once per group per drag: `true` gives the
  group a faint accent wash (6% over `--sunken`) inside a 1px `--accent` edge
  (rows take no hover fill while a drag is on) and allows the drop; a string is
  the reason, shown in the header (and as its `title`) with the not-allowed
  cursor. `droppable: false` groups are never asked. There is no reordering: a
  drop targets a group. Keep a keyboard and menu path for every drop (WCAG
  2.5.7).
- **Header.** The column header is sticky above every in-row layer (z-index 3
  over the lead, picker, ↗ and actions cells at 2).
- **Slots.** `renderCell(column, row, group)` replaces a cell's value with a
  host control (a picker with `appearance="cell"`; return `undefined` to keep
  the plain value), `rowActions(row, group)` adds a trailing 40px cell (the
  row's "…"), `groupActions(group)` a slot at the end of each header,
  `onRowContextMenu(event, row, group)` takes right-clicks (call
  `preventDefault()` to open your menu). Keys and clicks inside a host control
  (a text field, an open picker) are never the list's.
- **Keyboard.** On top of ↑/↓, j/k, Home/End, ←/→ and ↵: with `selection`, `x`
  toggles the focused row, Shift+↑/↓ extend the selection from the anchor (it
  grows and shrinks over what the anchor started from) and move focus, ⌘/Ctrl+A
  selects every drawn row. Every other key on a row goes to `onRowKeyDown`; a
  host's single-key commands should yield while
  `useCommandPalette().isSequencePending()` is true, so G S and G P still reach
  the palette. The keys walk the table's model (the group toggles and the rows
  of unfolded groups, in reading order), never the DOM: in a windowed list a key
  that lands on a row that is not mounted scrolls its place into view (clear of
  the sticky column header), mounts it and focuses it; `activeRowId` likewise
  scrolls into view when it changes. ⌘/Ctrl+A and Shift ranges work over the
  whole ordered id list, mounted or not.
- **Row keys a host binds** (what reaches `onRowKeyDown`, exactly). The table
  consumes, on a row, ↑/↓, `j`/`k`, Home/End and ← (to the group), plus with
  `selection` `x`, Shift+↑/↓ and ⌘/Ctrl+A; it never calls `preventDefault` on
  anything else. So Enter, Space (`event.key === ' '`), `o`, →, every other
  letter (`s`, `p`, `a`, `m`, `d`, and `x` without `selection`) and every
  modified key (⌘C) reach `onRowKeyDown` first. The table opens a row on its
  click, not in keydown: Enter's default action activates the row's link or
  button and so calls `onOpenRow` _after_ the host's handler unless the host
  calls `event.preventDefault()` there (Dispatch: Enter and `o` open the page
  itself, Space the quick look; prevent both, since Space's default scrolls the
  page, or presses a callback-only row's button). Keys typed into a host control
  inside a row (a cell picker's field, an open popover) never arrive. Rows are
  mounted lazily above `windowAbove`: a handler acts on the `row` and `group` it
  is given and never on a row element cached from an earlier call.
- **`indent`** (`TaskRowData.indent`, `0 | 1 | 2`): a sub-issue nested under the
  row before it. The row carries `data-indent` and its title cell (the key and
  the title together) moves in one 20px step per level (`--task-nest`), on the
  card too; the grid columns, the row's accessible name and its words are
  unchanged, so the nesting is layout and holds in forced colours. Dispatch
  nests sub-tasks one level under their parent.
- **`addLabel` / `onAdd`** (`TaskGroupData`, both or neither): a "+" icon button
  (a quiet 26px `Button`, named and titled by `addLabel`: "New task in
  Dual-write") at the end of the group header, before the `groupActions` slot,
  above the header's fold target (a click adds, never folds), 40px on a coarse
  pointer; ↑/↓ skip it (it is not a nav item). Verbs that act on the group
  (Dispatch's Send agents…, Pause, Resume, Land; the planner's weight) stay in
  `groupActions(group)` as the host's "…" menu (a `PickerPopover` with
  `action`), so every header keeps one quiet control however many verbs apply
  and the menu brings its own keyboard, Esc and focus return; a row of inline
  verb buttons per header was considered and declined as clutter.
- **Live.** A running agent is a row chip in the `info` tone,
  `{ label: 'Working', tone: 'info' }` (Gr8r's status pill: a 6px blue dot and
  the words), or `filled` for the stronger claim ("Live"). There is no pulsing
  dot and no `live` prop: motion is never a cue here (the words say the state,
  as `UiTone` rules: "in progress, running, live" are blue), so the table's
  sheet has no animation and reduced motion has nothing to switch off beyond its
  transitions.

`ViewToolbar` lays out Gr8r's list toolbar, one 44px row over a `--border` rule:
a 26px search field with a leading magnifier (a `--control-border` edge and the
fields' focus ring), as the timeline and projects toolbars draw theirs
(`onChange` per keystroke, `onCommit` on Enter and on leaving the field, so it
may fire twice for one value; `inputRef` for a `/` shortcut), the host's
triggers (pickers with `appearance="quiet"`), and `end` actions at the right
edge. `busy` sets `aria-busy` and runs a 2px accent rule along the bottom.
Phones put the search on its own row and scroll the controls sideways.
`ToolbarBadge` is the small accent count badge of a Filter trigger.
`FilterChips` is a second row the toolbar's height under its own soft rule: one
chip per filter (26px, an `--accent-soft` tint in an `--accent-line` edge;
"Project is {summary}": the field in `--text-2` 500, "is", the values in the
reading voice, a quiet "and" between), a named × each, the host's add control
and Clear all (`clearDisabled` while the filters are the default);
`renderEditor(face)` wraps a chip's face in the host's picker; `unknown` draws
the chip in the warning tint (an `--amber-soft` fill, an `--amber-line` edge,
its values in `--amber`: a missing input, beside its words "Not found"). Both
rows pad their content by `--view-toolbar-gutter` (default the page `--gutter`,
24px, 16px at 900px and below); a host that places them in a padded column sets
it on an ancestor (0 there). Neither renders anything when there is nothing to
show (`FilterChips` with no chips; `BulkBar` at 0 keeps only its empty, visually
hidden live region). A chip removed while its × has focus hands focus to the
next chip (its face's picker, else its ×), else the previous one; Clear all
hands it to the add control; a host whose last chip can go places focus itself.

`BulkBar` is the fixed toolbar at the bottom centre of the content column (the
shell sets `--shell-content-left` to its sidebar's or rail's width, 0 on phones;
outside a shell it centres on the window), Gr8r's inverted pill, drawn like the
toasts: a `--text` fill with `--text-inv` words, `--r-lg` and `--shadow-pop`
(above the shell's tab bar on phones): "{n} selected" in a semibold voice,
spoken by a polite live region that stays mounted (empty) at 0 so the first
selection is announced, the host's action triggers (pickers with
`appearance="bar"`), ✕. `busy` ("Moving 12 issues…") replaces the count and
disables the actions (they sit in a `<fieldset>`; when it ends, focus that fell
to `<body>` goes back to the action last used, else the first), as does a `note`
("At most 100 at a time"); `confirm` replaces the actions with a sentence, a
primary button that takes focus, and Cancel (focus returns to the first action).
Esc clears the selection (or cancels the confirmation), ← and → move between its
buttons; after `onClear` the host puts focus back in the list. Mark a trigger's
text `data-bulk-label`: it hides at 390px and below, so give each trigger a
`triggerLabel`. While the bar is up (`data-bulk-bar`) the toasts stack above it:
it publishes its height through `useBulkBarHeight()` (px, or null while no bar
is up), and `ToastProvider` sets it as `--bulk-bar-h` on its own viewport. A
host list that must keep room under its last rows reads the same hook. Nothing
is set on `<html>`: an inherited custom property there restyles every element of
the page.

`NavTabs` items may take `onFollow`: a plain click calls it instead of following
`href` (a host that navigates itself and shows the change at once); a modified
or middle click still opens the link.

### Graph and timeline options

- `DependencyGraph` `layout`: a `GraphLayout` the host computed with
  `layoutGraph` from the same `nodes`, `edges` and options. It is used as is, so
  a server render can lay the graph out once and the client (a phone included)
  never runs dagre; `direction`, `cluster` and the layout of `clusters` are then
  ignored (pass the same `clusters` anyway: the names use them). `layoutGraph`
  is pure and carries no `'use client'`, so it runs on a server.
- `DependencyGraph` `clusters` (and `layoutGraph`'s `clusters` option): a graph
  of every item, framed by parent. Each `GraphClusterData` (`id`, `label`,
  `parent`, `muted`, `external`) is a labelled frame, nested through `parent`;
  `GraphNodeData.cluster` names a node's innermost frame (unknown or none: the
  top level). Inside each frame the nodes and frames on an arrow flow along the
  direction by dagre, over that frame's own items only, with the ends of arrows
  that leave it drifting to its far side; the nodes on no arrow pack into a
  compact grid under the flow (done and empty ones last; two or more nodes get
  at least two columns), and frames on no arrow onto shelves under that. When
  frames in a flow would chain into a row longer than `CLUSTER_METRICS.flowMax`
  (2400px, or 1.25 times their shelf width), they go onto shelves in flow order
  instead and their arrows are drawn without a dagre route; when the flow's
  longest chain alone (`flowChain`, a lower bound on dagre's own acyclic graph)
  already passes that, dagre is not run for it at all. After dagre, when the
  band above a flow's first rank is at least `CLUSTER_METRICS.liftMin` (a box)
  tall, each rank rises by the space above it and above every rank before it, so
  a frame starts in its top-left corner even when a later rank stacks higher
  (dagre centres ranks on each other); arrow points move with their rank, and a
  route end not on its box's facing side is found again on the border. A thinner
  band stays, since moving ranks bends the arrows between them. dagre's edge
  weights are whole numbers: a fractional one can leave network-simplex pivoting
  forever. Arrows between frames leave the blocker's far side and enter the
  waiting box's near side, following dagre's lane to the far side of each frame
  they leave and from the near side of each they enter, running level to that
  side before crossing to the next frame when the run passes no box (in a flow
  small enough for network-simplex the frame's ports rank after and before its
  whole flow; in a bigger one they sit beside their own items, to keep its cost
  down), so they pass the other boxes there instead of running behind them;
  arrows inside one frame keep their dagre route. Then each arrow between
  frames, and an arrow inside one whose route would pass a box, turns round
  every box in its way (and each frame title's patch) by the box's nearer side,
  6px out, and where its smooth curve would still cut behind a box it is eased
  into straight runs with rounded bends (`routeAround`), so an arrow is not lost
  behind a box it does not join. Top to bottom, a frame's grid sits under its
  flow, in the way of the arrows leaving it, so frames read best left to right
  (every host uses `LR`). Given at all, even empty, `clusters` also packs the
  loose top-level nodes, so a host with no frames for a level (the planner's
  initiative level) still gets no long column. Frames are drawn decoratively
  (`data-graph-cluster`, `data-depth`, `data-muted`, `data-external`): a 1px
  `--control-border` edge with `--r-lg` corners, a sentence-case 12px semibold
  title in the top-left on a patch of the canvas above the arrows (`--text-2` at
  the top level, `--text-3` nested), dashed `--gray` when muted, dashed when
  external; each node's accessible name says the frames it sits in ("in Beta,
  Orion"). The layout carries `clustered: true`; its nodes come in reading order
  (frame by frame) and the arrow keys move to the nearest box that way. The
  legend draws frames as `cluster` and `cluster-muted`. Flows of more than
  `CLUSTER_METRICS.simplexItems` items or `simplexLinks` links rank with dagre's
  tight-tree instead of network-simplex, which keeps one big, dense frame near
  0.5 s for 500 nodes and 800 edges (network-simplex: about 5 s).
- `DependencyGraph` `focusId`: the node the graph is about (one issue's chain,
  say). It gets a 2px accent ring standing 3px off its box and lights nothing,
  unlike `selectedId` (the accent tint inside a 2px accent edge); its accessible
  name ends with `focusLabel` (default "focus"), and Tab lands on it until a
  node is focused or selected. On the first paint the frame (never the page)
  scrolls so the focus, else the selected node, sits in its middle. With
  neither, it opens where the flow starts rather than on dagre's empty top-left
  corner: at the drawing's start along the flow, and across it at the band,
  starting at a box, where the most boxes of that first frame-length show whole
  (the earliest on a tie). A framed layout (`clusters`) opens on its first
  frame, which the packing puts at the top-left: it stays at the origin while
  that frame shows a box whole there, and otherwise slides to the band of that
  frame's own boxes, never to a later frame. A drawing that fits the frame
  across does not move. The legend draws the mark as `node-focus`.
- `DependencyGraph` `coveredRight`: the width of a panel fixed along the
  window's right edge that is open over the graph (pass `SLIDE_OVER_WIDTH` while
  a `SlideOver` the page opened on arrival is open, and nothing once it closes).
  The frame then keeps right padding for the part the panel covers, so the first
  paint brings the focus or selection into the part the panel leaves uncovered,
  even in a drawing narrower than the frame: centred there, or scrolled only as
  far as it takes to show the whole box when that is less, so what it waits on
  (to its left) stays in view. When the panel would leave less than 240px of the
  frame (a phone's full-width sheet) nothing moves.
- `DependencyGraph` `highlight`: what the drawing emphasises. `risk` (the
  default, so a host that passes nothing keeps its look) draws the risk tones:
  the red overdue tint, the 2px edge in a node's `tone`, amber risk chains.
  `status` tones each node by its readiness instead: a 1px green edge when
  ready, a 2px amber edge when blocked, red when stuck, quiet when done (its
  solid neutral done diamond kept), empty or paused (its mark in `--gray`), and
  unblocked edges as green dots. `critical` numbers the critical path and lets
  the rest recede. Switching never moves a box: the layout ignores the
  highlight, so one `layout` serves all three. The frame carries
  `data-highlight` (and `data-locked` while a node is locked); nodes carry
  `data-state` (`active`, `lit`, `down`, `chain`, `dim`), `data-pointed` (the
  box being read), `data-locked`, `data-readiness`, `data-next` and `data-step`.
- `GraphNodeData.readiness` (`GraphNodeReadiness`: `state` ready, blocked, done,
  independent or empty (a box nothing counts toward, walked like done but read
  as its `statusLabel` or "No issues", never "Done"); the chip `label`, "Ready",
  "Blocked by 2", "Clear", `''` when done or empty; an independent node (on no
  relation at all) has the word "No dependencies" in its name and readout but no
  chip, and draws neutral; the Status `tone`; `blockedBy`; `unblocks`;
  `canStart`). Count `blockedBy` (open blockers) and `unblocks` (what finishing
  it alone frees) over all of your data, not only what is drawn: the readout
  says the difference is "not drawn". Set `canStart: false` on a box whose open
  work all waits inside it, so "start with" never points at it. The readiness
  chip leads a node's chips in every highlight (toned only under Status), so
  measure with `measureNode` or `layoutGraph` from the same data. Without
  `readiness` the Status highlight falls back to `tone` and the walks to the
  drawn edges. `GraphNodeData.key` (an id such as "ENG-23") is how the readout
  names a node; else its label.
- Edges: the `resolved` kind means one end is done (the blocker, or the node
  that waited), so it no longer blocks; it is drawn as dots and never walked.
  `GraphEdgeData.cross` marks an edge that crosses a project (or owner) boundary
  whatever its kind; Status and Critical path dash it while it blocks and is not
  a cycle.
- Paths: hover, keyboard focus, the lock or the selection lights what the node
  transitively waits on (an accent ring and accent lines) and what waits on it
  (a `--text` ring and `--text` lines), over the drawn edges; a `pathWords.next`
  tag ("Ready next", a green dot pill riding the box's top edge) marks each node
  that finishing it alone would unblock. The node being read (hover, keyboard
  focus, the lock; not the selection) gets the soft accent tint under an accent
  ring on every input, with a 4px double `CanvasText` outline in forced colours
  (the selected node gets one too, its tint being dropped there). Receding nodes
  set `--text-3` on their words directly and nothing but the fills and the rings
  fades, so a hover stays cheap on hundreds of nodes. Accessible names give the
  same counts ("waits on 1, holds up 3; done would unblock 2"; "waits on 1,
  holds up 0 in this graph; done would unblock 1 (1 not drawn)" when your
  readiness counts more than is drawn), transitive while `V × (V + E)` stays
  within `PATH_NAME_BUDGET` (V counting only the nodes on a blocking edge, so a
  graph of every item with few arrows stays transitive) and direct above it, so
  a host with no draw limit never runs a quadratic walk in render.
- The critical path is the longest chain of blocking drawn edges, a cycle
  counted as one step weighing its member count, ties going to display order;
  with a node active, the longest chain through it; in a chain graph at rest,
  the one through `focusId`. It is computed in O(V + E) per edge list, shown
  only when it holds two or more nodes, and its names carry "step k of s on the
  critical path". Entering `critical` (a new `highlight`, or the first paint
  with no `focusId` or `selectedId` to centre) scrolls the frame to step 1 of
  the path shown at rest unless one of its steps already shows whole or a node
  is locked. With a node on an open chain locked, the path shown at rest (and
  the one the step control walks) is the chain through it. A step control over
  the frame's bottom-left corner (`data-graph-steps`: ‹, "3 steps" / "Step 2 of
  3", ›) and the keys `]` / `[` walk that path: the walked step is the box being
  read (the accent tint and ring, the readout) and the frame centres it; Escape,
  a tap on the background, a press on a box or another highlight drops it (it
  lights over a lock until then).
- `DependencyGraph` `readout`: one plain (not live) line, the graph panel's last
  row, names the node being read and its paths ("ENG-23 · Blocked by 1 · Waits
  on 1 open, start with ENG-12 · Holds up 1 · Done would unblock 1: OPS-20");
  with nothing active it shows this text (your summary for the highlight) and
  how to trace a node (`hint` / `tapHint`, or `hintCritical` / `tapHintCritical`
  under Critical path: "show the longest chain through it"). With nothing drawn
  waiting on the node it says "Nothing here waits on it" (`holdsUpNone`). `null`
  hides the line. `pathWords` (`Partial<GraphPathWords>`, defaults in
  `defaultGraphPathWords`) rewords any part, the tag included.
- Lock on (`lockedId`, `onLockChange`): a click, a tap, Enter or Space on a node
  locks it, so its paths, tags and readout stay lit while the reader pans (a
  drag from the background, or from a box past 8px, which also drops the trace
  the press's focus gave that box), scrolls, zooms, fits or switches the
  highlight. While a node is locked, pointing at or focusing another moves
  nothing (CSS gives a hovered box off the lock's paths the `--surface-2` hover
  fill and a thin neutral ring, 1px `--control-border` 2px out, a box on them
  keeps its path ring, the locked box itself keeps its accent tint under the
  pointer, and no state is set, so a locked graph does not re-render on hover).
  A second press on the locked node opens it (`onSelect`, else its link; a node
  that opens nothing is unlocked instead). `onSelect` may be called again for
  the node already open (a third click, Open pressed twice), so a host must
  open, never toggle (the planner's panel used to close). A mouse's second click
  waits out `DOUBLE_CLICK_MS` (500 ms, the longest common double-click time) and
  a tap's `DOUBLE_PRESS_MS` (300 ms) when the node has a `drillHref`, so a
  double-click never opens it on the way, and a key opens at once. The locked
  node gets its own mark (`data-locked`, `data-lock-mark`: four rounded 2px
  accent corner ticks inside the box, over the tint and ring of the node being
  read, never a ring of its own, so the keyboard focus ring still shows on it
  and a focus preview, a lock and a focused lock look different; in forced
  colours the double rule of the node being read plus `Highlight` ticks) and an
  action strip riding the box (`data-graph-lock-strip`: a small floating
  `--surface` bar with `--r` corners and `--shadow-pop` holding Gr8r buttons in
  sentence case, Open the one primary, Open graph a secondary when it has a
  `drillHref`, an × Unlock icon button; `data-lock-action` on each), drawn in
  the canvas at the box's zoomed place but its own size (26px tall buttons, at
  least 32px wide on a coarse pointer), 4px out (room for the path and focus
  rings). `lockStripPlace` (exported for hosts' tests) puts it under the box,
  over it, or beside it on the right or the left (a side none of the box's own
  arrows use), the first that fits whole on screen (the frame's visible part,
  clipped to the visual viewport and clear of bars marked
  `data-ui-edge-bar="top"` / `"bottom"`, as the shell's top bar and phone tab
  bar are) and meets no blocked control (the step control), covering the fewest
  words (`data-graph-words` on each box's words and group titles, and the frame
  titles); with none, the one most on screen. It slides to stay inside the frame
  but never off the box's side, and is placed again on every scroll of the frame
  or the page and every resize without a re-render, finding the frame from its
  own element (so a lock from the first render is placed too). The strip follows
  the boxes in the DOM, so Tab from the box reaches it. The readout leads with
  `pathWords.locked` ("Locked on", semibold in `--accent-ink`) and the same
  actions as small inline buttons (`open` the primary, `openItsGraph` and
  `unlock` secondaries, so the three read as one group of controls), then a
  short vertical rule (`aria-hidden`, a border so forced colours keep it) in
  place of the facts' first " · ", then the facts. Escape (from anywhere on the
  page, heard on the window after every nearer handler, so an open panel's or
  menu's own Escape, or one typed into a field, goes first), a click on the
  background (never the end of a pan), Unlock, or a press on another node (which
  moves the lock) drops it; while locked, a new `selectedId` from the host moves
  the lock to it. A polite `role="status"` line says the lock once ("Locked on
  ENG-23 Typo tolerance.", "Unlocked."); a button node exposes it as
  `aria-pressed` (no longer the selection), a link or plain node as
  `aria-current`. Leave `lockedId` undefined and the graph keeps its own lock;
  pass it to keep the lock yourself (the planner keeps it in `?lock=`). The
  first paint centres the locked node, before `focusId` and `selectedId`. On a
  touch press a tap locks, a second tap opens, two taps within `DOUBLE_PRESS_MS`
  drill down, and a tap on the background unlocks (the focus a tap gives a
  button in Chromium never traces on its own).
- Drill down (`GraphNodeData.drillHref`, `GraphClusterData.drillHref`,
  `onDrill`, `drillHrefFor`): a double-click, a double tap or Shift + Enter on a
  node follows its `drillHref` (its own graph, one level down, in the planner;
  on a node with none they lock and open it, as a second press would), and a
  double-click on the title of a frame with one follows the frame's (the title
  gets a zoom-in cursor and `data-graph-drill`, and a single click on it does
  nothing). The locked node's strip and readout offer it as a link, so it is
  never reachable only by a double-click. `drillHrefFor` rewrites every drill
  href before it is drawn or followed (the planner adds the highlight on
  screen); `onDrill` follows a double-click (default: `window.location.assign`).
  A double-click selects no text (boxes and drilling titles are
  `user-select: none`, and the second press's mousedown is prevented), and the
  frame is `touch-action: manipulation`, so a double tap never zooms the page.
  Without a `hint`, the toolbar says "Click to lock · Double-click to drill in ·
  Drag to pan · Ctrl + wheel to zoom" (the drill part only when something
  drills).
- **Cap what you draw.** Without `clusters` one layout costs about 0.45 s at 200
  nodes and 300 edges (dagre network-simplex; edges dominate) and grows fast
  past that (about 1.3 s at 400 and 600). With `clusters` (measured 2026-10-23
  after the review fixes on workspace-shaped graphs: frames per project and
  milestone, a fifth of the issues done) the layout alone is about 0.1 s at 200
  and 300, 0.3 s at 500 and 800 and 0.35–0.75 s at 700 and 1000 whatever the
  shape, from one milestone holding everything (0.64 s) to 140 projects; a hover
  at 700 nodes still costs about a tenth of a second of frames on a slow
  machine. Decide a limit in the host and offer a narrower graph instead of
  drawing a bigger one, or part of one.
- `TimelineGroup.link` (`TimelineGroupLink`: `label`, `href`, optional
  `ariaLabel`): a quiet link in a ghost button's look with a group's "N
  projects", rendered through the host `<Link>`: in the chart's group row it
  sits under the count, in one right-aligned column, so the group name keeps its
  width; in the phone card's group head it follows the count, and the name
  ellipsizes before it gives way. Pass `ariaLabel` when several groups share the
  label ("Dependency graph of Payments platform").

### Shell options for a desktop host

- `AppShell` `sidebarShortcut={false}` leaves "[" unbound (a host that owns its
  own shortcuts): the brand-row button still collapses the rail, the button
  stops advertising the key (`aria-keyshortcuts`, its title) and the "?" sheet
  lists no Sidebar group.
- `AppShell` `chromeAttributes` are spread onto the brand row and the topbar,
  the shell's window chrome: a Tauri host passes
  `{ 'data-tauri-drag-region': '' }` so dragging either moves the window. The
  brand row also reads `--shell-brand-inset` (default 0) as extra left padding,
  expanded and collapsed, so a window with an overlay title bar can set the row
  in from macOS's traffic lights: set it on the shell's wrapper or above.
- `toggleShellCollapsed(storageKey?, defaultCollapsed?)` collapses or expands
  the rail from outside the component, exactly as the brand-row button does (it
  flips `html[data-shell-collapsed]`, saves the choice under `storageKey` and
  returns the new state; the shell re-renders through its attribute observer),
  for a host that keeps "[" for itself and binds the key in its own keyboard
  layer.
- `AppShell` `signOut` is either the form post (`{ action, method: 'post' }`, a
  real `<form>` that works before JS) or a callback
  (`{ onSignOut: () => void }`, the same icon button as `type="button"`);
  `isSignOutForm` is the type guard (an `in` check, which narrows under a host
  without `strictNullChecks`).
- `CommandPaletteProvider` / `CommandPalette` `onSubmitFreeText(query)` takes
  the typed text itself as a command (make a task from it, ask an agent). While
  it is given and the query is not blank, Tab submits the trimmed text (the
  palette closes first) instead of walking to the next section, and the footer
  shows the action in the "Tab Sections" hint's place as a button
  (`freeTextLabel`, default "Use text") for a pointer or a phone; Shift+Tab
  still cycles sections backwards, an empty query keeps Tab's section walk, and
  text `refuseQuery` refuses is never submitted.
- `AssigneePicker` people (`PersonChoice`) may carry a `group` (a heading, e.g.
  "Agents"; ungrouped people list first) and a `mark` of their own (a
  `PickerMark`, e.g. `{ kind: 'node', node }` for an agent's glyph) in place of
  the initials avatar.

### Task detail slots for a desktop host

How Dispatch's 620px slide-over (a row click, Space, "quick look") and its full
page host their controls in `TaskSlideOver` and `TaskDetail`. The order of the
sections is Gr8r's task drawer and is not configurable: header bar, title,
status line, alerts, properties, `rail`, Description, Blocked by, Blocks,
Comments, Activity, `children`.

- **Header.** `headerActions` render in the drawer's 46px bar before the Close
  button (`SlideOver`'s `actions` slot): Open page, Copy id / Copy link as quiet
  `Button`s, and a "⋯" `PickerPopover` with `action` and `searchable={false}`
  for Archive and Drop (`align="end"`); on a phone a worded action with an icon
  shows the icon only. `titleControl` (an `InlineTextField`) is the drawer's h2,
  and `title` still names the dialog. Nothing to add here: the slots exist.
- **Esc closes the nearest thing first.** `SlideOver` listens on `document` and
  closes only when the Esc keydown is not `defaultPrevented`: an open
  `PickerPopover` (the "⋯" menu, a property picker), an `InlineTextField` or
  `TextAreaEditor` being edited, and any host control that calls
  `preventDefault()` on Esc take it first; the next Esc closes the drawer.
- **Work.** Dispatch's Work block (the dispatch button, the latest runs) goes in
  `rail` as a `TaskDetailSection`: right after the properties in the drawer, so
  above the description and the relations, and in the properties rail beside the
  main column on the page. There is deliberately no slot between Description and
  Blocked by.
- **Acceptance criteria** (and any other host section) are `children`: a
  `TaskDetailSection` (title, `count`, `meta` such as "2 of 3 met") holding a
  `Checklist`, after Activity in the main column at the sections' heading level.
  `sectionMeta` puts a control in a built-in heading (an Edit button on
  Description, "+ Add" on the relations).
- **Description.** `content` is the host's rendered body (its markdown). With
  `clampContent` it is clamped to `clampLines` too, by height with a fade over
  the last lines (its blocks have line heights of their own), with the same Show
  more / Show less, measured in the browser (`text` is the first guess, so pass
  the source too). Off by default, since `content` may be an editor (the
  planner's `TextAreaEditor`, whose read view clamps itself).
- **Comments.** `TaskComment.reply` draws a reply one avatar column in under the
  comment it answers and speaks "Reply," before its author (`labels.reply`, or
  `TaskCommentList`'s `replyLabel`); the host orders each root before its
  replies, and the list stays one flat `<ol>`. `actions` render at the end of
  the comment's head row (the viewer's own "⋯" menu: Reply, Edit, Delete; the
  head is a `div`, so a menu's layer nests validly), and `footer` under the body
  (a reply box opened from that menu, a "Not saved" line). Editing a comment is
  `content` set to a `TextAreaEditor`; the composer for a new comment stays
  `TaskCommentsData.composer`.

### Edit controls

Every edit control is controlled and saves through one contract: `onChange` /
`onSave` / `onSelect` may return a promise. While it is pending the control
shows the new value with a "Saving" note; when it resolves the value stays; when
it rejects the control rolls back and prints the error beside itself
(`formatError` turns the rejection into that sentence, `saveErrorMessage` is the
default). Returning nothing means "saved".

`PickerPopover` is also the family's menu: `searchable={false}` drops the search
row (the list takes focus; ↑/↓, ↵ and Space pick, Esc closes) and the key-hint
foot, and with `action` every pick is an action rather than a value (a row's
"…", Filter, Sort, Group). Two more trigger appearances serve lists: `cell` (the
trigger takes the cell's own voice, so its text sits where the plain value
would, with a soft `--surface-3` pill on hover) and `bar` (a ghost action on the
bulk bar's inverted pill: `--text-inv` at 0.85 opacity, with a faint light wash
on hover and while its popover is open). A multiple picker whose groups each
hold one choice (Sort, Group) takes `marks="tick"`: the single picker's trailing
tick instead of checkbox squares. A `PickerOption.tone` colours the trigger's
face text (from the `data-tone` hook) while that option is the value shown, a
pending one included; `PriorityPicker` takes it per level as `priorityTones` (a
list cell's `{ 1: 'danger' }`: "Urgent" red the moment it is picked, a pending
"High" never red). `anchorPoint={{ x, y }}` opens the popover at a viewport
point instead of under its trigger (a context menu at the pointer; a phone keeps
its sheet). `returnFocus={() => element}` sends focus there instead of to the
trigger when the picker closes on Esc, a choice or a close button (a picker a
host's single-key shortcut opened from a row's title goes back to that title);
Tab and an outside click are unchanged. A disabled option wraps, so a menu's
note or a reason can be a whole sentence. `useModKeyLabel()` is "⌘" on Apple
platforms and "Ctrl" elsewhere (the server renders "Ctrl"), for a host's own
shortcut rows.

## Browser behaviour hosts should know about

All of it runs in effects and event handlers on the client; server rendering
touches none of it.

- `ThemeToggle` writes `html[data-theme]` and `localStorage`.
- `AppShell` writes `html[data-shell-collapsed]` (and removes it on unmount),
  binds `[` to collapse the sidebar (unless `sidebarShortcut` is false), and
  locks `<html>` scrolling while the phone drawer is open.
  `sidebarCollapseScript(key)` is its pre-paint script.
- `CommandPaletteProvider` binds Ctrl/⌘ K, `?` and two-key `G …` shortcuts on
  `document`. Do not mount it in a host that has its own command palette. Its
  API's `isSequencePending()` is true between a sequence's first key and its
  second (1.2 s): React handlers run before that document listener, so a host's
  own single keys can check it and stay out of a chord's way.
- `TaskGroupTable` with `drag` reads `(hover: hover) and (pointer: fine)`
  through a media query and appends (then removes) a drag-image element.
  `BulkBar` is `position: fixed` and lifts itself above
  `[data-shell-tabbar='true']` on phones, as the toasts do; while it is up it
  publishes its height to `useBulkBarHeight()` (null when it goes) and the
  toasts stack above it.
- `DependencyGraph`, while a node is locked, listens for Escape, scroll and
  resize on `window` and for scroll and resize on `window.visualViewport`, and
  reads the rects of `[data-ui-edge-bar]` elements (which `AppShell` puts on its
  top bar and phone tab bar) to keep the lock's strip on screen.
- `SlideOver` closes on Esc and traps focus; `TaskGroupTable` can persist folded
  groups in `localStorage` or `sessionStorage` (`storage="session"` suits a
  desktop app). Storage failures are tolerated everywhere.

## Server rendering

Every component renders with `react-dom/server` and no DOM
(`test/*-ssr.test.tsx` run render entries in a child process without happy-dom).
Media queries, storage and the platform's modifier key are read through
`useSyncExternalStore` with server snapshots, so hydration matches.

## Checks

```bash
moonx ui:typecheck        # tsgo --noEmit --pretty: strict, noUnusedParameters,
                          # erasableSyntaxOnly
moonx ui:typecheck-host   # tsc -p tsconfig.host.json: not strict, as a host
moonx ui:test             # bun test; includes test/styles-scope.test.ts: every
                          # selector in the global sheet must be scopable, and
                          # the system theme must equal the dark one
```

Repo-wide, `root:lint` (oxlint, the strict profile with jsx-a11y and
member-sorted imports), `root:lint-css`, `root:lint-spelling` and
`root:lint-deadcode` cover this package too.
