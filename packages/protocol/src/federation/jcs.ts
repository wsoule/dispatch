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
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map((v: unknown) => canonicalize(v === undefined ? null : v)).join(',')}]`;
      const obj = value as Record<string, unknown>;
      // A comparator-free sort compares UTF-16 code units, as JCS asks.
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS cannot serialize a ${typeof value}`);
  }
}
