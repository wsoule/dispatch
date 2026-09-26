import { MessagingError } from '@dispatch/protocol';

import { EXTENSION_URIS } from './uris.js';
import type { ExtensionUri } from './uris.js';

// The envelope extension's metadata: a Dispatch envelope riding on an A2A message.
export interface EnvelopeExtV1 {
  id?: string;
  thread?: string;
  from?: string;
  to?: string[];
  kind?: 'message' | 'question' | 'answer' | 'handoff' | 'notice';
  replyTo?: string;
  blocking?: boolean;
  choices?: string[];
  choice?: string;
  refs?: { type: string; id: string }[];
  urgent?: boolean;
  wake?: 'none' | 'request';
}

export type GateTypeName = 'task-proposal' | 'tool-approval' | 'scope' | 'wake';

// The gate extension's task metadata: which owner gates hold the task open.
export interface GateStateV1 {
  gates: {
    id: string;
    type: GateTypeName;
    openedAt: string;
    waitingOn: 'owner';
  }[];
}

export type WorkRequestV1 =
  | {
      skill: 'handoff';
      title: string;
      acceptance?: string[];
      writes?: string[];
      priority?: 'urgent' | 'high' | 'medium' | 'low' | 'none';
      labels?: string[];
    }
  | { skill: 'status'; task?: string };

export interface WorkStateV1 {
  task: string;
  title: string;
  status: string;
  stage?: 'review' | 'landing';
}

export type WorkArtifactV1 =
  | { kind: 'answer'; messageId: string; choice?: string }
  | { kind: 'pr'; url: string; number: number; state?: 'open' | 'merged' }
  | {
      kind: 'diffstat';
      files: number;
      insertions: number;
      deletions: number;
      perFile: { path: string; insertions: number; deletions: number }[];
    }
  | {
      kind: 'evidence';
      items: {
        command: string;
        exitCode: number;
        durationMs: number;
        summary: string;
      }[];
    };

type HandoffRequestV1 = Extract<WorkRequestV1, { skill: 'handoff' }>;

const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;
const INBOUND_KINDS = [
  'message',
  'question',
  'answer',
  'handoff',
  'notice',
] as const;
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export const MAX_METADATA_BYTES = 64 * 1024;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function invalid(field: string, why: string): never {
  throw new MessagingError('invalid', `${field}: ${why}`, field);
}

function oneLine(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim() === '')
    invalid(field, 'expected non-empty text');
  if (LINE_BREAK.test(value)) invalid(field, 'must be one line');
  if (utf8Bytes(value) > maxBytes)
    invalid(field, `at most ${maxBytes} bytes (UTF-8)`);
  return value;
}

