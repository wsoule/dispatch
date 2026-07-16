import YAML from 'yaml';
import type { Assignee, Priority, TaskDoc, TaskKind, TaskMeta, TaskStatus } from './types.js';

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
  const meta: TaskMeta = {
    id: String(raw.id),
    title: String(raw.title),
    status: raw.status as TaskStatus,
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
