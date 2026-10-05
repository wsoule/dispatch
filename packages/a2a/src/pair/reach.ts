import type { JsonValue } from '@dispatch-foo/protocol';

/** How one side of a pairing reaches the other: a card URL, or a link transport. */
export type Reach =
  | { kind: 'url'; card: string }
  | { kind: 'link'; transport: Record<string, JsonValue> };
