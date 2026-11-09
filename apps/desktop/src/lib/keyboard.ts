// Pure keyboard-intent resolution — no DOM, no React. `useGlobalKeyboard` (hooks/) is the
// only place that touches `window`/`document`; it builds a `KeyInput`/`GlobalKeyboardContext`
// pair from a real KeyboardEvent and the app's current UI state, then dispatches whatever
// this resolves to. Keeping the decision itself pure makes every shortcut in the redesign
// brief independently testable against plain objects.
//
// Split into two resolvers rather than one shared one: the global (root) layer and a list
// view's own local layer genuinely want different keys. A single combined resolver used to
// return `list-confirm` for a bare Enter at the *global* layer too, which meant the app-root
// listener called `preventDefault()` on every Enter keypress anywhere in the app (submitting
// a form, activating a focused button) and then threw the resulting command away as a no-op —
// Enter was silently broken everywhere except inside a list view. `resolveGlobalKeyCommand`
// now never produces a list command at all, so there is nothing for the root to intercept.

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface GlobalKeyboardContext {
  /** True while focus is inside a text input/textarea/contenteditable — bare-symbol shortcuts
   * (`/`) must not fire while someone is typing a task title. Escape and cmd/ctrl+k still fire
   * regardless, since those are the two shortcuts a person expects to work from inside a text
   * field too (bail out of an edit, or jump to the palette). */
  isTyping: boolean;
  /** True while a modal surface (TaskComposerSlideOver, SessionDetailModal's modal SlideOver,
   * DiffModal's Dialog, …) is open. The surface owns its own Escape listener; the global layer
   * must stay out of the way entirely while one is open, or a single Escape press would also
   * fire the app's own
   * `escape` nav action and close whatever's stacked behind the modal (e.g. the task peek
   * panel) in the same keystroke. */
  modalOpen: boolean;
  /** The chord prefix armed by the previous keystroke (`g`), or `null`. `useGlobalKeyboard`
   * holds it for 600ms after a bare `g`; while armed, the next letter resolves to a
   * `goto-*` chord instead of its own bare-key meaning. */
  pendingPrefix: ChordPrefix | null;
  /** True on macOS (and the other Apple platforms), where Command is the app's modifier and
   * Control keeps its Cocoa text meanings: Ctrl+P is "previous line" in every text field, so
   * the app must not claim it there. Only the quick-open rule reads it today. Absent means
   * not an Apple platform, where Ctrl is the app's modifier. */
  isApplePlatform?: boolean;
}

/** The keys that start a two-key chord. Only `g` ("go to") today. */
export type ChordPrefix = 'g';

