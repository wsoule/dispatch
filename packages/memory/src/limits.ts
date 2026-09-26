export const MEMORY_LIMITS = {
  titleBytes: 200,
  bodyBytes: 8192,
  refs: 20,
  refBytes: 512,
  appliesTo: 50,
  reasonBytes: 500,
  queryBytes: 500,
} as const;

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

// The longest prefix of `text` within `maxBytes` UTF-8 bytes, cut between code points.
export function cutUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let used = 0;
  let out = '';
  for (const ch of text) {
    const size = utf8Bytes(ch);
    if (used + size > maxBytes) break;
    used += size;
    out += ch;
  }
  return out;
}
