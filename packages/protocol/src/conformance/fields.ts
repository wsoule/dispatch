import type { Json, JsonObject } from '@dispatch-foo/protocol-spec';

// A vector field the adapter cannot read. It is thrown as a plain error, so
// the vector fails as an adapter error rather than being skipped.
export function malformed(where: string, why: string): never {
  throw new Error(`malformed vector field ${where}: ${why}`);
}

export function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asObject(value: Json | undefined, where: string): JsonObject {
  return isObject(value) ? value : malformed(where, 'expected an object');
}

export function text(obj: JsonObject, key: string, where: string): string {
  const value = obj[key];
  return typeof value === 'string'
    ? value
    : malformed(`${where}.${key}`, 'expected a string');
}

export function optionalText(
  obj: JsonObject,
  key: string,
  where: string
): string | undefined {
  return obj[key] === undefined ? undefined : text(obj, key, where);
}

export function texts(value: Json | undefined, where: string): string[] {
  if (!Array.isArray(value)) return malformed(where, 'expected a list');
  return value.map((v, i) =>
    typeof v === 'string' ? v : malformed(`${where}[${i}]`, 'expected a string')
  );
}

// Sessions are `run:` addresses in vectors; the engine keys runs by bare id.
export function bare(session: string): string {
  return session.startsWith('run:') ? session.slice('run:'.length) : session;
}
