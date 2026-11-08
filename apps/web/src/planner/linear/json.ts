// Defensive readers for JSON that comes from outside the process (Linear's
// GraphQL and OAuth responses, webhook bodies). Everything arrives as
// `unknown`; these helpers narrow it field by field so a shape change in
// Linear surfaces as a clear error instead of `undefined` deep in core.

import { LinearApiError } from './gateway.js';

/** A plain JSON object (not null, not an array). */
export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at `key` when it is a string, else null. */
export function optionalString(obj: JsonObject, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

/** The value at `key` when it is a finite number, else null. */
export function optionalNumber(obj: JsonObject, key: string): number | null {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The value at `key` when it is a boolean, else null. */
export function optionalBoolean(obj: JsonObject, key: string): boolean | null {
  const value = obj[key];
  return typeof value === 'boolean' ? value : null;
}

/** The nested object at `key`, or null when absent/null/not an object. */
export function optionalObject(
  obj: JsonObject,
  key: string
): JsonObject | null {
  const value = obj[key];
  return isRecord(value) ? value : null;
}

/** `obj[key].id` for `{ id }` references (e.g. `assignee { id }`). */
export function optionalRefId(obj: JsonObject, key: string): string | null {
  const ref = optionalObject(obj, key);
  return ref === null ? null : optionalString(ref, 'id');
}

// A response that does not have the shape our query asked for is reported
// as a GraphQL-level failure: retrying will not fix it and it names the field.
function malformed(what: string): LinearApiError {
  return new LinearApiError('graphql', `Malformed Linear response: ${what}`);
}

/** The string at `key`, or throws naming the entity and field. */
export function requireString(
  obj: JsonObject,
  key: string,
  entity: string
): string {
  const value = optionalString(obj, key);
  if (value === null) {
    throw malformed(`${entity}.${key} is missing`);
  }
  return value;
}

/** The boolean at `key`, or throws naming the entity and field. */
export function requireBoolean(
  obj: JsonObject,
  key: string,
  entity: string
): boolean {
  const value = optionalBoolean(obj, key);
  if (value === null) {
    throw malformed(`${entity}.${key} is missing`);
  }
  return value;
}

/** The object at `key`, or throws naming the entity and field. */
export function requireObject(
  obj: JsonObject,
  key: string,
  entity: string
): JsonObject {
  const value = optionalObject(obj, key);
  if (value === null) {
    throw malformed(`${entity}.${key} is missing`);
  }
  return value;
}

/** `obj[key].id` for a required reference, or throws. */
export function requireRefId(
  obj: JsonObject,
  key: string,
  entity: string
): string {
  const value = optionalRefId(obj, key);
  if (value === null) {
    throw malformed(`${entity}.${key}.id is missing`);
  }
  return value;
}

/** The array at `key` (empty when absent or not an array). */
export function arrayAt(obj: JsonObject, key: string): unknown[] {
  const value = obj[key];
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** Shape of one page of a GraphQL connection after narrowing. */
export interface ConnectionPage {
  nodes: JsonObject[];
  hasNextPage: boolean;
  endCursor: string | null;
}

// Reads `{ nodes [...] pageInfo { hasNextPage endCursor } }`. Nodes that are
// not objects are dropped; a missing pageInfo reads as "last page" so a
// malformed response can never loop forever.
export function readConnection(value: unknown, entity: string): ConnectionPage {
  if (!isRecord(value)) {
    throw malformed(`${entity} connection is missing`);
  }
  const nodes = arrayAt(value, 'nodes').filter(isRecord);
  const pageInfo = optionalObject(value, 'pageInfo');
  const hasNextPage =
    pageInfo === null
      ? false
      : optionalBoolean(pageInfo, 'hasNextPage') === true;
  const endCursor =
    pageInfo === null ? null : optionalString(pageInfo, 'endCursor');
  return { nodes, hasNextPage, endCursor };
}
