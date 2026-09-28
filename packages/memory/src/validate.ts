import { TASK_ID_PATTERN } from '@dispatch/core';
import { LINE_BREAK, REF_TYPES } from '@dispatch/protocol';
import type { Ref } from '@dispatch/protocol';

import { MemoryError } from './errors.js';
import { MEMORY_LIMITS, utf8Bytes } from './limits.js';
import { MEMORY_KINDS, MEMORY_SCOPES } from './types.js';
import type { MemoryEntry, MemoryKind, MemoryScope } from './types.js';

export interface MemoryWriteInput {
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  body: string;
  refs?: Ref[];
  epic?: string | null;
  appliesTo?: string[];
  projectKey?: string | null;
}

export interface ValidMemoryInput {
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  body: string;
  refs: Ref[];
  epic: string | null;
  appliesTo: string[];
  projectKey: string | null;
}

const PROJECT_KEY = /^[0-9a-f]{12}$/;

function invalid(field: string, why: string): never {
  throw new MemoryError('invalid', `${field}: ${why}`, field);
}

// A one-line field: no line break of any kind, within `maxBytes`.
function oneLine(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') invalid(field, 'expected a string');
  if (LINE_BREAK.test(value)) invalid(field, 'must not contain line breaks');
  if (utf8Bytes(value) > maxBytes)
    invalid(field, `at most ${maxBytes} bytes (UTF-8)`);
  return value;
}

function validateRefs(refs: unknown): Ref[] {
  if (!Array.isArray(refs)) invalid('refs', 'expected a list');
  if (refs.length > MEMORY_LIMITS.refs)
    invalid('refs', `at most ${MEMORY_LIMITS.refs} refs`);
  return refs.map((raw: Ref, i) => {
    if (!(REF_TYPES as readonly string[]).includes(raw?.type))
      invalid(`refs[${i}].type`, `expected ${REF_TYPES.join('|')}`);
    const id = oneLine(raw.id, `refs[${i}].id`, MEMORY_LIMITS.refBytes);
    if (id === '') invalid(`refs[${i}].id`, 'required');
    if (raw.at === undefined) return { type: raw.type, id };
    return {
      type: raw.type,
      id,
      at: oneLine(raw.at, `refs[${i}].at`, MEMORY_LIMITS.refBytes),
    };
  });
}

/** Checks one write against the Validation rules and limits; fills defaults. */
export function validateMemoryInput(input: MemoryWriteInput): ValidMemoryInput {
  if (!(MEMORY_SCOPES as readonly string[]).includes(input.scope))
    invalid('scope', `expected ${MEMORY_SCOPES.join('|')}`);
  if (!(MEMORY_KINDS as readonly string[]).includes(input.kind))
    invalid('kind', `expected ${MEMORY_KINDS.join('|')}`);
  const personal = input.scope === 'personal';
  if (input.kind === 'preference' && !personal)
    invalid(
      'kind',
      'a preference belongs to one human: save it with scope "personal"'
    );
  if (input.kind === 'convention' && personal)
    invalid(
      'kind',
      'a convention is how this project works: save it with scope "project" or "team"'
    );
  const title = oneLine(input.title, 'title', MEMORY_LIMITS.titleBytes);
  if (title.trim() === '')
    invalid('title', 'required: the title is the whole lesson in one line');
  if (typeof input.body !== 'string') invalid('body', 'expected a string');
  if (utf8Bytes(input.body) > MEMORY_LIMITS.bodyBytes)
    invalid(
      'body',
      `at most ${MEMORY_LIMITS.bodyBytes} bytes (UTF-8); long-form belongs in Docs`
    );
  const refs = validateRefs(input.refs ?? []);
  const epic = input.epic ?? null;
  const appliesTo = input.appliesTo ?? [];
  const projectKey = input.projectKey ?? null;
  if (personal) {
    if (epic !== null)
      invalid(
        'epic',
        'personal memory has no epic; narrow it with projectOnly'
      );
    if (appliesTo.length > 0)
      invalid('appliesTo', 'personal memory has no task reach');
    if (projectKey !== null && !PROJECT_KEY.test(projectKey))
      invalid('projectKey', 'expected a 12-hex project key');
  } else {
    if (projectKey !== null)
      invalid('projectKey', 'only personal memory is narrowed to a project');
    if (epic !== null && !TASK_ID_PATTERN.test(epic))
      invalid('epic', 'expected an epic id like e-1a2b3c');
    if (appliesTo.length > MEMORY_LIMITS.appliesTo)
      invalid('appliesTo', `at most ${MEMORY_LIMITS.appliesTo} task ids`);
    appliesTo.forEach((id, i) => {
      if (!TASK_ID_PATTERN.test(id))
        invalid(`appliesTo[${i}]`, 'expected a task id like t-1a2b3c');
    });
  }
  return {
    scope: input.scope,
    kind: input.kind,
    title,
    body: input.body,
    refs,
    epic,
    appliesTo: [...new Set(appliesTo)],
    projectKey,
  };
}

/** A supersede or retire target: visible, active, and in the writer's own scope. */
export function checkTarget(
  target: MemoryEntry | null,
  scope: MemoryScope,
  field: string,
  ref: string
): MemoryEntry {
  if (target === null)
    throw new MemoryError(
      'not-found',
      `${field}: no memory ${ref} you can see`,
      field
    );
  if (target.status !== 'active')
    invalid(field, `${target.handle} is already retired`);
  if (target.scope !== scope)
    invalid(
      field,
      `${target.handle} is ${target.scope} memory; a ${scope} write cannot change it (promote copies instead)`
    );
  return target;
}

export function validateReason(reason: string, field = 'reason'): string {
  const value = oneLine(reason, field, MEMORY_LIMITS.reasonBytes);
  if (value.trim() === '') invalid(field, 'required');
  return value;
}

export function validateQuery(query: string): string {
  if (typeof query !== 'string') invalid('query', 'expected a string');
  if (utf8Bytes(query) > MEMORY_LIMITS.queryBytes)
    invalid('query', `at most ${MEMORY_LIMITS.queryBytes} bytes (UTF-8)`);
  return query;
}