export type GlobalKeyCommand =
  | 'open-palette'
  | 'escape'
  | 'nav-back'
  | 'nav-forward'
  /** Webview zoom, the ⌘+/⌘−/⌘0 every browser ships. */
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  /** Open the quick brain-dump capture modal. */
  | 'brain-dump'
  /** Hide or show the sidebar (`[`; ⌘B is the alias shadcn's sidebar taught). */
  | 'toggle-sidebar'
  /** Open the task creator (`c`). */
  | 'new-task'
  /** Open the keyboard-shortcuts reference (`?`). */
  | 'open-shortcuts'
  /** Go to file (⌘P on macOS, Ctrl+P elsewhere): the Files page with its quick open showing. */
  | 'quick-open'
  /** The quick-open chord while a modal is open: nothing opens, but the key is still the
   * app's, so the browser's print dialog never does either. */
  | 'quick-open-blocked'
  /** The `g` chords, as lib/appNav.ts keyAction routes them: `g s` Settings, `g i` the
   * Needs you preset, `g m` Threads (messages), `g t` Issues, `g l` Timeline (`t` is
   * taken), `g q` Landing (the merge queue), `g g` Graph, `g f` the Moving preset (work in flight), `g r` the Review
   * preset, and `g a`, `g o`, `g h` and `g c` the Overseer. Some command names predate
   * their targets: goto-live is Moving, goto-projects is Review, and goto-home and
   * goto-control-room are the Overseer. lib/shortcutGroups.ts lists the chords the
   * shortcut sheet shows. */
  | 'goto-home'
  | 'goto-settings'
  | 'goto-inbox'
  | 'goto-threads'
  | 'goto-timeline'
  | 'goto-week'
  | 'goto-graph'
  /** `g q`: Landing, every run headed for main (the merge queue). */
  | 'goto-landing'
  | 'goto-tasks'
  | 'goto-projects'
  | 'goto-live'
  | 'goto-control-room'
  | 'goto-overseer'
  /** Jump straight to the Nth entry in the sidebar's primary rail. */
  | `goto-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

// The second key of each `g` chord.
const G_CHORDS: Record<string, GlobalKeyCommand> = {
  h: 'goto-home',
  s: 'goto-settings',
  i: 'goto-inbox',
  m: 'goto-threads',
  t: 'goto-tasks',
  l: 'goto-timeline',
  w: 'goto-week',
  q: 'goto-landing',
  // A second `g` completes the chord rather than re-arming it: the prefix is
  // held only while `pendingPrefix` is null, so `g g` is free for the Graph.
  g: 'goto-graph',
  r: 'goto-projects',
  f: 'goto-live',
  c: 'goto-control-room',
  a: 'goto-overseer',
  o: 'goto-overseer',
};

/** Whether this keystroke arms a chord prefix rather than resolving to a command on its
 * own — a bare `g` outside a text field with no modal up. `useGlobalKeyboard` calls this
 * only after `resolveGlobalKeyCommand` returned `null`, then holds the prefix for the next
 * keystroke. */
export function resolveChordPrefix(
  input: KeyInput,
  ctx: GlobalKeyboardContext
): ChordPrefix | null {
  if (input.metaKey || input.ctrlKey) return null;
  if (ctx.isTyping || ctx.modalOpen) return null;
  if (ctx.pendingPrefix !== null) return null;
  return input.key === 'g' ? 'g' : null;
}

/** The command an armed `g` chord's second key completes, or null. `useGlobalKeyboard`
 * resolves it before any view sees the key, so a focused list's own `f` (filter), `s` or
 * `a` (pickers) never eats `g f`, `g s` or `g a`. */
export function resolveChordKey(
  input: KeyInput,
  ctx: GlobalKeyboardContext
): GlobalKeyCommand | null {
  if (ctx.pendingPrefix !== 'g') return null;
  if (input.metaKey || input.ctrlKey || ctx.isTyping || ctx.modalOpen) {
    return null;
  }
  return G_CHORDS[input.key] ?? null;
}

/** Maps one keydown to the app-root command it should trigger, or `null` if this keystroke
 * isn't a global shortcut right now. Never resolves a list-navigation command — those are
 * `resolveListKeyCommand`'s job, called locally by whichever list view has focus. */
export function resolveGlobalKeyCommand(
  input: KeyInput,
  ctx: GlobalKeyboardContext
): GlobalKeyCommand | null {
  const combo = input.metaKey || input.ctrlKey;

  if (input.key === 'Escape') return ctx.modalOpen ? null : 'escape';
  if (combo && input.key.toLowerCase() === 'k') return 'open-palette';

  // Back/forward through visited views. cmd+[ and cmd+] are what every browser
  // and every editor already uses for this, so it needs no teaching.
  if (combo && input.key === '[') return 'nav-back';
  if (combo && input.key === ']') return 'nav-forward';
  // ⌘, is Settings everywhere on macOS; a modifier chord, so it works while typing.
  if (combo && input.key === ',') return 'goto-settings';
  // Go to file. On macOS only ⌘P opens it: Ctrl+P there is Cocoa's "previous
  // line" in every text field, so it resolves to nothing and the field keeps
  // it. Elsewhere Ctrl+P (or Meta+P) opens it. A modifier chord like ⌘K, so it
  // fires while typing (the Files editor's own textarea is a typing target, and
  // the chord from it is the way to the next file), but never over a modal:
  // the open quick open is itself one, and a second layer over any dialog
  // helps nobody. Over a modal it is still resolved (to a command that does
  // nothing), so the keystroke is claimed and the browser's print dialog does
  // not open in its place.
  if (input.key.toLowerCase() === 'p') {
    const quickOpenChord = ctx.isApplePlatform === true ? input.metaKey : combo;
    if (quickOpenChord) {
      return ctx.modalOpen ? 'quick-open-blocked' : 'quick-open';
    }
  }

  // cmd+1..9 jumps to a rail entry. These work while typing on purpose: they
  // carry a modifier, so they cannot be confused with entering text, and being
  // unable to leave a screen because your cursor is in a filter box is exactly
  // the kind of thing that makes an app feel stuck.
  if (combo && /^[1-9]$/.test(input.key)) {
    return `goto-${Number(input.key) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
  }

  // Webview zoom. Modifier chords, so they work while typing too — resizing the UI
  // mid-edit is exactly when you notice it's too small. `=` is the unshifted `+` key.
  if (combo && (input.key === '=' || input.key === '+')) return 'zoom-in';
  if (combo && input.key === '-') return 'zoom-out';
  if (combo && input.key === '0') return 'zoom-reset';

  // Quick capture (⌘D — "dump") and the ⌘B sidebar alias. They carry a modifier but are
  // still deliberately dead while typing and while any modal is up — opening a second layer
  // over an open dialog, or shifting the frame under one, helps nobody.
  if (combo && !ctx.isTyping && !ctx.modalOpen) {
    if (input.key.toLowerCase() === 'd') return 'brain-dump';
    if (input.key.toLowerCase() === 'b') return 'toggle-sidebar';
  }

  // Every other global shortcut below is a bare letter/symbol — never hijack normal typing,
  // and never claim a modifier chord that isn't listed above (⌘C is copy, not "new task").
  if (ctx.isTyping || combo) return null;

  if (input.key === '/') return 'open-palette';

  // The single-key shell shortcuts (Linear's set) stay dead while a modal is up: a dialog
  // owns the keyboard, and hiding the sidebar or stacking a second dialog under it helps
  // nobody. `/` above is exempt on purpose — the palette is itself the way out.
  if (ctx.modalOpen) return null;

  // An armed `g` resolves the chord's second key, or nothing — the hook drops the prefix
  // either way, so a stray `g x` never leaks `x` into a later keystroke.
  if (ctx.pendingPrefix === 'g') return resolveChordKey(input, ctx);

  if (input.key === '[') return 'toggle-sidebar';
  if (input.key === 'c') return 'new-task';
  if (input.key === '?') return 'open-shortcuts';
  return null;
}

