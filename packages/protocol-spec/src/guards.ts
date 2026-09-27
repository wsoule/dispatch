// Shape checks for untrusted JSON (vector files, registries, adapter lines),
// written by hand because the kit has no runtime dependency.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A non-empty string.
export function isText(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}
