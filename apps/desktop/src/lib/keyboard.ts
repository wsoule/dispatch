// Pure keyboard-intent resolution — no DOM, no React. `useGlobalKeyboard` (hooks/) is the
// only place that touches `window`/`document`; it builds a `KeyInput`/`KeyboardContext` pair
// from a real KeyboardEvent and the app's current UI state, then dispatches whatever this
// resolves to. Keeping the decision itself pure makes every shortcut in the redesign brief
// (c, /, cmd+k, j/k, enter, esc) independently testable against plain objects.

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface KeyboardContext {
  /** True while focus is inside a text input/textarea/contenteditable — single-letter
   * shortcuts (c, j, k) must not fire while someone is typing a task title. Escape and
   * cmd/ctrl+k still fire regardless, since those are the two shortcuts a person expects to
   * work from inside a text field too (bail out of an edit, or jump to the palette). */
  isTyping: boolean;
  paletteOpen: boolean;
  peekOpen: boolean;
}

export type KeyCommand =
  | 'open-palette'
  | 'new-task'
  | 'escape'
  | 'list-up'
  | 'list-down'
  | 'list-confirm';

/** Maps one keydown to the command it should trigger, or `null` if this keystroke isn't a
 * shortcut right now (either it doesn't match anything, or the context says to ignore it —
 * e.g. plain "c" while a text field has focus). */
export function resolveKeyCommand(
  input: KeyInput,
  ctx: KeyboardContext
): KeyCommand | null {
  const combo = input.metaKey || input.ctrlKey;

  if (input.key === 'Escape') return 'escape';
  if (combo && input.key.toLowerCase() === 'k') return 'open-palette';

  // Every other shortcut below is a bare letter/symbol — never hijack normal typing.
  if (ctx.isTyping) return null;

  if (input.key === '/') return 'open-palette';
  if (input.key === 'c') return 'new-task';
  if (input.key === 'j') return 'list-down';
  if (input.key === 'k') return 'list-up';
  if (input.key === 'Enter') return 'list-confirm';
  return null;
}