export interface ListKeyboardContext {
  /** Same meaning as `GlobalKeyboardContext.isTyping` — a list view's own filter/search input
   * is still a text field "j"/"k" must not hijack. */
  isTyping: boolean;
}

export type ListKeyCommand =
  | 'list-up'
  | 'list-down'
  /** Enter on the focused row. */
  | 'list-confirm'
  /** `o` — open the focused row's full page. */
  | 'list-open'
  /** Space — peek the focused row. */
  | 'list-peek'
  /** `x` — add or remove the focused row from the selection. */
  | 'list-select-toggle'
  /** The single-key property shortcuts on a focused row (Linear's `s`/`p`/`a`/`l`, plus
   * Dispatch's milestone/dispatch). */
  | 'list-set-status'
  | 'list-set-priority'
  | 'list-set-assignee'
  | 'list-set-labels'
  | 'list-set-milestone'
  | 'list-dispatch'
  /** `f` — open the filter menu. */
  | 'list-open-filter'
  /** `⇧V` — open the display popover. */
  | 'list-open-display'
  /** Escape — clear the selection. */
  | 'list-escape';

// Every bare key a list view can act on. Views pick the subset they handle and let the
// rest fall through (so a view with no selection model ignores `x`, say).
const LIST_KEYS: Record<string, ListKeyCommand> = {
  j: 'list-down',
  ArrowDown: 'list-down',
  k: 'list-up',
  ArrowUp: 'list-up',
  Enter: 'list-confirm',
  o: 'list-open',
  ' ': 'list-peek',
  x: 'list-select-toggle',
  s: 'list-set-status',
  p: 'list-set-priority',
  a: 'list-set-assignee',
  l: 'list-set-labels',
  m: 'list-set-milestone',
  d: 'list-dispatch',
  f: 'list-open-filter',
  V: 'list-open-display',
  Escape: 'list-escape',
};

