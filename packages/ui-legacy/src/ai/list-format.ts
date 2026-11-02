// The label pill's dot colour, shared with the app: apps/desktop's lib/labelColor.ts falls
// back to this hash for labels without a stored colour, so a legacy pill and a Gr8r row wear
// the same hue for the same label. The colour has one home here until ui-legacy goes in B16.

const LABEL_COLOR_COUNT = 8;

/** Deterministically maps a label name to one of the `--project-color-1..8` tokens, so `ui`
 * is the same hue on every pill without anyone storing a colour per label. */
export function colorForLabel(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 33 + label.charCodeAt(i)) >>> 0;
  }
  return `var(--project-color-${(hash % LABEL_COLOR_COUNT) + 1})`;
}
