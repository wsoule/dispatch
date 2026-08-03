import { parse, stringify } from 'yaml';

// A three-way merge that understands a task file: Activity is append-only so
// it unions, and frontmatter merges per field rather than per line.
//
// Deliberately does not use parseTaskFile — a file arriving mid-conflict may
// hold values the strict parser rejects, and that is exactly the moment the
// merge must still work. This operates on raw text and YAML instead.

interface Split {
  fields: Record<string, unknown>;
  sections: Map<string, string[]>;
  order: string[];
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function split(text: string): Split {
  const match = FRONTMATTER.exec(text);
  const fields =
    match !== null
      ? ((parse(match[1] ?? '') ?? {}) as Record<string, unknown>)
      : {};
  const body = match !== null ? text.slice(match[0].length) : text;
  const sections = new Map<string, string[]>();
  const order: string[] = [];
  let current = '';
  sections.set(current, []);
  order.push(current);
  for (const line of body.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading !== null) {
      current = heading[1] ?? '';
      if (!sections.has(current)) {
        sections.set(current, []);
        order.push(current);
      }
      continue;
    }
    sections.get(current)?.push(line);
  }
  return { fields, sections, order };
}

// Sentinel for "no consensus" — distinct from any real field value so it
// can't collide with a field that legitimately holds `null` (e.g. a task's
// `parent`, `milestone`, or `external`, all `null` by default).
const CONFLICT = Symbol('conflict');

// Standard three-way pick: unchanged sides defer, equal sides agree.
function pick<T>(
  b: T,
  o: T,
  t: T,
  eq: (x: T, y: T) => boolean
): T | typeof CONFLICT {
  if (eq(o, t)) return o;
  if (eq(b, o)) return t;
  if (eq(b, t)) return o;
  return CONFLICT;
}

const same = (x: unknown, y: unknown) =>
  JSON.stringify(x) === JSON.stringify(y);

function conflictBlock(ours: string, theirs: string): string {
  return `<<<<<<< ours\n${ours}\n=======\n${theirs}\n>>>>>>> theirs`;
}

export function mergeTaskFile(
  base: string,
  ours: string,
  theirs: string
): { ok: boolean; merged: string } {
  const b = split(base);
  const o = split(ours);
  const t = split(theirs);
  let ok = true;

  const fields: Record<string, unknown> = {};
  const keys = [
    ...new Set([
      ...Object.keys(o.fields),
      ...Object.keys(t.fields),
      ...Object.keys(b.fields),
    ]),
  ];
  for (const key of keys) {
    // `updated` is a monotonic clock, not a value to reconcile — take the max.
    if (key === 'updated') {
      const values = [o.fields[key], t.fields[key]].filter(
        (v): v is string => typeof v === 'string'
      );
      fields[key] = values.sort().at(-1) ?? b.fields[key];
      continue;
    }
    const chosen = pick(b.fields[key], o.fields[key], t.fields[key], same);
    if (chosen === CONFLICT) {
      ok = false;
      fields[key] = conflictBlock(
        JSON.stringify(o.fields[key]),
        JSON.stringify(t.fields[key])
      );
      continue;
    }
    if (chosen !== undefined) fields[key] = chosen;
  }

  const order = [...new Set([...o.order, ...t.order])];
  const parts: string[] = [];
  for (const heading of order) {
    const bl = b.sections.get(heading) ?? [];
    const ol = o.sections.get(heading) ?? [];
    const tl = t.sections.get(heading) ?? [];
    let lines: string[];
    if (heading === 'Activity') {
      // Append-only by construction, so union preserving our order, then
      // whatever the other side added that we have not seen.
      const seen = new Set(ol);
      lines = [...ol, ...tl.filter((l) => l.trim() !== '' && !seen.has(l))];
    } else {
      const chosen = pick(bl, ol, tl, same);
      if (chosen === CONFLICT) {
        ok = false;
        lines = [conflictBlock(ol.join('\n'), tl.join('\n'))];
      } else {
        lines = chosen;
      }
    }
    if (heading === '') {
      parts.push(lines.join('\n'));
      continue;
    }
    parts.push(`## ${heading}`, lines.join('\n'));
  }

  const merged = `---\n${stringify(fields).trimEnd()}\n---\n${parts.join('\n')}`;
  return { ok, merged: merged.endsWith('\n') ? merged : `${merged}\n` };
}
