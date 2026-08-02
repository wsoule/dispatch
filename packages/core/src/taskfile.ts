import YAML from 'yaml';

import type {
  Assignee,
  Priority,
  TaskDoc,
  TaskKind,
  TaskMeta,
  TaskRisk,
} from './types.js';
import { ASSIGNEES, KINDS, PRIORITIES, TASK_RISKS } from './types.js';

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
  if (raw['self-review'] != null && typeof raw['self-review'] !== 'boolean') {
    throw new TaskParseError(`invalid self-review: expected a boolean`, file);
  }
  if (raw['archived-at'] != null && typeof raw['archived-at'] !== 'string') {
    throw new TaskParseError(`invalid archived-at: expected a string`, file);
  }
  if (raw.exercised != null && typeof raw.exercised !== 'boolean') {
    throw new TaskParseError(`invalid exercised: expected a boolean`, file);
  }
  if (raw.risk != null && !TASK_RISKS.includes(raw.risk as TaskRisk)) {
    throw new TaskParseError(`invalid risk: ${String(raw.risk)}`, file);
  }
  if (raw.model != null && typeof raw.model !== 'string') {
    throw new TaskParseError(`invalid model: expected a string`, file);
  }
  for (const key of ['blocked-by', 'labels', 'writes'] as const) {
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
    // Absent means on: self-review is the default, so a file only carries the key once the
    // task has explicitly opted out (see serializeTaskFile).
    selfReview: (raw['self-review'] as boolean | undefined) ?? true,
    writes: (raw.writes as string[] | undefined) ?? [],
    risk: (raw.risk as TaskRisk | undefined) ?? 'routine',
    model: raw.model ?? null,
    exercised: (raw.exercised as boolean | undefined) ?? false,
    ...(raw['archived-at'] == null ? {} : { archivedAt: raw['archived-at'] }),
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
    // Only the opt-out is written — self-review defaults to true, so an
    // absent key already means "on," matching how the parser treats it.
    ...(meta.selfReview ? {} : { 'self-review': false }),
    // Unlike blocked-by/labels, an empty writes list is meaningful ("declared
    // nothing") rather than "unset", so it always serializes.
    writes: meta.writes,
    ...(meta.risk === 'routine' ? {} : { risk: meta.risk }),
    ...(meta.model === null ? {} : { model: meta.model }),
    ...(meta.archivedAt === undefined
      ? {}
      : { 'archived-at': meta.archivedAt }),
    ...(meta.exercised ? { exercised: true } : {}),
  };
  return `---\n${YAML.stringify(fm).trimEnd()}\n---\n${doc.body}`;
}

// Splits a body into its `## ` sections: parts = [preamble, "## H1", body1, ...].
function splitSections(body: string): {
  preamble: string;
  sections: { heading: string; content: string }[];
} {
  const parts = body.split(/^(## .+)$/m);
  const sections: { heading: string; content: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    sections.push({
      heading: parts[i].replace(/^## /, '').trim(),
      content: parts[i + 1] ?? '',
    });
  }
  return { preamble: parts[0], sections };
}

/**
 * Reads the text under a `## <heading>` section, trimmed. The read counterpart
 * of `setSection`; `''` when the heading is absent or has nothing under it.
 */
export function getSection(body: string, heading: string): string {
  const { sections } = splitSections(body);
  return sections.find((s) => s.heading === heading)?.content.trim() ?? '';
}

/**
 * Replaces a `## <heading>` section's text, preserving the other sections and
 * their order; inserts a missing heading before `## Activity` (or appends it).
 */
export function setSection(
  body: string,
  heading: string,
  content: string
): string {
  const { preamble, sections } = splitSections(body);

  const trimmed = content.trim();
  // Sections are blank-line padded; an empty one collapses to just the
  // padding so the next heading still has breathing room.
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

/**
 * Removes a `## <heading>` section entirely, heading included — unlike
 * `setSection(body, heading, '')`, which leaves an empty heading in place.
 */
export function removeSection(body: string, heading: string): string {
  const { preamble, sections } = splitSections(body);
  return (
    preamble +
    sections
      .filter((s) => s.heading !== heading)
      .map((s) => `## ${s.heading}${s.content}`)
      .join('')
  );
}

// A correction recorded against a task's spec after the fact — what changes,
// why, and (optionally) where the correction came from.
export interface Amendment {
  date: string;
  reason: string;
  overrides: string;
  source: string | null;
}

// One amendment as a dated markdown block; `formatAmendment` output is joined
// by `appendAmendment` so a task can accumulate more than one over time.
function formatAmendment(amendment: Amendment): string {
  const lines = [
    `### ${amendment.date}`,
    `**Overrides:** ${amendment.overrides}`,
    `**Reason:** ${amendment.reason}`,
  ];
  if (amendment.source !== null) {
    lines.push(`**Source:** ${amendment.source}`);
  }
  return lines.join('\n');
}

/**
 * Appends a new amendment to the `## Amendments` section, keeping every prior
 * one — corrections accumulate rather than overwrite a task's history.
 */
export function appendAmendment(body: string, amendment: Amendment): string {
  const existing = getSection(body, 'Amendments');
  const entry = formatAmendment(amendment);
  const content = existing === '' ? entry : `${existing}\n\n${entry}`;
  return setSection(body, 'Amendments', content);
}
