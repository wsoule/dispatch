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
`.num` (tabular figures), `.toneText` (with `data-tone`: a status word in the
tone's text colour), `.accentLink` (underlined), `.button`, `.buttonPrimary`,
`.input`, `.select`, `.textarea` (with Gr8r's focus ring and a red
`aria-invalid` state), `.notice`, `.empty` and `.hatched` (a dashed edge).

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
planner wants (it owns the page). The Dispatch desktop runs page mode too:
`apps/desktop` sets no `data-bt-ui-scoped`.

### Scoped mode (embedding in an app with its own design system)

Page mode would take over a host that has its own design system (one that loads
Tailwind, say): both may define `--accent`, `--accent-hover`, `--border`,
`--surface`, `--text`, `--font-sans` and `--font-mono` on `:root` (and the page
column is named `.pageBlock` so a host's Tailwind `block` utility never gets its
1440px max-width, 40px margin and 48px padding); and the unlayered reset
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
- Overlays (`PickerPopover` and the pickers, `Popover`, `Tooltip`, `Dialog`,
  `ConfirmDialog`) use the browser's top layer but stay DOM children of the
  wrapper, so they keep its tokens. Nothing is portalled to `<body>`.

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
live through `prefers-color-scheme`, with no script. Without any of these the UI
is light, whatever the OS says.

A person's choice is a `ThemeChoice`: `'system'`, `'light'` or `'dark'`. Only
`'light'` and `'dark'` are stored, in `localStorage` under a key the host picks;
no key means System. Dispatch stores a choice under `dispatch:theme` and runs
`themeScript` with `fallback: 'system'`, so with nothing stored it keeps
following the OS live (its Playwright `colorScheme` projects rely on that).

- `themeScript(storageKey, opts?)` returns a parser-blocking script for the
  first child of `<body>`: a stored `'light'` or `'dark'` is written to
  `html[data-theme]` before first paint (no flash). Without one, `opts.fallback`
  decides:
  - `'os'` (the default, the same script as a call without `opts`): the OS
    preference, read once through `matchMedia`, and `'light'` when storage
    throws (private mode).
  - `'system'`: `data-theme="system"`, for a missing, `'system'`, empty or
    unknown value and when storage throws, so the page follows the OS live.

  The emitted code is ES5, `var` and function expressions only, so Safari 14
  runs it; the key goes in through `JSON.stringify`.
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

    Dispatch passes `themeScript(THEME_STORAGE_KEY, { fallback: 'system' })`.

- `lib/theme.ts` (`themeScript`, `themeChoiceOf`, `ThemeChoice`) touches no DOM
  and imports nothing, so it is safe in Node: a Vite config imports the subpath
  `@dispatch/ui/lib/theme.ts`, never the package index (which pulls in React
  components).
- `themeChoiceOf(value)` parses a stored string: `'light'` and `'dark'` are
  themselves; nothing, `''`, `'system'` and any other value are `'system'`.
- `readThemeChoice(storageKey)` returns the stored choice, or `'system'` when
  nothing usable is stored or storage throws.
- `applyThemeChoice(storageKey, choice)` sets `html[data-theme]` to `choice`
  first (through `showTheme`), then stores `'light'` or `'dark'`, or removes the
  key for `'system'`. When storage throws, the theme still changes and simply
  does not persist. A settings control that offers System, Light and Dark calls
  it and shows `themeChoiceOf(document.documentElement.dataset.theme)`, not
  `readThemeChoice`: `ThemeToggle` changes the attribute even when storage
  throws, so a storage read would say System while Dark is on screen. `storage`
  events do not fire in the document that wrote, so the control watches
  `html[data-theme]` to stay in step with `ThemeToggle`; one `storage` listener
  for the page (not one per control) shows a choice made in another window.
- `showTheme(theme)` writes `html[data-theme]` without animating the change:
  `data-theme-switching` on `<html>` turns every element's transitions off
  (`tokens.css`) for the frame that first paints the new theme and comes off one
  frame later, so rows and buttons that transition their colours change with the
  surfaces behind them. `ThemeToggle` and `applyThemeChoice` call it; a host
  that writes the attribute itself (a `storage` listener) should too.
  Pseudo-elements are left out (a universal `::before`/`::after` rule is costly
  in WebKit), so a module whose `::before` or `::after` transitions a colour it
  draws at rest turns that off under `:root[data-theme-switching]` itself, as
  the picker's pills do.
- `<ThemeToggle storageKey={KEY} />` flips `html[data-theme]` and saves the
  choice under the same key. It assumes `themeScript` ran (it toggles from
  whatever `<html>` says; from `system` it switches to the opposite of what the
  OS shows). Its glyph follows the nearest `data-theme` ancestor. It only flips,
  so a way back to System goes through `applyThemeChoice(KEY, 'system')`.
- `localStorage` is per origin, so the choice is too. In a browser each origin
  keeps its own: each Dispatch daemon port is an origin, so a choice made on one
  project's port does not carry to another. The Tauri app has one origin, so
  there the choice holds everywhere. A choice does not roam between machines.
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
  fill only; default is the accent; its progressbar reads "3 of 7 done", and
  `valueText` says what a meter of something else counts, such as Dispatch's
  agent slots: "2 of 4 slots in use", `warning` once they are all in use),
  `RegisterCell` (the value only; the `sub` line under it stays secondary text
  unless `toneSub` opts it in, for a reason line that is the point: a blocked
  project's reason, a failed sync's error) and `StatsStrip` draw every tone; a
  `RegisterRow`'s tone is data only (no rule: the row says it with a chip or a
  toned cell). `Button variant="danger"` is a red fill. A status word in running
  text or a host's own cell is a span with the global `.toneText` class and
  `data-tone` (`<span class="toneText" data-tone="danger">Failed</span>`):
  `color: var(--tone-ink)`, which holds 4.5:1 on `--bg` and `--surface` for
  every tone in both themes (`test/styles-contrast.test.ts`); a bare `data-tone`
  keeps the surrounding colour. It replaces a raw hue read (`color: var(--red)`)
  for words; the words still say the status. `Checklist` (the rubric) keeps a
  met item a neutral disc with a tick, like done, so a missing item's dashed
  amber ring and "Missing" chip are the only hue in the list. With `onToggle`
  its items are `Checkbox` rows a person ticks (ReviewMode's criteria) and carry
  no hue at all: a person's own ticks are not a status.
- `TaskStateKind` (Linear's state types): `triage`, `backlog`, `unstarted`,
  `started`, `completed`, `canceled`, drawn by `StateGlyph` in the `--st-*`
  colours (in progress a blue half disc, done a green disc with a tick, triage
  and backlog dashed grey rings, canceled a struck grey ring, todo the neutral
  ring).
- `TaskPriority`: `0` none, `1` urgent, `2` high, `3` medium, `4` low, drawn by
  `PriorityGlyph` (urgent a red rounded square with a "!", none three dashes,
  the rest `--text-2` bars).
- Progress: `ProgressPie` (`done`, `total`, `label`; `size` 12, 14, 16 or 20px,
  default 12; `tone`) is Linear's progress pie, the "◔ 3/8" beside a sub-issues
  count or a milestone's landed work: an r=6 ring (stroke 1.5) and an r=2 pie
  stroked 4 wide in a 14-unit viewBox, the pie drawn from twelve o'clock by its
  dashoffset. The ring is the tone's tinted line (`--tone-line`) and the pie its
  hue (`--tone`), from `data-tone`; with no tone, the 3:1 control edge
  (`--control-border`, so an empty pie's ring stays visible) and the secondary
  ink. `done / total` is clamped to 0..1, and a `total` of 0 draws an empty pie
  (never NaN). It is `role="img"` named by `label` ("3 of 8 done"); `label=""`
  makes it decorative (`aria-hidden`, no role) for a host that prints the count
  beside it, as `Spinner` does. Forced colours keep both strokes in CanvasText.
  `PIE_DASH` (12.189379495928398, the arc's length) and
  `pieDashOffset(fraction)` (`PIE_DASH * (1 - fraction)`) are exported for a
  host's own status icons, so a half-done milestone pie matches a task in
  progress.
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
- `ToastKind`: `info`, `error`, `success` (a green check, spoken politely like
  `info`; its default lead-in is "Done"). A `ToastInput` may carry `label: ''`
  to show the sentence with no lead-in word (screen readers still hear the
  kind's default), `announce` (what the live region says in place of the visible
  sentence) and `onClose` (called once when the toast leaves the stack, however
  it goes).

Every status mark carries a text label for assistive tech (`label` /
`statusLabel` props). Wording is the host's: components that print built-in
words take a `labels` prop (`DEFAULT_TASK_LABELS`, `DEFAULT_EDIT_LABELS`).

## Components

Props are typed in each family's `types.ts` (the basics in their own files) and
exported from the package root (`TaskDetailProps`, `TimelineChartProps`,
`StatusMarkProps`, `BlockBarProps`, `TabsProps`, `ThemeToggleProps`,
`UiLinkProviderProps`, `PickerMarkViewProps`, …). Required props are listed; see
the types for the rest.

| family   | component                                                                                                                        | required props                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| basics   | `StatusMark`                                                                                                                     | `status`, `label`                                                   |
|          | `BlockBar` (a section heading row; `index` is ignored)                                                                           | `title`                                                             |
|          | `Tabs` (prefixed ids; `label` names the tablist; empty renders nothing; `value` and `onChange` control it; host panel below)     | `items: TabItem[]` (`id`, `label`, optional `content`)              |
|          | `ThemeToggle`, and under Theme `themeScript`, `readThemeChoice`, `applyThemeChoice`, `showTheme`, `themeChoiceOf`, `ThemeChoice` | `storageKey`                                                        |
|          | `InitialsAvatar` (round, a pastel hue from the name; blank = nobody), `avatarHue(name)`                                          | `name`                                                              |
| tasks    | `Button` (primary, secondary, quiet, danger; `size` sm / md / lg; `block`)                                                       | none (`href` renders a link)                                        |
|          | `Checkbox` (`indeterminate` for a partly selected group), `Switch` (`hideLabel`), `SegmentedControl`, `Chip`                     | see `tasks/types.ts`                                                |
|          | `ChipButton` (a chip that is a button, a toggle with `selected`, or a link with `href`; below)                                   | `children`                                                          |
|          | `SearchField` (a search box with a clear button; Escape clears; below)                                                           | `value`, `onChange`, `label`                                        |
|          | `CopyValue` (a value in a code well with a Copy button; below)                                                                   | `value`, `label`                                                    |
|          | `CodeBlock` (code in a Geist Mono well: filename, language label, actions, Copy, wrap, `maxHeight`, host `tokens`; below)        | `code`                                                              |
|          | `TaskGroupTable` (grouped issue list; selection, drag and slots below)                                                           | `sections`                                                          |
|          | `ViewToolbar` (list toolbar: an optional search, the host's Filter / Sort / Group, end actions), `ToolbarBadge`                  | `controls` (`search` optional)                                      |
|          | `FilterChips` ("Project is …" chips joined by "and", + Filter, Clear all)                                                        | `chips`                                                             |
|          | `BulkBar` (the floating bar of a selection; confirm strip, busy, note), `useBulkBarHeight()` (its height while up)               | `count`, `onClear`, `children`                                      |
|          | `DeadlineList`, `StatsStrip` (`data-*` on the list and each cell; a cell's `title` hint), `ProgressRule` (`valueText`, `data-*`) | `groups`; `cells`; `done`/`total`                                   |
|          | `Register`, `RegisterRow` (`pressed` on a button row), `RegisterCell` (`span="row"` takes the whole row)                         | `columns`, `label`, `children`                                      |
|          | `Notice` (`role` status, alert or note), `EmptyState` (a centred icon, optional `label` title, the sentence, an action)          | see `tasks/types.ts`                                                |
|          | `NavTabs` (`items`, or `groups` for a grouped vertical sub-nav; below), `Checklist` (the rubric; `onToggle` for Checkbox rows)   | `label` and `items` or `groups`; `items` (`onToggle` optional)      |
|          | `Disclosure` (a fold: a trigger and the panel it shows or hides; below)                                                          | `children`                                                          |
|          | `SectionHeader` (a heading row over a band of rows: fold chevron, tone, count, actions, "+"; Lists below)                        | `name`                                                              |
|          | `ProgressPie` (Linear's ring and pie, done of total; Status vocabulary above)                                                    | `done`, `total`, `label`                                            |
|          | `ListItem` (a row of a host's own list: leading, title and crumb, meta, trailing, date; below)                                   | `title`                                                             |
|          | `Panel` (a bordered box with a 40px heading row), `PanelRow` (its rows; `onActivate`, `urgent`; below)                           | `children`                                                          |
| shell    | `AppShell` (sidebar, topbar, phone tab bar; `workspaceSwitcher` makes the brand row a workspace menu, below)                     | `appName`, `brandHref`, `nav`                                       |
|          | `CommandPaletteProvider` + `CommandPalette`                                                                                      | none; pass `navigate` (the default is `window.location.assign`)     |
|          | `ToastProvider` + `useToast()` (`useOptionalToast()`: null without a provider)                                                   | none                                                                |
|          | `SlideOver` (`contentKey`: a swap in place moves focus; `modal`, `size`, `footer` for a form surface)                            | `open`, `onClose`, `title`                                          |
|          | `Dialog` (a centred modal: sm / md / lg), `ConfirmDialog` (an alertdialog before a destructive write)                            | `open`, `onClose`, `title`; `confirmLabel`, `onConfirm`, `onCancel` |
|          | `useModalSurface` (a host's own panel over a scrim, out of the top layer; below)                                                 | `open`, `onClose`, `panelRef`                                       |
|          | `Tooltip` (hover and keyboard focus, no provider), `Spinner` (in-flight agent or network work only)                              | `content`, `children`; none                                         |
|          | `SignedOutFrame` (`chromeAttributes` for a desktop host, below), `PropertyList`, `AlertStrip`                                    | see `shell/types.ts`                                                |
|          | `Skeleton*`, `Kbd`, `KbdKeys`                                                                                                    | see `shell/types.ts`                                                |
| timeline | `TimelineChart` (Gantt)                                                                                                          | `today`, `windowStart`, `windowEnd`, `zoom`, `groups`, `onOpenBar`  |
| graph    | `DependencyGraph`                                                                                                                | `nodes`, `edges`, `ariaSummary`, `emptyMessage`                     |
|          | `GraphLegend`, `MermaidSource`                                                                                                   | see `graph/types.ts`                                                |
| task     | `TaskDetail` (`layout="drawer"` or `"page"`)                                                                                     | `taskKey`, `title`, `status`, `properties`                          |
|          | `TaskSlideOver` (TaskDetail in a SlideOver)                                                                                      | the above plus `open`, `onClose`                                    |
|          | `TaskDescription`, `TaskRelationList`, `TaskCommentList`, `TaskActivityList`, `TaskCrumbs`                                       | see `task/types.ts`                                                 |
| edit     | `StatePicker`, `AssigneePicker`, `PriorityPicker`, `LabelPicker`, `ProjectPicker`, `MilestonePicker`, `EstimatePicker`           | the choices (`states`, `people`, …), `value`, `onChange`            |
|          | `PickerPopover` (the generic picker)                                                                                             | see `edit/types.ts`                                                 |
|          | `Popover` (a non-modal panel for a host's own controls)                                                                          | `open`, `onOpenChange`, `label`, `children`                         |
|          | `TaskRelationPicker`                                                                                                             | `label`, `search`, `onSelect`                                       |
|          | `InlineTextField`, `TextAreaEditor`                                                                                              | `label`, `onSave` (and `value` for the field)                       |
|          | `DateField`                                                                                                                      | `label`, `value`, `onChange`                                        |
| controls | `TextField` (field or inline; `start` / `end` adornments), `TextArea` (grows with its content)                                   | none (native attributes pass through)                               |
|          | `Field` (label, `hint`, `error`; the control inside takes its id and description)                                                | `label`, `children`                                                 |
|          | `Select` (a field-look `PickerPopover` without search), `RadioGroup` (native radios; `cards`, `badge`, `aside`, `children`)      | `value`, `options`, `onChange` (and `label` for Select)             |
|          | `Menu` (actions, radio rows, groups, separators, submenus; it and each open submenu are layers of the overlay stack)             | `label`, `trigger` (spread its props onto a `Button`), `items`      |

Pure helpers are exported too: the timeline's date scale (`createScale`,
`xForDate`, …), the graph layout (`layoutGraph`, `upstreamChain`, …), the
graph's path walks (`pathContext`, `nodePaths`, `longestChains`, `longestChain`,
`describePaths`, …), the palette's `fuzzyMatch`, the collapsed-group storage
helpers, the row-window arithmetic and `useRowWindows` (Lists below), the
progress pie's `PIE_DASH` and `pieDashOffset`, and the selection helpers
(`toggleId`, `rangeIds`, `setIds`, `pruneSelection`: pure, never mutating, and
returning the same set when nothing changes).

**Helpers.** `cx(...names)` joins class names and drops `undefined`, `null`,
`false` and `''` (a CSS-module lookup can be undefined, and "undefined" never
reaches the DOM). It has no merge semantics, which CSS modules do not need; a
host building its own components on modules uses it in place of `clsx` or a `cn`
helper.

**Host data attributes.** `DataAttributes`
(``{ [key: `data-${string}`]: string | number | boolean | undefined }``) types a
host's `data-testid` and `data-slot` hooks. `Button` (as a button and as a
link), `Popover`, `Dialog`, `ConfirmDialog`, `PickerPopover`, `SlideOver`,
`Disclosure`, `Menu`, `Select`, `RadioGroup`, `Chip`, `ChipButton`, `Switch`,
`Checkbox`, `Notice`, `SearchField`, `CopyValue`, `CodeBlock`, `Register`,
`RegisterRow`, `RegisterCell`, `SectionHeader`, `ListItem`, `Panel`, `PanelRow`
and `Tabs` take them and spread them, untouched, on their root element: the
`<button>` or the link, the popover's and the picker's `role="dialog"` layer
(not the trigger), the dialog's and the slide-over's panel (the `role="dialog"`
or `role="alertdialog"` element), the disclosure's wrapper, the open menu's root
layer (not the trigger; its submenus sit inside it), the open `Select` list's
layer (not the trigger), the `role="radiogroup"` element, the chip (or the chip
button's `<button>` or link), the switch's `role="switch"` button, the
checkbox's `<label>` (which holds the input), the notice's box, the search
field's wrapper (which holds the input), the copy value's `<code>` element
(whose text is exactly the value, so `data-testid="issued-token"` reads it), the
code block's root, the register's root, the row's `<li>`, the cell, the section
header's row, the list item's root (the wrapper of an `as="button"` row with
trailing controls), the panel's root, the panel row's `<div>` and the tab
strip's wrapper (which holds the tablist and its panels). The component's own
`data-*` attributes (`data-variant`, `data-picker-popup`, `data-popover`,
`data-state`, `data-open`, `data-tone`, `data-stack`, `data-disabled`, the list
item's and the code block's `data-slot`) win over a host's of the same name. A
host's link component receives them in `UiLinkProps` and spreads them onto its
anchor.

**Switch, Checkbox and Notice.** `Switch` with `hideLabel` keeps its label for
assistive tech only (a `.srOnly` span) and draws just the track, for a settings
row whose title already names it; `aria-label` and `aria-labelledby` still win.
`Checkbox` takes `onClick` on its native input, which runs before the box
toggles, so a box inside a clickable header can stop the click there
(`event.stopPropagation()`). `Notice` takes `role` `status` (polite, something
that just changed), `alert` (an error) or `note` (an aside that qualifies the
page, such as why it is read only); static copy needs none. A `Notice` reflows
by its own width rather than the viewport's: when the lead-in, a 12rem body and
the action do not fit on one line (a card in a narrow column), the body drops
under the lead-in and the action onto a line of its own.

### Tabs, controlled

`Tabs` is uncontrolled by default: a click, an arrow key, Home or End selects a
tab and moves focus to it. Pass `value` (the selected item's id) to control it:
a pick then calls `onChange(id)` and moves focus, but the selection moves only
when the host passes the new `value`; an id that names no item selects the first
tab. `onChange` fires in both modes, only for a tab other than the selected one.
The selected tab holds the strip's one tab stop in both modes.

An item's `content` is optional. An item with `content` keeps its own panel,
mounted and `hidden` while another tab is selected. An item without it shows the
strip's `children`, the host's own panel: one `role="tabpanel"` element whose id
is the selected tab's `aria-controls` and whose `aria-labelledby` is that tab.
It stays mounted while the selection moves between tabs without content (a host
list keeps its state and scroll), and is not rendered while the selected tab has
its own content. An unselected tab without content has no `aria-controls`, since
its panel does not exist yet.

The strip sits in a page column (`.pageBlock`) with a bottom margin, as a page
section does. Inside a pane that already sets its own width and gutter (a
drawer, a sub-page), pass `flush` to leave both out instead of overriding the
class from the host.

```tsx
<Tabs items={memoryTabs} label="Memory" value={tab} onChange={setTab} flush>
  <MemoryList entries={shown} />
</Tabs>
```

### Disclosure

`Disclosure` is Gr8r's fold: a trigger that shows or hides the panel under it
("Details" under an error, a tool call's arguments, "+3 more", a setup step).
The default trigger is a `<button type="button">` holding a 14px lucide chevron
(turned down while open, `chevron={false}` drops it) and `summary`, which may be
a function of `{ open }` ("Show log" / "Hide log"). `variant` draws it: `inline`
(the default, a quiet `--fs-xs` text button in `--text-2`), `bar` (a full-width
row on `--surface-2`) or `plain` (no chrome of its own). A `trigger` render prop
replaces the face with any button (a chip, a quiet `Button`, a host's bar): it
receives `{ open, props }` and must spread `props` (`aria-expanded`,
`aria-controls`, the toggling `onClick`, `type="button"`) on that button.

The panel is always in the DOM with the id `aria-controls` names (`id`, or a
generated one); closed, it is `hidden` (display: none) and its content
unmounted, or mounted and hidden with `keepMounted` (a form's state, a running
log). The wrapper carries `data-open` while open and the host's `data-*` hooks.
It works controlled (`open`, `onOpenChange`) or uncontrolled (`defaultOpen`,
with `onOpenChange` reporting each press). After a press the chevron turns and
the panel fades in (growing from nothing where the browser animates to height
auto), only under `prefers-reduced-motion: no-preference`; a fold open from the
first render does not move, and closing is instant. Forced colours keep the
chevron (`currentColor`) and the face's button edge.

### Button

`Button` is Gr8r's button: `variant` primary (the one purple fill of a view),
secondary (the default), quiet (the toolbar ghost) or danger (a destructive
write); `size` sm 26px, md 30px or lg 36px; `block` stretches it; `icon` and
`iconAfter` are 14px lucide icons; no children makes it a square icon button,
which needs an `aria-label`. `align="start"` lays the content from the start
edge instead of the centre, for a quiet `block` button whose content is a
summary line rather than a label (the task page's mini Flight Plan, which opens
the plan); the root then carries `data-align="start"`. With `href` it renders
through the host's link. A toggle passes `aria-pressed`: pressed, it takes the
accent's selection tint (`--accent-soft`) in a full `--accent` edge with
`--accent-ink` text, as a pressed `ChipButton` does; the edge holds 3:1 against
`--bg`, `--bg-side`, `--surface`, `--surface-2` and `--sunken` in both themes,
so the state reads without a check mark there (WCAG 1.4.11). On `--surface-3` it
falls short, so keep toggles off that ground. In forced colours it takes the
system Highlight, since the tint would turn into Canvas there and read as
unpressed.

It passes through what a host's own button needed: `ref` (the element, for a
Popover's or Tooltip's anchor and focus return), `id`, `tabIndex`, `form`,
`name`, `autoFocus`, `onKeyDown`, `onPointerDown`, `onMouseDown`,
`onPointerEnter`, `onPointerLeave`, `onFocus`, `onBlur`, `aria-describedby`,
`aria-haspopup` and the host's `data-*` hooks (the link forwards `data-*`,
`aria-describedby` and `onKeyDown`). `busy` marks a save or send in flight: the
button is disabled with `aria-busy="true"` and its text reads `busyLabel`
(default "Saving…"; an icon-only button keeps its icon). It never shows a
spinner.

From a shadcn-style button (as Dispatch's former `ui-legacy` had):

| Legacy                 | Gr8r                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| variant `default`      | `primary`                                                                         |
| `secondary`, `outline` | `secondary`                                                                       |
| `ghost`                | `quiet`                                                                           |
| `link`                 | a quiet Button, or a plain `button.accentLink` inside prose                       |
| `destructive`          | `danger`                                                                          |
| size `xs`, `sm`        | `sm` (26px)                                                                       |
| size `default`         | `md` (30px)                                                                       |
| size `lg`              | `lg` (36px)                                                                       |
| size `icon-*`          | no children, plus `aria-label`                                                    |
| `IconButton`           | a quiet sm icon Button; `filled` becomes secondary, `active` becomes aria-pressed |
| `PillButton`           | a secondary sm Button, or a `ChipButton` where it is chip-shaped                  |

### Chip and ChipButton

A default-tone `Chip` may lead with a decorative mark before its words (amended
2026-11-02, B5, L23). `hue` (an `AvatarHue`: `violet`, `teal`, `rose` or
`orange`) draws a 6px dot in that hue (`aria-hidden`, `data-hue`; one module
rule per hue, never a built variable name), for a label or project with no
colour of its own (`avatarHue(name)` picks one from the name, as the avatars
do). `mark` (a `PickerMark`) draws `PickerMarkView` at chip size (glyphs 12px,
an avatar 16px, a status diamond 10px, so the chip keeps its 20px height):
Gr8r's label chip is `mark={{ kind: 'swatch', color }}`, a neutral chip with the
label's colour in a small square, and a colour that is not a plain hex (a
`var(...)` string) draws the hollow square instead of nothing. `mark` wins when
both are given. Both are ignored for every other tone (a status tone keeps its
own dot or tint) and when `status` is set (the status mark takes the lead's
place). They are decoration: the words say what the chip is. Forced colours keep
the hue dot as a CanvasText ring. `ChipButton` draws both the same way.

`ChipButton` takes every `Chip` prop (tone, `filled`, `dot`, `status`, `hue`,
`mark`) and draws the same chip as a `<button type="button">`, or through the
host's link with `href` (a door to a place, a reference to open). Its accessible
name is its visible text (with a status mark's label). It adds a hover fill one
surface darker (a tinted chip shows its tinted edge instead, so its text stays
on its tint; the inverse slab keeps its fill), the 2px `--focus-ring` outline,
and a ButtonText edge in forced colours. `selected` makes the button a toggle
(`aria-pressed`, `true` or `false`; omit it for a plain action), drawn in the
accent's selection tint (`--accent-soft` in a full `--accent` edge, which holds
3:1 on `--bg`, `--bg-side`, `--surface`, `--surface-2` and `--sunken`, and
`--accent-ink` text); a link never carries it. `disabled` disables the button,
or turns a link into its text marked `aria-disabled="true"` (a link cannot be
disabled). It carries `data-chip-button` and the host's `data-*` hooks.

`ChipButton` passes a Tooltip's wiring to its button, as `Button` does: `ref`
(the `<button>` element), `aria-describedby`, `onPointerEnter`,
`onPointerLeave`, `onPointerDown`, `onFocus` and `onBlur`, so
`<Tooltip><ChipButton/></Tooltip>` places its tip beside the chip and shows it
on hover and keyboard focus. The link form, and a disabled link's text, take
`aria-describedby` only (the host's link receives `UiLinkProps`).

`Chip` takes `onRemove` (amended 2026-11-02, B7, L29): a trailing 14px quiet
button with a 12px lucide × (`aria-hidden`), the chip's only interactive child,
so the chip stays a `<span>` (a reference or an attachment in a composer, a
filter value the person can take back). Its name is `removeLabel`, by default
`Remove {children}` when the children are a plain string and plain "Remove"
otherwise, so a chip holding markup passes its own ("Remove about DIS-12"). The
× takes the chip's text colour (a tinted chip's tone ink, the slab's inverse
text), a hover fill one surface up and the 2px `--focus-ring` outline; it
carries `data-chip-remove`. `ChipButton` takes no `onRemove`: it is a button
itself, and a × inside it would nest one button in another (draw a `Chip` with
`onRemove` beside a separate action instead).

### CopyValue

`CopyValue` shows `value` in a recessed code well (`--sunken`, `--r-sm`, 12px,
Geist Mono unless `mono={false}`) and a small secondary button reading "Copy"
with a copy icon, named "Copy {label}" ("Copy token", "Copy code", "Copy invite
link"). A press writes the value with `writeClipboard` (exported, with
`COPIED_MS`, from `src/lib/clipboard.ts`; MermaidSource uses the same pair): it
then reads "Copied" with a tick for `COPIED_MS` (1600ms), or "Select it" when
the clipboard is missing (an insecure origin, an old webview) or refused, with
the value selected so Ctrl/⌘ C still works. Either way it returns to "Copy"
after `COPIED_MS`; the timer is cleared on unmount. The button's name never
changes; a polite live region (no role, so a page's own `role="status"` stays
the only one) says what happened. A long value wraps anywhere so it can be read
whole; `truncate` keeps one line with an ellipsis and the whole value in the
`title`. The host's `data-*` hooks land on the `<code>` element, whose text is
exactly the value.

### CodeBlock

`CodeBlock` shows `code` (the only required prop) as a `<pre><code>` on a
recessed well: `--sunken` in a 1px `--border` at `--r`, Geist Mono at `--fs-xs`
in `--text`. Each line is a block span (an empty line holds a space, so a blank
line keeps its height; the final line breaks draw no blank line at the end, and
the code's text keeps its newlines, so a hand copy does too). Long lines scroll
sideways under a thin scrollbar unless `wrap`, which breaks them anywhere (a
long token or URL too) and sets `data-wrap` on the root. `maxHeight` caps the
body (a number is px, a string any CSS length such as `"50vh"`) and the body
scrolls down past it. A body that scrolls takes a tab stop while it does
(measured after layout and on resize; WebKit gives a scrolling box none of its
own), marked by the global `:focus-visible` ring, and is then a `region` named
by the filename, else "\<language> code", else "Code", so the stop is never
unnamed; a short one takes none of these.

CodeBlock has **no colour of its own**: `language` is only a label in the header
("TypeScript", "json"), never a tokenizer switch, and a host maps a fence's
language tag to whatever words it wants shown. Syntax colour comes only from a
host's highlighter (main v0.51.0 brought Shiki to the desktop's Markdown
fences): `tokens` is `code` as the highlighter split it, one array of
`CodeBlockToken` runs (`{ content, vars }`) per line. Each run is a
`[data-code-token]` span carrying `vars` (custom properties only, such as
`--shiki-light` and `--shiki-dark`) as its inline style, and the host's own
sheet reads them, declares their defaults and checks their contrast. `tokens`
draws only when it holds exactly the lines the block draws and each line's runs
join to that line's text, so a stale highlight never shows text the block does
not hold; otherwise the plain lines draw. The header row holds `filename` (Geist
Mono, `--text`, truncated with the whole name in its `title`), the `language`
label (sans, `--fs-2xs`, `--text-3`), the host's `actions` (a wrap toggle, a
code or diagram switch) and, at its end, the Copy button; it is left out when
none of them is shown (`copy={false}` with no filename, language or actions).
`children` draws in place of the code (a diagram drawn from it): the header
stays and Copy still writes `code`.

`copy` (default true) draws a quiet small `Button` reading "Copy" with a copy
icon, named `copyLabel` ("Copy code" by default). A press writes `code` exactly
(final newline and all) with `writeClipboard`; the button then reads "Copied"
(and is named so) with a tick for `COPIED_MS` (1600ms), or "Couldn't copy" for
as long when the clipboard is missing or refused, with the code selected so
Ctrl/⌘ C still works, as `CopyValue` does. A polite live region says what
happened, the timer is cleared on unmount, and the button carries `data-state`
(`idle`, `copied`, `failed`). There is no motion. Forced colours keep the well's
edge (`CanvasText`) and give the quiet button one. The host's `data-*` hooks
land on the root, which carries `data-slot="code-block"` and `className`.

Sites: every Markdown fence in the desktop's `runs/Markdown.tsx`, and the
desktop ToolCard's write contents and JSON fallback for a tool call it has no
view for. A host stylesheet that styles `pre` or `code` inside its prose (a
Markdown scope) should leave `[data-slot='code-block']` alone, since its
selectors outweigh the module's.

### NavTabs groups

`NavTabs` with `groups` (`NavTabsGroup[]`: `{ label, items }`) in place of
`items` is a grouped vertical sub-nav (Settings' rail): one `<nav>` named by
`label`, each group a `role="group"` named by its `label`, which also shows
above its cells as an eyebrow (`.eyebrow`, `aria-hidden` so it is not read
twice, never a heading, so the page keeps its own `h1` outline; it carries
`data-nav-group-label`). The cells are the usual ones: host links with
`aria-current="page"` on the current one, `onFollow` taking a plain click,
`icon`, `count` and `note`, a dimmed span without `href`. `groups` is vertical
only and exclusive with `items` (`NavTabsProps` is the union
`NavTabsItemsProps | NavTabsGroupsProps`, so a call site passes one or the
other). At 900px and below the groups join the one sideways-scrolling strip of
every cell and the titles are hidden.

### Register

`Register`, every `RegisterRow` (link, button and plain rows) and `RegisterCell`
take the host's `data-*` hooks on their roots (the register's wrapper, the row's
`<li>`, the cell), so a host keeps its row hooks (`needs-you-row`, a roster's
`data-roster-title`) on Register rows. A button row that is a toggle (a project
filter) passes `pressed`, which sets `aria-pressed` on its stretched button
only; link and plain rows take no `pressed`, and the `<li>` never carries it. A
`RegisterCell` with `span="row"` takes every column, in the table and in the
stacked card layout, on a line of its own under the cells before it, and holds
its value in a block (an answer-in-place card inside a Needs you row). Any row
takes `title`, a hover hint over the whole `<li>` for a qualifier not worth a
column ("this machine only"); it is pointer-only, so say the same fact in words
somewhere a keyboard reaches. An `align="end"` cell fits its content but never
grows past its column (or, stacked, its half of the card): a long value wraps,
and a host value that is one line by design (a slug with `white-space: nowrap`)
clips with its own `overflow: hidden; text-overflow: ellipsis`.

`stackWithin` (the register's own width, a container query) takes 480, 600, 700,
900 or 1000. Pick the smallest step the columns' minimum widths fit in (the
tracks, a 20px gap between each and 28px of padding): a short register in a
settings page (three to five narrow columns) stays a table at the app's default
window size on 480 or 600, where 700 would turn every row into a card (amended
2026-11-02, B4, as an L35 follow-up: the steps started at 700).

### ListItem

`ListItem` is the row of a host's own list (the Overseer's columns and inbox, a
docked conversation, threads, memories, a stack; amended 2026-11-02, B7, L27):
40px, with its slots in reading order, each a `data-slot` hook and none with a
role: `list-item-leading` (a 14px glyph), `list-item-title` (13.5px medium, one
line that truncates) holding `list-item-crumb` (printed " › crumb" in
`--text-2`, truncating with the title), `list-item-meta` (a second line under
the title; the row grows to fit), `list-item-trailing` (the host's controls) and
`list-item-date` (at the far right). Meta and date are 12px `--text-2` in
tabular figures. The root carries `data-slot="list-item"` and the state the
module draws from: `data-selected` (the accent tint), `data-active` (a host
list's keyboard cursor, drawn as the focus ring inside the row whether or not it
holds DOM focus), `data-unread`, `data-indent` and `data-clickable`; hover is
`--surface-2` on a clickable row only. `unread` draws a 6px accent dot in the
left gutter (so read and unread titles stay in one column) with an sr-only
"Unread, " before the title (`list-item-unread`), never the colour alone.
`indent={1}` moves the row one step in with a connector on `--border`
(`list-item-connector`, `aria-hidden`).

Keyboard: with `onClick` the row takes a tab stop (`tabIndex` overrides it: a
host with a roving tab stop passes -1 to every row but its current one), and
Enter or Space call `onClick()` with no event only when typed on the row itself
(`event.target === event.currentTarget`) and not already handled
(`defaultPrevented`); a click calls it with the event unless it started on a
control inside the row (a link in the title, a box in the leading slot). The
trailing slot stops its clicks, and a plain Enter or Space typed on a control in
it, from reaching the row (the legacy hosts did this by hand); every other key
(Escape, Tab, the app's shortcuts) goes on to the document, so a dialog's focus
trap and Escape still work from a trailing button. `as` picks the root: `div`
(default), `li`, or `button` for a plain action row, a native
`<button type="button">` whose Enter and Space are its own. A button with
`trailing` is drawn as a wrapper `<div>` (the root: the slot name, the state,
`className` and the host's `data-*` hooks) holding the button and, beside it,
the trailing controls, never a button inside a button; the date stays inside the
button, part of its name.

`role` is the host list's: `listitem`, or `option` under a host listbox, where
`aria-selected` follows `selected` (no other role carries it); `domId` is the
DOM id a listbox's `aria-activedescendant` points at. The row element (the
button with `as="button"`) takes what a Tooltip clones onto its child: `ref`
(React 19's ref prop), `aria-describedby`, `onPointerEnter`, `onPointerLeave`,
`onPointerDown`, `onFocus` and `onBlur`, so `<Tooltip><ListItem/></Tooltip>`
works. Forced colours keep a Highlight edge on a selected row, a CanvasText ring
on the cursor and on focus, and the unread dot's fill; motion (the hover fill)
runs only under `prefers-reduced-motion: no-preference`.

### Panel and PanelRow

`Panel` is Gr8r's embedded box (amended 2026-11-02, B7, L28): `--surface` in a
1px `--border` at `--r-lg`, no shadow, with a 40px heading row ruled off by
`--divider` over its body. The row holds `heading` (13.5px medium `--text`, in
an `h3`, or `h2` with `headingLevel`), `count` (quiet `--text-3` tabular text
after the heading element, so the heading's name stays its words) and `actions`
at its end; there is no heading row without one of them. The body is padded
(`--s-3`, with an `--s-2` gap) unless `flush` (a list whose rows pad themselves;
the body then carries `data-flush`). `tone` sets `data-tone` on the root and
draws a 2px edge in `--tone` at the left and nothing else (the heading's words
say it; default draws none). `floating` adds `--shadow-pop` and `data-floating`,
only for a panel that floats over the page (the first-task guide card). `as` is
`section` (default) or `div`; `className` adds to the root. The parts carry
`data-part` hooks (`header`, `count`, `actions`, `body`).

`PanelRow` is a 40px row ruled off from the next by `--divider`; every other
prop, the `ref` and the host's `data-*` hooks go to its `<div>`. With
`onActivate` it is a `div` with `role="button"` and `tabIndex={0}` (so the
buttons it holds stay valid HTML), takes the hover fill and a focus ring inside
the row, and activates on a click that did not start on a control inside it and
on Enter or Space typed on the row itself
(`event.target === event.currentTarget`); a host's `onClick` and `onKeyDown`
still run first. Without it the row claims no role and no tab stop. `urgent`
draws a 2px warning edge (`data-tone="warning"`, `data-urgent`) and leads with
`urgentLabel` in the tone's ink ("Failed"), or an sr-only "Urgent, " when the
host's own words say it on screen, so the edge is never the only signal. Forced
colours keep the panel's, the tone's and the urgent row's edges (all borders)
and draw the focus ring in CanvasText.

### StatsStrip

`StatsStrip` is a `<ul>` named by `label` ("Summary" by default), one `<li>` per
cell: the key (after an optional 14px `icon`), the value in tabular figures and
a quiet `note`, coloured by the cell's `tone`, a link with `href`, a hover hint
with `title`. `variant` picks the shape:

- `panel` (default): Gr8r's rounded panel of cells under soft rules, a 22px
  value under each key, four across and two at 900px and below, the last cell
  spanning what its row leaves.
- `compact`: a page header's one-row strip (Live, Flight Plan) beside the
  header's own controls. No panel: each cell's icon, key, value and note sit
  inline on a 26px row (`--h-sm`, the height of the toolbar's controls), cells
  parted by soft rules. A meter value (a `ProgressRule`, the agent slots) is
  120px wide, its track and its "3/4". When the column is too narrow, whole
  cells wrap onto another row (the strip never scrolls sideways), no row starts
  with a rule, and a cell wider than the whole column folds its note under its
  value. Toned values, linked cells (the fill on hover and focus) and the list
  semantics are the panel's; the rules are borders, so forced colours keep them.
  The list carries `data-variant="compact"` (the panel adds no attribute of its
  own).

In forced colours the panel's cells draw outlines, since the rules between them
are its border colour showing through a gap.

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

`SectionHeader` is Gr8r's group header, the one heading row over a band of rows
(a board lane or column, a list group, a column of a host's page): an optional
fold chevron, a tone's status diamond, the host's `icon`, then one heading
element (`as`: `h3` by default, `h2`, `h4`, or `div` when the host's own heading
wraps it) holding the sentence-case name at 12.5px / 500 in the secondary ink
and its `count` in tabular figures (`--text-3`), separated by a space, so the
heading's accessible name reads "Coming in 2"; then the host's `actions` and,
with `onAdd`, a quiet "+" icon button named and titled `addLabel` (default
"New") after them. With `onToggle` the chevron is a quiet icon button (a 14px
lucide chevron, down while open and turned right while `collapsed`, the turn
only under `prefers-reduced-motion: no-preference`) named `toggleLabel`, or
"Collapse group" / "Expand group", with `aria-expanded`; without `onToggle`
there is no chevron. `tone` (a status tone) draws StatusMark's diamond in the
tone's shape (danger the solid one, warning the half-filled one, success, info,
muted and accent the open one) and hue (`--tone`), hidden from assistive tech,
and a 2px edge in the hue at the row's left (a border, so forced colours keep
it); the name must say the status too. `rule` draws a `--divider` rule under the
row; `sticky` pins it to the top of its scroll container on `--bg` (z-index 2).
The row has no padding of its own (it lines up with the column it heads; the
host pads it), carries `data-tone`, `data-collapsed="true"` while folded and the
host's `data-*` hooks, and its parts carry `data-part` (`toggle`, `icon`,
`name`, `count`, `actions`); a host that needs its legacy `data-slot` names on
the icon or the name wraps its own node in them
(`icon={<span data-slot="group-header-icon">…</span>}`).

**Row windows for a host's own lists.** `useRowWindows` is the windowing
`TaskGroupTable` uses, exported for a host's grouped lists (Dispatch's board
columns). Pass `rootRef` (the element holding the lists), `headRef` (a sticky
header over them, or a ref holding null), `enabled`, `scrollParent` (as the
table's), `groups` (`RowWindowGroup[]`: `{ id, rowIds, offscreen? }`, the shown
groups in reading order), `dragging` (row ids kept mounted) and `estimate` (the
px of a row before any is measured; default 55, a list row; a board passes its
card's height plus the space between cards) and `overscan` (rows kept mounted
past each edge of the viewport; default 8, sized for list rows, so a board of
tall cards passes fewer). `rowHeight(rowId)` gives a row's exact height, for
rows whose height the host computes (undefined when it is not known; 0, less or
NaN counts as unknown): it wins over a measurement, and a new function (pass a
`useCallback` over the heights) re-windows before paint, so a row that grows or
folds moves the gaps without a scroll; `initialRows` is how many rows the server
render and the first client render draw before the first measurement (default
60, sized for list rows). Dispatch's Live passes both: each band's computed
height and about four first rows, since one band is a whole canvas, so the gaps,
the scroll range and a J/K jump are exact before every band was drawn. It
returns `RowWindows`: each group's `<ul>` registers itself with
`registerList(id, el)` (a ref callback), and `segmentsOf(id)` gives that group's
window as `RowSegment[]`, `rows` runs to draw and `gap` runs of `px` the host
renders as spacer elements (or null while `enabled` is off: draw every row);
`revealElement`, `revealRow` and `setFocusedRow` (the focused row stays mounted,
is mounted at once when the cursor moves into a row the window left out, and
stays mounted through a re-sort) serve a host's keyboard.
`revealRow(id, index, align)` scrolls the least that shows the row whole
(`'nearest'`, the default), or with `'start'` puts its top at the viewport's top
under the sticky header (a jump to a section's title, as Live's J/K do), then
mounts the rows there. `focusUnmountedRow` expects the table's row hooks
(`data-nav-item="row"` with a `data-nav-target` inside), so a host with its own
rows uses `revealRow`. The hook measures every drawn `li[data-row-id]` of a
registered list (its border box, so keep the space between rows inside the `li`,
as padding, not as a flex `gap` or a margin) and uses each row's own height
unless `rowHeight` knows it; a row never drawn takes its `rowHeight`, else the
running mean of the measured ones (`estimate` before the first), so cards of
different heights need no separate mode. A known height never enters the mean,
and a row that leaves every group leaves the mean and the cache. The windows are
measured again before paint when the rows change (ids and order, not only
counts), so a re-sort keeps the focused row mounted. A group with
`offscreen: true` (a column scrolled off sideways) mounts no rows but its pinned
ones (the focused row, the rows being dragged) and is otherwise one gap of its
full height, so it costs nothing until it scrolls back; the first render spends
none of its `initialRows` on it. A group whose window a measurement leaves as it
was keeps the same `segmentsOf` array, so a host can memoize each list on it and
redraw only the lists a scroll moved. `flushOnScroll: true` renders a scroll's
new windows inside the scroll event (`flushSync`), so the frame that scroll
paints already holds the rows it brought in; a board of tall cards turns it on,
the table leaves it off. Without `estimate`, `overscan`, `rowHeight`,
`initialRows`, `offscreen`, `flushOnScroll` and `align` the table's path is
unchanged.

**Folded groups in storage.** `readCollapsedRaw(key, kind)` (the stored string,
or null; a string so `useSyncExternalStore` gets a stable snapshot),
`writeCollapsed(key, kind, ids)` (sorted, then every subscriber in the page is
told), `subscribeCollapsed(onChange)` (this page's writes and other tabs'
`storage` events; it returns the unsubscribe), `parseCollapsed`,
`serializeCollapsed` and `toggleCollapsed` keep a set of folded ids under a key
in `localStorage` (`'local'`) or `sessionStorage` (`'session'`, the
`CollapsedStorage` kinds), the way `TaskGroupTable` persists its folds. The
stored set is the folded ids, so a group that appears later starts open, and a
missing or blocked store never throws.

`SearchField` is the search box: a native `type="search"` input named by `label`
(`aria-label`; `autoComplete` off, `spellCheck` false, `enterKeyHint` search), a
leading 14px magnifier (13px at `size="sm"`) in `--text-4`, a `--control-border`
edge with the fields' focus ring, and, while it holds text, a quiet icon button
named `clearLabel` (default "Clear search") inside its right edge, which empties
the field and puts focus back in it (a press never takes focus from the field).
Escape in a non-empty field clears it and calls `preventDefault()` and
`stopPropagation()`; in an empty field Escape is left alone, so it reaches the
page and a second Escape closes what the field sits in (Settings, a find bar).
`escapeClears={false}` leaves Escape to the browser. `onChange` fires per
keystroke and with `''` on a clear; `onCommit` marks the search final: Enter
(not while an IME is composing; Enter is kept from submitting a surrounding form
only when `onCommit` is set), leaving the field, and a clear. `size` is `sm`
(26px, a toolbar's) or `md` (30px, the default); `inputRef` hands the input to a
host shortcut; `clearable={false}` drops the clear button and keeps the
browser's own clear control. Phones get the 16px touch size. Amended 2026-11-02
(B3): `onCommit` and `clearable` are additions to the frozen L16 API, because
ViewToolbar needs `onCommit` (Enter when not composing, and blur) and must keep
its look (no clear button of its own); a clear also commits `''`.

`ViewToolbar` lays out Gr8r's list toolbar, one 44px row over a `--border` rule:
a 26px search field (a `SearchField` at `size="sm"`, `clearable={false}`,
`escapeClears={false}`: a leading magnifier, a `--control-border` edge and the
fields' focus ring), as the timeline and projects toolbars draw theirs
(`onChange` per keystroke, `onCommit` on Enter and on leaving the field, so it
may fire twice for one value; `inputRef` for a `/` shortcut), the host's
triggers (pickers with `appearance="quiet"`), and `end` actions at the right
edge. `busy` sets `aria-busy` and runs a 2px accent rule along the bottom. In a
host's flex column it never shrinks, so a wrapped row of end actions stays
inside it. Phones put the search on its own row and scroll the controls
sideways. Leave `search` out for a toolbar of controls only, on a page people
scan down a column rather than search (Runs, Usage: a `SegmentedControl` and end
actions): no field renders, the controls start at the left edge, and `end` is
the bar's own cell after them, at the right edge of their row or wrapped under
them when the row is too narrow for both. On a phone the controls take a row of
their own and scroll sideways, and `end` always takes the row under them, from
the left edge, so its actions are never hidden in a sideways scroll that draws
no scrollbar (amended 2026-11-02, B4, as an L35 follow-up: `search` was
required). A `SegmentedControl` option's `count` shows after its label, and the
option is named "Live, 2" (an `aria-label`), not "Live2".

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
- `SignedOutFrame` takes the same `chromeAttributes` for a desktop host's gate
  screens (first-run setup, sign-in), spread onto its header row and nothing
  else (never its `<main>`), and its header row reads the same
  `--shell-brand-inset` as extra left padding at every width, so the brand
  clears the traffic lights there too. The header row spans the frame's full
  width (its padding keeps the contents in the 1440px column), so the drag
  region reaches the window's corners, and it stays at the top on `--bg` while
  the content scrolls (a host that scrolls the frame inside a fixed-height box
  keeps its drag region and nothing slides under the traffic lights).
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
- `CommandPaletteProvider` / `CommandPalette` `maxPerSection` is one number for
  every section or a cap per section heading (`PaletteSectionCap`, a heading not
  in the record keeps the default 50), so a host's long sections (tasks,
  projects) never push its short ones (views, actions) below the fold; the "+N
  more · keep typing" count follows each section's own cap. `emptyHint` is a
  second line under "No matches for …" saying what to try instead ("Try another
  task id, or press Tab to ask your agent"); it never shows while the query is
  empty.
- `PaletteItem` `matched: true` lists a row the host matched itself (its own
  search, fed back through `onQueryChange`): it stays in its section whatever
  the query, after the palette's ranked rows and in the host's order, and is
  never fuzzy-filtered. `highlight` (amended 2026-11-03, B13, L33) draws the
  host's hits on such a row: UTF-16 indices into `label` (a daemon's fuzzy
  `positions`), in the palette's usual match emphasis, with or without a query.
  It applies to `matched` items only; on any other item the palette's own fuzzy
  hits win and `highlight` is ignored. `highlightRuns` walks by code point, so
  an index on either half of a surrogate pair marks the whole character and
  never splits it. Under forced colours every match is underlined as well, since
  the accent ink is dropped.
- `CommandPalette` `label` (the dialog's name, default "Command palette") and
  `inputLabel` (the combobox's, default "Search commands, pages and issues")
  name a palette mounted as something narrower, such as a file finder ("Go to
  file"); the Esc button is named after `label` ("Esc, close go to file").
  Amended 2026-11-03 (B13): both are additions to the frozen palette API,
  because a quick open announced as "Search commands, pages and issues" fails
  name accuracy. The provider's palette is the app palette and takes neither.
- `PaletteItem` `mono: true` draws a machine-read label (a file path, an id) in
  Geist Mono, still truncated with an ellipsis (amended 2026-11-03, B13, an
  addition to the frozen palette API for the file finder's paths, Q5).
- With `onQueryChange`, the first `items` after the query changes (the host's
  results for the new text) put the active row back on the first result, so an
  arrow pressed on the previous query's list never makes Enter open the Nth new
  hit; items that change for any other reason keep the active row. The footer's
  "Tab Sections" hint shows only while there are two or more sections to walk.
- `AssigneePicker` people (`PersonChoice`) may carry a `group` (a heading, e.g.
  "Agents"; ungrouped people list first) and a `mark` of their own (a
  `PickerMark`, e.g. `{ kind: 'node', node }` for an agent's glyph) in place of
  the initials avatar.
- `StatePicker` states (`StateChoice`) may carry a `mark` of their own in place
  of the state glyph of their `kind`, for a host whose trigger face draws a
  status with its own glyph (a board card's), so the menu matches the face.
- `Tooltip` (`content`, one child, `side` top / bottom / left / right, `delay`,
  `defaultOpen`, `disabled`) is a hint that also shows on keyboard focus and is
  announced, where the shell's own CSS `data-tip` hints (the rail, hover only)
  stay as they are. No provider: the delay is 300ms, and 0 while another tooltip
  closed under 400ms ago, so moving along a toolbar shows each hint at once. It
  shows on hover (never on a touch screen's) and at once on keyboard focus
  (never for a press), and hides on leave (after a short grace, so the pointer
  can move onto the tip and rest there), blur, a press and Escape from its
  trigger (an Escape typed elsewhere hides it and still reaches its own target).
  A scroll that moves its trigger (the page, or a pane holding it) hides a tip
  shown by hover, and a scroll in another pane only re-places it. While the
  trigger holds keyboard focus the tip stays (WCAG 1.4.13, persistent): the
  pointer passing over and off the trigger leaves it, every scroll re-places it
  beside the trigger (the browser's own scroll to a trigger just reached by Tab
  included), and it hides only once the trigger is fully out of the viewport or
  of a pane holding it, scrolled out after showing or still out of view once
  scrolling has been quiet for 300ms (focus returned without a scroll to a
  trigger scrolled away). While shown the child carries `aria-describedby` to
  the `role="tooltip"` element, which is `aria-hidden` so it never joins the
  text of a heading or sentence it renders in; nothing renders while hidden. The
  child is cloned with a `ref` and pointer and focus handlers, so a component
  must forward them (`Button` does); a child that cannot take focus (a span, a
  term, a disabled button) is wrapped in a `span` with `tabIndex={0}`. Gr8r's
  inverted chip: `--text` fill, `--text-inv` words, 12px, at most 256px wide. It
  never holds interactive content, nor the only copy of a fact. `defaultOpen`
  shows it from the first render (a persistent hint, or a test without timers).
- `Dialog` is the centred modal for a short focused form or a reading view (a
  diff over a session): `title`, `description`, `size` sm 360px / md 520px / lg
  880px (a full-width sheet at 640px and below), `titleAction` (a Back button
  before the title), `actions` and `footerLeading` in the footer,
  `initialFocusRef`, `dismissible`, `dismissOnOutsideClick` (default true),
  `closeLabel`, `contentKey` (a new step while open: focus moves to its first
  field) and `role`. It is `role="dialog"` with `aria-modal="true"`, named by
  the title and described by the description, over the `--overlay` scrim. Focus
  goes to the first enabled control outside the header row (the Back action and
  the close button are skipped; a disabled field or a `tabIndex={-1}` button
  too), else the panel, and an explicit `initialFocusRef` wins; it returns to
  the opener on close. Tab cycles inside; the page does not scroll. Escape
  closes it with `preventDefault()` and `stopPropagation()`, so a `SlideOver`
  beneath stays open and the host's shortcuts stay quiet; `dismissible={false}`
  (while busy) ignores Escape, the scrim and the close button (disabled).
  Anything with pickers and a long body is a modal SlideOver instead.
- `ConfirmDialog` asks before a destructive or irreversible write: `title` (the
  question), the consequence as `children`, `confirmLabel`, `cancelLabel`,
  `tone` (`danger` draws the red danger Button), `busy`, `onConfirm` and
  `onCancel`. It is a `role="alertdialog"` with `aria-modal="true"`, no close
  button and no scrim dismissal; Escape means Cancel. Cancel takes focus first,
  so Enter right away cancels, and Enter on a danger confirm button does nothing
  (a click or Space confirms). Each callback runs once per opening and either
  button closes it at once, whether or not the host has flipped `open` yet. A
  promise from `onConfirm` keeps it open with the confirm button busy
  ("Working…") and Cancel and Escape waiting; a rejection re-enables it, and the
  host reports the error.
- `Spinner` (`size` xs 12px / sm 14px / md 16px / lg 20px, `tone`, `label`) is a
  `role="status"` arc named by `label` ("Loading"; `''` hides it from assistive
  tech beside a visible label). It turns only under
  `prefers-reduced-motion: no-preference` and keeps its stroke in forced
  colours. **Use it only for in-flight agent or network work** with no content
  shape to hold its place: the daemon starting, attaching files, the sign-in
  check, a drafting run, a live tool row, a clone. Never for a page load (use
  `Skeleton*`) and never for a save (the new value shows at once, and a `Button`
  says `busy` in words).
- `SlideOver` `modal` makes the drawer a form surface (a task composer, a
  session's detail) on every viewport, as it already is on a phone: it is
  `aria-modal="true"` while open (and not while it slides out, so a host's
  `[aria-modal="true"]` check mutes its page shortcuts exactly then), the
  `--overlay` scrim covers the page (a press on it closes the panel; with a
  picker or popover open in the panel, that press closes only the picker), Tab
  stays inside and `<html>` does not scroll. Focus never rests behind it: when a
  focused control unmounts or turns disabled (a busy submit, a removed chip) and
  focus falls to `<body>`, the panel takes it back a tick later unless the host
  moved it first, and a Tab pressed from `<body>` moves into the panel. It is a
  modal layer of the overlay stack: Escape from inside the panel closes it with
  `preventDefault()` and `stopPropagation()`, so a non-modal `SlideOver`
  underneath (a task drawer whose document listener came first) and the host's
  shortcuts never see it; with focus fallen to `<body>` the stack closes it
  before any page listener; a picker, popover, tooltip or `Dialog` opened in it
  takes Escape first, one layer per press, and focus returns to each opener in
  turn. A modal panel stacks over a non-modal one. Presses outside the scrim (a
  toast over it) never close it. The defaults are unchanged: without `modal` a
  desktop drawer stays a peek beside a usable page. `size="wide"` is
  `min(960px, 90vw)` instead of the default 620px (`SLIDE_OVER_WIDTH`), and
  `size="narrow"` is `min(340px, 100vw)`, for one column of rows (Dispatch's
  Overseer columns on a narrow window); each covers a phone. `footer` is an
  action row (Cancel, Create) under a `--divider` rule, outside the scrolling
  body, so it stays in view while the body scrolls. A host's `data-*` hooks go
  on the panel.
- `useModalSurface({ open, onClose, panelRef, initialFocusRef })` is a modal
  `SlideOver`'s behaviour for a host's own panel over a scrim (Dispatch's
  Settings), which has to stay out of the browser's top layer (a fixed overlay
  with its own z-index, so a host's legacy dialogs can still stack above it).
  The host renders the scrim and the `role="dialog"` panel (`aria-modal="true"`,
  `tabIndex={-1}`), spreads the returned `scrimProps` on the scrim and puts
  `onKeyDown` on the panel. The hook moves focus in on open and back on close,
  keeps Tab inside, locks `<html>` scrolling, makes the panel a modal layer of
  the overlay stack (Escape and presses go to a picker, popover, menu, tooltip
  or `Dialog` open in it first, one layer per press; a press made while one is
  open closes only that, even when its click then lands on the panel's own scrim
  because a `Dialog` unmounted under the pointer), closes it on Escape from
  inside or a click on the scrim, and takes focus back when it falls to
  `<body>`. Keys that reach the panel from a React portal outside its DOM are
  left to their own surface. `modal: false` keeps only the focus moves and the
  Tab trap (a desktop `SlideOver` beside the page).

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
- **Tabs.** `tabs` is a row for the host's mode tabs (a `NavTabs`; Dispatch's
  lifecycle: Spec, Run, Review, Summary, or Plan for a container), drawn under
  the lead (title, status line, alerts) and above what follows: the properties
  in the drawer, the main column's sections on the page, where it closes the
  head cell and so spans the main column, never the rail. The host decides what
  the body shows for each tab; the built-in sections are the Spec.
- **Work.** Dispatch's Work block (the dispatch button, the latest runs) goes in
  `rail` as a `TaskDetailSection`: right after the properties in the drawer, so
  above the description and the relations, and in the properties rail beside the
  main column on the page. There is deliberately no slot between Description and
  Blocked by.
- **Acceptance criteria** (and any other host section) are `children`: a
  `TaskDetailSection` (title, `count`, `meta` such as "2 of 3 met") holding a
  `Checklist`, after Activity in the main column at the sections' heading level.
  Without `onToggle` it is the read-only rubric (Met, or an amber Missing chip);
  with `onToggle(id, met)` each item is a `Checkbox` row a person ticks
  (ReviewMode's criteria), checked when `met`, reported by its `id` or, with
  none, by `String(index)`. `sectionMeta` puts a control in a built-in heading
  (an Edit button on Description, "+ Add" on the relations), and `sectionNotes`
  a full-width line under that heading (`TaskDetailSection`'s `note`): where a
  heading control's save error goes, as an exported `SaveErrorLine`, rather than
  wrapping beside the title. A host that prints the error there resolves the
  control's promise, so the control prints none of its own.
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

### Shell: the workspace switcher

`AppShellProps.workspaceSwitcher` (`ShellWorkspaceSwitcher`: `workspaces`,
`onSwitch`, optional `connect`, `label`, `menuLabel`, `groupLabel` and
`onOpenChange`) turns the brand row into Gr8r's workspace switcher; without it
the brand row is the link to `brandHref`, exactly as before. The row keeps the
brand link's face (the product's initials tile, the product name over the
workspace name) plus a 13px chevrons-up-down mark on the right, and opens a
`PickerPopover` menu (`searchable={false}`, single choice, the `brand`
appearance). Its accessible name puts the visible words first ("Milestone
Planner Acme, switch workspace"; `label` changes the action's words), and its
rail tooltip reads "Acme · Switch workspace".

- **Rows**: the `ShellWorkspace` list sorted by name (whatever the order given)
  under a "Workspaces" heading: a 20px initials tile (the current workspace in
  the brand tile's colours, the others `--surface-3` / `--text-2`; in forced
  colours each keeps a `CanvasText` edge and the current one a `CanvasText`
  fill, as the brand row's tile keeps its edge), the name, the `hint` ("Guest",
  "linear.app/acme"), the accent tick on the `current` one, where the menu
  opens. `connect` (`ShellWorkspaceConnect`) adds a last row under a bare
  divider ("Connect another workspace", a plus icon): with `href` a full page
  load of it; with `onSelect` an action in place (a desktop host's "Add
  project…", which opens its own `Dialog`): the menu closes with focus back on
  the brand row, then `onSelect` runs once, so the dialog takes the row as its
  opener and returns focus there (`PickerOption.onSelect`).
- **Switching**: picking another workspace calls `onSwitch(id)` through the edit
  family's save contract. While its promise runs the workspace line reads
  "Switching to Globex" (the polite status says "Switching Workspace"); a
  rejection prints "Not switched" and the Error's message under the row, and the
  menu's foot repeats it. The menu reloads nothing: on success the host
  navigates (a full page load), and a host that reloads can leave the promise
  pending so the line stays until the page goes. Picking the current workspace
  calls nothing; the connect row never shows "Switching" and never calls
  `onSwitch`.
- **Collapsed rail**: only the tile shows (dimmed while a switch runs). A
  refused switch also goes to a toast when a `ToastProvider` is mounted, and the
  line under the tile is then dropped; without a provider it stays for assistive
  tech and the menu's foot. On a phone the menu is the picker's bottom sheet
  over the drawer.
- Keys pressed inside the open menu (or any picker) never reach the shell's `[`
  or the palette's shortcuts.
- **A host's own words**: `menuLabel` names the open menu (its dialog and
  listbox, and the end of the polite "Switching Workspace"; default "Workspace")
  and `groupLabel` heads the rows (default "Workspaces"). Dispatch's project
  switcher passes `label` "Switch project", `menuLabel` "Project" and
  `groupLabel` "Projects", so its row reads "Dispatch dispatch, switch project".
- **A lazy list**: `onOpenChange(open)` hears the menu open and close (after the
  shell's own handler, which hides the rail tooltip). A host that loads its list
  the first time the menu opens can pass only the current workspace until then;
  when `workspaces` grows the open menu shows the new rows in name order, still
  open on the current one.

The palette has no switcher of its own: give `CommandPaletteProvider` plain
items in a section of your own (the planner's "Workspaces": "Switch to `<name>`"
with `onSelect`, "Connect another workspace" with `href`) and place it with
`sectionOrder`.

A host holding several workspaces usually names the one its footer signs out of:
`AppShellProps.signOut` takes an optional `label` ("Sign out of Acme", the
button's name and tooltip) and `fields`, hidden inputs the form posts (the
planner's `{ scope: 'current', workspace: '<org id>' }`, so a tab left on one
workspace never signs out another).

### Edit controls

Every edit control is controlled and saves through one contract: `onChange` /
`onSave` / `onSelect` may return a promise. While it is pending the control
shows the new value with a "Saving" note; when it resolves the value stays; when
it rejects the control rolls back and prints the error beside itself
(`formatError` turns the rejection into that sentence, `saveErrorMessage` is the
default). Returning nothing means "saved". A picker's polite "Saving" region
mounts the first time it opens (every save starts from its open list) and then
stays, so a resting picker is only its root and trigger: a board of cards with
four pickers each pays no live region per card.

`PickerPopover` is also the family's menu: `searchable={false}` drops the search
row (the list takes focus; ↑/↓, Home / End, ↵ and Space pick, Esc closes,
letters jump to the next row starting with them) and the key-hint foot, and with
`action` every pick is an action rather than a value (a row's "…", Filter, Sort,
Group); an action option with `selected` is the current one (a views menu's open
view: `aria-selected` and the tick, still run as an action when picked). A
search box keeps Home and End for its caret while it holds text; empty, they
jump to the first and last row. `searchLabel` names the search box apart from
the dialog and the list (Filter's "Add filter" box over "Filter facets"), and
`shortcut` ("F") shows the key that opens the picker from the page as a keycap
at the end of the search row and as the trigger's `aria-keyshortcuts` (the host
still binds the key). The trigger appearances are `value` (the default, the
property sheet's), `mono` (the status line's bordered pill), `quiet` (a small
ghost button, "+ Add"), and four more for particular places: `cell` (the trigger
takes the cell's own voice, so its text sits where the plain value would, with a
soft `--surface-3` pill on hover), `bar` (a ghost action on the bulk bar's
inverted pill: `--text-inv` at 0.85 opacity, with a faint light wash on hover
and while its popover is open) and `brand` (the app shell's brand row, the
workspace switcher above: a row as wide as its container with the brand link's
padding, the `--surface-3` fill on hover and while open, an outline in forced
colours while open, no outset, a 280px menu; pass the face as `trigger`),
`field` (a form select, as `Select` draws it: the trigger is a global `.input`,
so it has a text input's edge, hover, ring, disabled fill and `aria-invalid`
edge, as wide as its host, with a trailing chevron) and `mark` (a glyph-only
trigger, a board card's state, priority, assignee or labels: the `trigger` face
if given, else the chosen option's mark with no words, the chosen marks side by
side for a multiple picker, the none mark when nothing is chosen, else a dashed
empty ring; a 24px hit target whose 20px frame takes the `--surface-3` fill on
hover and while open, one step deeper than `value` because the card under it
hovers `--surface-2` itself, `--r-chip` corners, the focus ring hugging the
frame, a ButtonText edge in forced colours, no outset; named `triggerLabel`,
else "Label: Value" as usual, since it prints no words; a pending save dims the
face and prints no "Saving" beside it, the announcement still says it). A `mark`
trigger opens on Enter and Space itself and stops those keys there, so a card
around it that a keyboard drag picks up with Space, or that opens on Enter,
never sees them; the other appearances leave both keys to the button.
`StatePicker`, `PriorityPicker`, `AssigneePicker` and `LabelPicker` take it
through their props like any picker. A `PickerOption.href` makes a row a link
out: picking it closes the popover and loads the URL (`window.location.assign`)
instead of choosing it, so it is never ticked (a multiple picker draws it no
checkbox), never calls `onChange` and shows no pending note. A
`PickerOption.onSelect` makes a row an action in place (the switcher's "Add
project…"): picking it (click, ↵ or Space) closes the popover and returns focus
to the trigger (or `returnFocus`) first, then calls it once, so a `Dialog` it
opens records the trigger as its opener; like `href` it is never ticked or
`aria-selected` (not even when its `value` is the value), never calls
`onChange`, shows no pending note and announces no "Saving", in single, multiple
and action mode alike (a multiple picker draws it no checkbox and closes for
it). `href` and `onSelect` are exclusive: `href` wins when both are set.
`groupTitleHidden` on a group's first option draws that group under Gr8r's bare
divider (its title still names the group for assistive tech). A multiple picker
whose groups each hold one choice (Sort, Group) takes `marks="tick"`: the single
picker's trailing tick instead of checkbox squares. A `PickerOption.tone`
colours the trigger's face text (from the `data-tone` hook) while that option is
the value shown, a pending one included; `PriorityPicker` takes it per level as
`priorityTones` (a list cell's `{ 1: 'danger' }`: "Urgent" red the moment it is
picked, a pending "High" never red). `anchorPoint={{ x, y }}` opens the popover
at a viewport point instead of under its trigger (a context menu at the pointer;
a phone keeps its sheet). `returnFocus={() => element}` sends focus there
instead of to the trigger when the picker closes on Esc, a choice or a close
button (a picker a host's single-key shortcut opened from a row's title goes
back to that title); Tab and an outside click are unchanged. A disabled option
wraps, so a menu's note or a reason can be a whole sentence. `useModKeyLabel()`
is "⌘" on Apple platforms and "Ctrl" elsewhere (the server renders "Ctrl"), for
a host's own shortcut rows.

A `PickerOption.keepOpen` option is a step, not a value (a filter menu's facet,
"Back to filters"): picking it calls `onChange` with its value in single mode,
or with the toggled list in multiple mode, always outside the save contract
(never shown as chosen or pending, no "Saving" announced, and a returned promise
is not awaited), then clears the search, resets the active row and keeps the
popover open with focus in its search box or list, so the host swaps `options`
and `label` for the next step. A host's `data-*` hooks on a picker
(`data-slot="filter-menu"`) land on the open popover's `role="dialog"` layer,
not on the trigger.

`onCreate(text)` makes a new option from the search text (a label typed into
`LabelPicker`, which forwards it like every preset prop). While the trimmed text
is not blank and is no option's label exactly (case aside; `noneLabel` counts
too), a trailing `role="option"` row reads `Create "<text>"` (`createLabel`
words it, or `labels.create`), with a plus where the marks go. The arrow keys
reach it like any option, and it is the active row when nothing else matches, so
Enter creates; Home and End stay the search box's caret keys while it holds
text. Enter or a click calls `onCreate` with the trimmed text under the save
contract: a promise shows the "Saving" note until it settles. A single picker
stays open meanwhile and closes once it resolves; a multiple picker clears its
search at once and stays open for the next name. A rejection prints the error
like a failed save and puts the text back in an empty search box; one create
runs at a time. The host adds the new option to `options` (and usually to
`value`). It is not offered in action mode (`action`) or without a search box.

A host that searches on its server passes `filter={false}`, owns `query` /
`onQueryChange`, and sets `loading` while the options on screen still answer an
older query (`TaskRelationPicker` does all three). In that gap ↵ never picks
from the old list: it waits for the answer to the typed text and then picks its
first row, or the row ↑/↓ had made active if the answer still holds it; an empty
answer, an error (Retry is not a choice), more typing, ↑/↓, a pick by pointer or
closing drop the waiting pick, and with nothing typed ↵ does nothing. A new list
(an answer, or options the host rebuilt from live data) keeps the row ↑/↓ had
reached while it still holds that row, so ↵ picks the same row whether it came
before or after the answer; a list that drops the row starts from its first row.
A locally filtered picker (`filter` left on) picks at once while `loading`,
since its rows always match the search.

`DateField` is the browser's own date input with a Clear button; a complete date
saves after `commitDelay`, at once on Enter or blur. `emptyLabel` ("No due
date") is said in place of the browser's mm/dd/yyyy mask while the field is
empty and unfocused, in `--text-3`, and is the input's description; focused, the
mask is back to type into. The mask is hidden with the WebKit date parts, so an
engine without them keeps its mask and draws no label over it.

`Popover` is a non-modal panel for a host's own controls (a display panel, a
save-view form): `open`, `onOpenChange`, `label` (names the `role="dialog"`;
never `aria-modal`), `trigger` (cloned with `aria-haspopup="dialog"`,
`aria-expanded`, `aria-controls`, a toggling click and a `ref`, so a component
trigger must forward `ref`; `Button` does) or `anchorRef` (another element, such
as a field the popover suggests for), `align`, `side`, `width` (px, or
`'trigger'` for the anchor's), `initialFocus` (`'first'` by default, `'panel'`,
an element, or `false` to leave focus in the anchor), `returnFocus`,
`closeOnOutside` and `footer`. Escape, a press outside, Tab past the last
element (Shift+Tab before the first goes back to the trigger) and the phone
sheet's Done close it; all but an outside press return focus to the trigger or
anchor (`returnFocus` changes where, and Tab and Shift+Tab leave from there too,
so a popover anchored to a wrapper that cannot take focus hands focus to a real
control). Focus moving out of it (to the page, the command palette, the
composer) closes it as an outside press does. A press on the trigger or the
anchor counts as inside. It is Gr8r's `.pop` card (`--surface`, `--r-lg`,
`--shadow-pop`) anchored like the picker, and a bottom sheet with a Done button
at 640px and below. A `PickerPopover` inside it is a layer of its own: its
Escape and a press in the popover's body close only the picker, and choosing in
it keeps the popover open.

### Controls

`TextField`, `TextArea`, `Field`, `RadioGroup` and `Select` are form controls.
Inside a `Field`, a `TextField`, `TextArea` or `Select` takes the label's id,
and the text controls take its hint and error as their description and
`aria-invalid` (the error edge). `Select` is a `PickerPopover` in the `field`
appearance without a search row: its `onChange` follows the save contract above,
its open list is a layer of the overlay stack like any picker's, and a host's
`data-*` hooks land on that list's layer. `RadioGroup` is native radios (one
`name`, generated unless the host passes `name`, so the browser's arrow keys
move and pick); a host's `data-*` hooks already land on the radiogroup. An
option's `hint` is a quiet line read as its description; its `badge` (a
"Recommended" `Chip`) sits inside the label after its words, so it is part of
the radio's name; its `aside` sits beside the label, outside it, so its buttons
stay valid controls, stay out of the name and pick nothing; its `children` show
under it only while it is checked (a reason box); its `aria-label` names the
radio. `variant="cards"` boxes each option in a row (the decision cards'
answers): the whole row picks (the native input covers it, under the aside), the
hover fill answers a pointer, and the checked row takes that fill with a 2px
accent edge inside its start (a `Highlight` outline in forced colours); the
focus ring stays on the circle. `activation="manual"` is for choices that act
the moment they are picked (approve or deny a tool call): an arrow key only
moves focus (the change the browser makes is not reported, so the checked option
stays), and Space, Enter (which submits no form) or a click picks, the checked
option too (reported again, as a button press would be); the default `auto` lets
an arrow key move and pick, as native radios do. `hintAs="tooltip"` (default
`text`, the visible line) is for a row with no room for hint lines, such as the
desktop's review verdict bar: each option's `hint` is not drawn as a line; a
`Tooltip` on the option's label (its ring and words) shows it on hover and while
the radio has keyboard focus (Escape from the radio hides it, as from any
tooltip's trigger), and the radio keeps `aria-describedby` on a visually hidden
copy (`.srOnly`, outside the label), so the description is there while the
tooltip, which is aria-hidden, is closed, and is read once while it shows.
Picking, the arrow keys, `activation`, `variant` and `orientation` are
unchanged, and no option gains a tab stop of its own. `size` is `md` (default)
or `sm`, a compact row for a one-row footer: the 24px row stays (the target
size) with `--fs-sm` words and tighter gaps; the radiogroup carries `data-size`.

A `TextArea` grows with its content (`autoGrow`, on by default) and then shows
no resize grip, whichever order a build joins the global `.textarea` rule and
its module in; with `autoGrow={false}` it keeps the field's vertical grip.

`Menu` is an action menu. `label` names the `role="menu"`; `items` are action
rows (`shortcut`, `destructive`, `disabled`), radio rows (`kind: 'radio'`,
`checked`), groups, separators and submenus (`kind: 'submenu'`, `emptyLabel`);
`trigger` is a render function whose props (`ref`, `aria-haspopup="menu"`,
`aria-expanded`, `aria-controls`, the toggling click and the opening keys) go
onto a `Button`. ↓, ↵ or Space on the trigger opens it on the first row and ↑ on
the last; ↑/↓ wrap over the enabled rows, Home and End jump, → opens a submenu,
← and Esc come back from one, Esc at the root closes the menu with focus back on
the trigger, and Tab closes it and moves on from the trigger. Picking a row
closes the whole menu and puts focus back on the trigger before the row's
`onSelect` runs, so a dialog it opens returns focus there. `open` and
`onOpenChange` control it (a host's shortcut), and `align="end"` lines it up
with the trigger's right edge. The open menu and each open submenu are popover
layers of the overlay stack (below), placed by script (under the trigger, or
beside the submenu's row) and kept placed while the page scrolls: a submenu sits
over its menu, so Escape and an outside press close it first, a press in the
menu outside the submenu closes only the submenu, and Escape with focus back on
a submenu's row closes that submenu. Its layer carries `data-picker-popup` (so
the shell's `[` and the palette's keys stand down inside it) and a host's
`data-*` hooks.

## Browser behaviour hosts should know about

All of it runs in effects and event handlers on the client; server rendering
touches none of it.

- `ThemeToggle` writes `html[data-theme]` (and `data-theme-switching` for two
  frames) and `localStorage`, and so does `applyThemeChoice` when the host calls
  it; `showTheme` writes the attributes alone and `readThemeChoice` reads
  `localStorage`. Call those three on the client only (an effect or a handler).
- `AppShell` writes `html[data-shell-collapsed]` (and removes it on unmount),
  binds `[` to collapse the sidebar (unless `sidebarShortcut` is false; never
  from inside an open picker, menu or popover, a `[data-picker-popup]`), and
  locks `<html>` scrolling while the phone drawer is open.
  `sidebarCollapseScript(key)` is its pre-paint script. Its workspace switcher's
  connect row calls `window.location.assign`.
- `CommandPaletteProvider` binds Ctrl/⌘ K, `?` and two-key `G …` shortcuts on
  `document`, none of them from inside an open picker, menu or popover (each
  sits in the top layer, over the palette, and its layer carries
  `data-picker-popup`). Do not mount it in a host that has its own command
  palette. Its API's `isSequencePending()` is true between a sequence's first
  key and its second (1.2 s): React handlers run before that document listener,
  so a host's own single keys can check it and stay out of a chord's way.
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
- `SlideOver` closes on Esc and traps focus (a modal one, or any on a phone, is
  also a modal layer of the overlay stack below, locks `<html>` scrolling, and
  reads `pointerdown` on `window` in the capture phase while open, to tell a
  press on its scrim from one that only closes a picker over it; a host's panel
  on `useModalSurface` does the same); `TaskGroupTable` can persist folded
  groups in `localStorage` or `sessionStorage` (`storage="session"` suits a
  desktop app). Storage failures are tolerated everywhere.
- **Overlays render in place and stack.** `PickerPopover` (and `Select`, which
  is one), `Popover`, `Menu` (the open menu and each open submenu), `Tooltip`
  and `Dialog` render where the host renders them, never portalled to `<body>`,
  and show in the browser's top layer (`popover="manual"`; a `position: fixed`
  layer where the Popover API is missing, such as happy-dom), so a picker inside
  a dialog stays a DOM child of it and a focus trap's `contains` check, a scoped
  wrapper's tokens and a host's delegated events keep working. Each open one is
  a layer of one stack, which adds capture-phase `pointerdown`, `keydown` and
  `focusin` listeners on `document` while anything is open. A press outside the
  topmost layer (its trigger or anchor counts as inside) closes it and every
  non-modal layer under it that does not hold the press either: a press in a
  dialog's body closes the picker open in it and leaves the dialog, a press on
  the page closes a picker and the popover holding it, and a press on a dialog's
  scrim with a picker open closes only the picker. Focus moving out of a
  popover, picker or menu closes it (a modal layer keeps focus itself). Escape
  closes the topmost layer only, with `preventDefault()` and `stopPropagation()`
  (from inside a layer its own handler takes the key after anything focused in
  it; with focus elsewhere, the stack takes it before any page listener). A
  modal surface outside the stack (`aria-modal="true"`, such as the command
  palette or a host's own dialog) keeps its own Escape and presses: the layers
  under it never take them. Tooltips hide on any press, take Escape only from
  their own trigger, and never stand between a press or a key and the layer
  under them. A host's document-level Escape listener should return early on
  `event.defaultPrevented` (as `SlideOver` does). Only `Dialog`,
  `ConfirmDialog`, a modal or phone `SlideOver` and the command palette set
  `aria-modal="true"` (a host's panel on `useModalSurface` sets it itself), and
  only while open, so a host's "is a modal open?" check (`[aria-modal="true"]`)
  mutes its shortcuts exactly then. `Dialog` locks `<html>` scrolling while
  open.

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
