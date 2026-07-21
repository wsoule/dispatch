import YAML from 'yaml';

import type {
  Assignee,
  Priority,
  TaskDoc,
  TaskKind,
  TaskMeta,
} from './types.js';
import { ASSIGNEES, KINDS, PRIORITIES } from './types.js';

export class TaskParseError extends Error {
  constructor(
    message: string,
    readonly file?: string
  ) {
    super(message);
    this.name = 'TaskParseError';
  }
}

const REQUIRED = [
  'id',
  'title',
  'status',
  'kind',
  'created',
  'updated',
] as const;

export function parseTaskFile(content: string, file?: string): TaskDoc {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (m === null) throw new TaskParseError('missing frontmatter', file);
  let raw: Record<string, unknown>;
  try {
    raw = YAML.parse(m[1]) ?? {};
  } catch (err) {
    throw new TaskParseError(
      `invalid YAML frontmatter: ${(err as Error).message}`,
      file
    );
  }
  for (const key of REQUIRED) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new TaskParseError(`missing frontmatter field: ${key}`, file);
    }
  }
  // NOTE: status is deliberately NOT validated against the built-in list —
  // .dispatch/config.yml can define custom statuses; the doctor command validates status against config.
  if (!KINDS.includes(raw.kind as TaskKind)) {
    throw new TaskParseError(`invalid kind: ${String(raw.kind)}`, file);
  }
  if (raw.priority != null && !PRIORITIES.includes(raw.priority as Priority)) {
    throw new TaskParseError(`invalid priority: ${String(raw.priority)}`, file);
  }
  if (raw.assignee != null && !ASSIGNEES.includes(raw.assignee as Assignee)) {
    throw new TaskParseError(`invalid assignee: ${String(raw.assignee)}`, file);
  }
  for (const key of ['blocked-by', 'labels'] as const) {
    const value = raw[key];
    if (
      value != null &&
      !(Array.isArray(value) && value.every((v) => typeof v === 'string'))
    ) {
      throw new TaskParseError(
        `invalid ${key}: expected a list of strings`,
        file
      );
    }
  }
  const meta: TaskMeta = {
    id: String(raw.id),
    title: String(raw.title),
    status: String(raw.status),
    kind: raw.kind as TaskKind,
    parent: (raw.parent as string | null) ?? null,
    milestone: (raw.milestone as string | null) ?? null,
    blockedBy: (raw['blocked-by'] as string[]) ?? [],
    labels: (raw.labels as string[]) ?? [],
    priority: (raw.priority as Priority) ?? 'none',
    assignee: (raw.assignee as Assignee) ?? 'none',
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
    milestone: meta.milestone,
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
 * Replaces the text under a `## <heading>` section of the body, preserving
 * every other section and their order. Used to make the free-text body
 * sections (Description, Acceptance Criteria) editable from the app the same
 * way frontmatter fields already are, without the caller having to
 * hand-splice markdown. If the heading doesn't exist yet it's inserted before
 * `## Activity` (so the append-only activity log stays last, matching the
 * create template) or appended when there's no Activity section. `content` is
 * trimmed and re-wrapped in the template's blank-line spacing so repeated
 * edits round-trip to stable output.
 */
export function setSection(
  body: string,
  heading: string,
  content: string
): string {
  // Split on section-heading lines, keeping the headings via the capture
  // group: parts = [preamble, "## H1", body1, "## H2", body2, ...].
  const parts = body.split(/^(## .+)$/m);
  const preamble = parts[0];
  const sections: { heading: string; content: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    sections.push({
      heading: parts[i].replace(/^## /, '').trim(),
      content: parts[i + 1] ?? '',
    });
  }

  const trimmed = content.trim();
  // The template wraps a section's text in a blank line on each side; an empty
  // section collapses to just those blank lines so the next heading still has
  // breathing room.
  const wrapped = trimmed === '' ? '\n\n' : `\n\n${trimmed}\n\n`;

  const existing = sections.find((s) => s.heading === heading);
  if (existing !== undefined) {
    existing.content = wrapped;
  } else {
    const activityIdx = sections.findIndex((s) => s.heading === 'Activity');
    const section = { heading, content: wrapped };
    if (activityIdx >= 0) sections.splice(activityIdx, 0, section);
    else sections.push(section);
  }

  return preamble + sections.map((s) => `## ${s.heading}${s.content}`).join('');
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
