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
  /** True while focus is inside a text input/textarea/contenteditable — single-letter
   * shortcuts (c) must not fire while someone is typing a task title. Escape and cmd/ctrl+k
   * still fire regardless, since those are the two shortcuts a person expects to work from
   * inside a text field too (bail out of an edit, or jump to the palette). */
  isTyping: boolean;
  /** True while a `Modal`-based dialog (CreateTaskModal, SessionDetailModal, DiffModal, …) is
   * open. `Modal` owns its own Escape listener; the global layer must stay out of the way
   * entirely while one is open, or a single Escape press would also fire the app's own
   * `escape` nav action and close whatever's stacked behind the modal (e.g. the task peek
   * panel) in the same keystroke. */
  modalOpen: boolean;
}

export type GlobalKeyCommand = 'open-palette' | 'new-task' | 'escape';

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

  // Every other global shortcut below is a bare letter/symbol — never hijack normal typing.
  if (ctx.isTyping) return null;

  if (input.key === '/') return 'open-palette';
  if (input.key === 'c') return 'new-task';
  return null;
}

export interface ListKeyboardContext {
  /** Same meaning as `GlobalKeyboardContext.isTyping` — a list view's own filter/search input
   * is still a text field "j"/"k" must not hijack. */
  isTyping: boolean;
}

export type ListKeyCommand = 'list-up' | 'list-down' | 'list-confirm';

/** Maps one keydown to a list view's own local navigation command (j/k/Enter), or `null`.
 * Called directly by a view's own `onKeyDown` handler on its list container — never wired to
 * the app-root `window` listener, so it only ever affects whichever list actually has focus. */
export function resolveListKeyCommand(
  input: KeyInput,
  ctx: ListKeyboardContext
): ListKeyCommand | null {
  // A modifier held down means this is someone else's shortcut (cmd/ctrl+k for the palette,
  // browser/OS shortcuts, …) — never treat a combo as plain list navigation.
  if (input.metaKey || input.ctrlKey) return null;
  if (ctx.isTyping) return null;
  if (input.key === 'j') return 'list-down';
  if (input.key === 'k') return 'list-up';
  if (input.key === 'Enter') return 'list-confirm';
  return null;
}
