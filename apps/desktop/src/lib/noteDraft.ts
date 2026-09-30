// The comment field's one keyboard rule, kept out of the component so it is testable
// without a textarea.

/** `⌘⏎` / `Ctrl⏎` — the one chord that submits from inside a comment field. */
export function isSubmitChord(input: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return input.key === 'Enter' && (input.metaKey || input.ctrlKey);
}