/** Maps one keydown to a list view's own local command (j/k/arrows, Enter/`o`/Space, `x`,
 * the property keys, `f`, `⇧V`, Escape), or `null`. Called directly by a view's own
 * `onKeyDown` handler on its list container — never wired to the app-root `window`
 * listener, so it only ever affects whichever list actually has focus. A view should
 * switch on the commands it implements and return without `preventDefault` for the rest. */
export function resolveListKeyCommand(
  input: KeyInput,
  ctx: ListKeyboardContext
): ListKeyCommand | null {
  // A modifier held down means this is someone else's shortcut (cmd/ctrl+k for the palette,
  // browser/OS shortcuts, …) — never treat a combo as plain list navigation.
  if (input.metaKey || input.ctrlKey) return null;
  if (ctx.isTyping) return null;
  return LIST_KEYS[input.key] ?? null;
}

/** `<input>` types that take no typed text, only their own press (Space toggles a checkbox,
 * Enter or Space presses a button), so a letter landing on one is free for a shortcut. Radio
 * and range inputs are left out: their arrow keys belong to them. */
const KEYLESS_INPUT_TYPES: ReadonlySet<string> = new Set([
  'checkbox',
  'button',
  'submit',
  'reset',
]);

/** The actual "does this tag name/contenteditable-ness count as typing" decision —
 * `isTypingTarget` (hooks/useGlobalKeyboard.ts) is the thin DOM-touching wrapper that pulls
 * `tagName`/`isContentEditable` off a real `EventTarget` and calls this; kept separate so the
 * decision itself is testable without a DOM. Any view with a keydown-listening container that
 * also contains real form controls (the Board's roving-focus track wrapping a milestone card's
 * concurrency `<input>` is the motivating case) should build its `isTyping` this way rather
 * than hardcoding `false`. A focused native `<select>` counts too: its typeahead jumps to the
 * option whose label starts with the letter pressed, so a bare `g` or digit there picks an
 * option rather than firing a global chord. An `<input>` whose `inputType` is given and takes
 * no text (a checkbox, a button) does not count: a ticked review criterion keeps focus on its
 * box, and the page's and the app's letter keys must still work from there. Without
 * `inputType`, every `<input>` counts, as before. */
export function isTypingTagName(
  tagName: string,
  isContentEditable: boolean,
  inputType?: string
): boolean {
  if (tagName === 'INPUT') {
    return inputType === undefined || !KEYLESS_INPUT_TYPES.has(inputType);
  }
  return tagName === 'TEXTAREA' || tagName === 'SELECT' || isContentEditable;
}

/** True for tag names that are their own interactive controls — a keydown landing on one
 * inside a keydown-listening container (the Board track wraps a milestone card's Work/Stop
 * `<button>`s and the inline "Dispatch →" button) belongs to that control, not to board
 * navigation. Extends the typing guard (INPUT/TEXTAREA/contenteditable) to the click-style
 * controls (BUTTON/A/SELECT) so pressing Enter on a milestone's Work button activates it instead
 * of moving the roving cursor. Kept DOM-free for testability, like `isTypingTagName`; the
 * view pairs it with `.closest()` so a control wrapping an inner element (e.g. a `<span>`)
 * still counts. */
export function isInteractiveControlTagName(tagName: string): boolean {
  return (
    tagName === 'BUTTON' ||
    tagName === 'A' ||
    tagName === 'SELECT' ||
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA'
  );
}