function list<T>(
  value: unknown,
  field: string,
  max: number,
  each: (v: unknown, f: string) => T
): T[] {
  if (!Array.isArray(value)) invalid(field, 'expected a list');
  if (value.length > max) invalid(field, `at most ${max} entries`);
  return value.map((v: unknown, i) => each(v, `${field}[${i}]`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Inbound refs: only task and message ids, and no `at`.
function inboundRef(
  value: unknown,
  field: string
): { type: 'task' | 'message'; id: string } {
  if (!isRecord(value)) invalid(field, 'expected { type, id }');
  const type = value.type;
  if (type !== 'task' && type !== 'message')
    invalid(`${field}.type`, 'only task and message refs are accepted');
  if (value.at !== undefined) invalid(`${field}.at`, 'not accepted over A2A');
  return { type, id: oneLine(value.id, `${field}.id`, 512) };
}

// The envelope a client sent; `from`, `id` and `thread` are ignored (the bearer decides).
export function parseEnvelopeExt(raw: unknown): EnvelopeExtV1 {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) invalid('envelope', 'expected an object');
  if (raw.urgent === true)
    throw new MessagingError(
      'forbidden',
      'urgent is not available over A2A',
      'urgent'
    );
  if (raw.wake === 'request')
    throw new MessagingError(
      'forbidden',
      'an A2A client cannot wake a run',
      'wake'
    );
  const out: EnvelopeExtV1 = {};
  if (raw.to !== undefined)
    out.to = list(raw.to, 'to', 50, (v, f) => oneLine(v, f, 512));
  if (raw.kind !== undefined) {
    if (typeof raw.kind === 'string' && raw.kind.startsWith('x-')) {
      throw new MessagingError(
        'forbidden',
        'custom x- kinds are not accepted over A2A',
        'kind'
      );
    }
    if (!(INBOUND_KINDS as readonly unknown[]).includes(raw.kind)) {
      invalid('kind', 'expected message, question, answer, handoff or notice');
    }
    out.kind = raw.kind as (typeof INBOUND_KINDS)[number];
  }
  if (raw.replyTo !== undefined)
    out.replyTo = oneLine(raw.replyTo, 'replyTo', 512);
  if (raw.blocking !== undefined) {
    if (typeof raw.blocking !== 'boolean')
      invalid('blocking', 'expected true or false');
    out.blocking = raw.blocking;
  }
  if (raw.choices !== undefined)
    out.choices = list(raw.choices, 'choices', 20, (v, f) =>
      oneLine(v, f, 200)
    );
  if (raw.choice !== undefined) out.choice = oneLine(raw.choice, 'choice', 200);
  if (raw.refs !== undefined) out.refs = list(raw.refs, 'refs', 50, inboundRef);
  return out;
}

// A `writes` entry: one line and repo-relative, so a client cannot declare a
// claim outside the repository.
function repoPath(value: unknown, field: string): string {
  const path = oneLine(value, field, 512);
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').includes('..')
  ) {
    invalid(field, 'expected a repo-relative path or glob');
  }
  return path;
}

// The work extension's request: which skill, and a handoff's fields.
export function parseWorkExt(raw: unknown): WorkRequestV1 | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) invalid('work', 'expected an object');
  if (raw.skill === 'status') {
    return raw.task === undefined
      ? { skill: 'status' }
      : { skill: 'status', task: oneLine(raw.task, 'work.task', 512) };
  }
  if (raw.skill !== 'handoff')
    invalid('work.skill', 'expected handoff or status');
  const out: HandoffRequestV1 = {
    skill: 'handoff',
    title: oneLine(raw.title, 'work.title', 200),
  };
  if (raw.acceptance !== undefined)
    out.acceptance = list(raw.acceptance, 'work.acceptance', 20, (v, f) =>
      oneLine(v, f, 500)
    );
  if (raw.writes !== undefined)
    out.writes = list(raw.writes, 'work.writes', 50, repoPath);
  if (raw.priority !== undefined) {
    if (!(PRIORITIES as readonly unknown[]).includes(raw.priority))
      invalid('work.priority', `expected ${PRIORITIES.join(', ')}`);
    out.priority = raw.priority as (typeof PRIORITIES)[number];
  }
  if (raw.labels !== undefined)
    out.labels = list(raw.labels, 'work.labels', 10, (v, f) =>
      oneLine(v, f, 50)
    );
  return out;
}

// Active when named in the A2A-Extensions header or the message's own list.
export function activatedExtensions(
  header: string | null,
  messageExtensions: readonly string[] = []
): Set<ExtensionUri> {
  const named = [...(header ?? '').split(','), ...messageExtensions].map((s) =>
    s.trim()
  );
  return new Set(EXTENSION_URIS.filter((uri) => named.includes(uri)));
}

// Every extension at its field limits fits in this; anything larger is refused.
export function checkMetadataBudget(
  metadata: Record<string, unknown> | undefined
): void {
  if (
    metadata !== undefined &&
    utf8Bytes(JSON.stringify(metadata)) > MAX_METADATA_BYTES
  ) {
    invalid('message.metadata', `at most ${MAX_METADATA_BYTES} bytes as JSON`);
  }
}
