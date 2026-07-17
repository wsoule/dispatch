import YAML from 'yaml';
import type { Assignee, Priority, TaskDoc, TaskKind, TaskMeta } from './types.js';
import { ASSIGNEES, KINDS, PRIORITIES } from './types.js';

export class TaskParseError extends Error {
  constructor(message: string, readonly file?: string) {
    super(message);
    this.name = 'TaskParseError';
  }
}

const REQUIRED = ['id', 'title', 'status', 'kind', 'created', 'updated'] as const;

export function parseTaskFile(content: string, file?: string): TaskDoc {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!m) throw new TaskParseError('missing frontmatter', file);
  let raw: Record<string, unknown>;
  try {
    raw = YAML.parse(m[1]) ?? {};
  } catch (err) {
    throw new TaskParseError(`invalid YAML frontmatter: ${(err as Error).message}`, file);
  }
  for (const key of REQUIRED) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new TaskParseError(`missing frontmatter field: ${key}`, file);
    }
  }
  // NOTE: status is deliberately NOT validated against the built-in list —
  // .dispatch/config.yml can define custom statuses; the doctor command validates status against config.
  if (!KINDS.includes(raw.kind as TaskKind)) {
    throw new TaskParseError(`invalid kind: ${raw.kind}`, file);
  }
  if (raw.priority != null && !PRIORITIES.includes(raw.priority as Priority)) {
    throw new TaskParseError(`invalid priority: ${raw.priority}`, file);
  }
  if (raw.assignee != null && !ASSIGNEES.includes(raw.assignee as Assignee)) {
    throw new TaskParseError(`invalid assignee: ${raw.assignee}`, file);
  }
  for (const key of ['blocked-by', 'labels'] as const) {
    const value = raw[key];
    if (value != null && !(Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
      throw new TaskParseError(`invalid ${key}: expected a list of strings`, file);
    }
  }
  const meta: TaskMeta = {
    id: String(raw.id),
    title: String(raw.title),
    status: String(raw.status),
    kind: raw.kind as TaskKind,
    parent: (raw.parent as string | null) ?? null,
    blockedBy: (raw['blocked-by'] as string[]) ?? [],
    labels: (raw.labels as string[]) ?? [],
    priority: ((raw.priority as Priority) ?? 'none'),
    assignee: ((raw.assignee as Assignee) ?? 'none'),
    created: String(raw.created),
    updated: String(raw.updated),
    external: (raw.external as string | null) ?? null,
  };
  return { meta, body: content.slice(m[0].length) };
}

export function serializeTaskFile(doc: TaskDoc): string {
  const { meta } = doc;
  const fm = {
    id: meta.id,
    title: meta.title,
    status: meta.status,
    kind: meta.kind,
    parent: meta.parent,
    'blocked-by': meta.blockedBy,
    labels: meta.labels,
    priority: meta.priority,
    assignee: meta.assignee,
    created: meta.created,
    updated: meta.updated,
    external: meta.external,
  };
  return `---\n${YAML.stringify(fm).trimEnd()}\n---\n${doc.body}`;
}

/**
 * Appends an activity bullet. Assumes `## Activity` is the LAST section of the
 * body (the store's create template guarantees this).
 */
export function appendActivity(body: string, line: string): string {
  const entry = `- ${line}`;
  if (!/^## Activity\s*$/m.test(body)) {
    return `${body.trimEnd()}\n\n## Activity\n\n${entry}\n`;
  }
  return `${body.trimEnd()}\n${entry}\n`;
}
