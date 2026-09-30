// How a container's `icon` field draws. Linear stores either an emoji or the name of one
// of its own icons (sometimes as a `:shortcode:`); a name the app has no glyph for falls
// back to the container's kind glyph.

export type ContainerIconSource =
  | { kind: 'emoji'; emoji: string }
  | { kind: 'named'; name: string }
  | null;

const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** What to draw for an `icon` value: the emoji itself, a lowercased name to look up, or
 * nothing (no icon set). */
export function containerIconSource(icon: string | null): ContainerIconSource {
  const value = icon?.trim() ?? '';
  if (value === '') return null;
  if (EMOJI_RE.test(value)) return { kind: 'emoji', emoji: value };
  const name = value.replace(/^:|:$/g, '').toLowerCase();
  return name === '' ? null : { kind: 'named', name };
}
