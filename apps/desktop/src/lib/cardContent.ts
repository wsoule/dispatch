/**
 * Readable raw text for one transcript or chat item, shown when the item
 * itself fails to draw (see CardErrorBoundary). A string stays as it is;
 * anything else is pretty-printed JSON. A value JSON can't hold (a cycle, a
 * BigInt) gets a short note instead, so the fallback itself never throws.
 */
export function cardRaw(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  try {
    return JSON.stringify(value, null, 2) ?? `(${typeof value})`;
  } catch {
    return '(this step could not be shown as text)';
  }
}

/**
 * A short, stable key for an item's content (FNV-1a over its raw text), so a
 * boundary can reset when a streaming update changes what it shows. Not for
 * security: two different contents may share a key, which only means a
 * crashed card stays crashed until the next change.
 */
export function contentKey(raw: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${raw.length.toString(36)}-${hash.toString(36)}`;
}
