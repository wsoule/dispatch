// What canonicalize throws for a value JCS cannot write: a lone surrogate, a
// non-finite number, a type JSON lacks, or nesting past MAX_JSON_DEPTH.
export class CanonicalizeError extends TypeError {
  override name = 'CanonicalizeError';
}

// The deepest nesting of arrays and objects JCS writes. A fixed bound, well
// under any runtime's stack, gives every peer the same verdict on an op.
export const MAX_JSON_DEPTH = 256;

// Under the u flag a pair reads as one code point, so this matches only a
// lone surrogate, which I-JSON (RFC 8785's input) forbids.
const LONE_SURROGATE = /\p{Cs}/u;

function iJsonString(s: string): string {
  if (LONE_SURROGATE.test(s))
    throw new CanonicalizeError('JCS refuses a lone surrogate');
  return JSON.stringify(s);
}

// JCS with `str` writing each string and key, so only hashed text need refuse.
// `depth` counts the arrays and objects around `value`; a cycle hits the bound.
function write(
  value: unknown,
  str: (s: string) => string,
  depth: number
): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new CanonicalizeError('JCS refuses non-finite numbers');
      return JSON.stringify(value);
    case 'string':
      return str(value);
    case 'object': {
      if (depth >= MAX_JSON_DEPTH)
        throw new CanonicalizeError(
          `JCS refuses nesting past ${MAX_JSON_DEPTH}`
        );
      const inner = depth + 1;
      if (Array.isArray(value))
        return `[${value.map((v: unknown) => write(v === undefined ? null : v, str, inner)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      // A comparator-free sort compares UTF-16 code units, as JCS asks.
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${str(k)}:${write(obj[k], str, inner)}`).join(',')}}`;
    }
    default:
      throw new CanonicalizeError(`JCS cannot serialize a ${typeof value}`);
  }
}

// RFC 8785: keys sorted by UTF-16 code units (JS string order), strings and
// numbers exactly as JSON.stringify writes them, lone surrogates refused.
export function canonicalize(value: unknown): string {
  return write(value, iJsonString, 0);
}

// canonicalize for text that is never hashed, such as a sealed payload: a lone
// surrogate is escaped as JSON.stringify writes it rather than refused.
export function canonicalizeLenient(value: unknown): string {
  return write(value, JSON.stringify, 0);
}
