// Under the u flag a pair reads as one code point, so this matches only a
// lone surrogate, which I-JSON (RFC 8785's input) forbids.
const LONE_SURROGATE = /\p{Cs}/u;

function jsonString(s: string): string {
  if (LONE_SURROGATE.test(s))
    throw new TypeError('JCS refuses a lone surrogate');
  return JSON.stringify(s);
}

// RFC 8785: keys sorted by UTF-16 code units (JS string order), strings and
// numbers exactly as JSON.stringify writes them.
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError('JCS refuses non-finite numbers');
      return JSON.stringify(value);
    case 'string':
      return jsonString(value);
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map((v: unknown) => canonicalize(v === undefined ? null : v)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      // A comparator-free sort compares UTF-16 code units, as JCS asks.
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${jsonString(k)}:${canonicalize(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS cannot serialize a ${typeof value}`);
  }
}
