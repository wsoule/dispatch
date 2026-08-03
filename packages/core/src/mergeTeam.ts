import { parse, stringify } from 'yaml';

// A three-way merge for `.dispatch/team.yml`: members are unioned by
// `handle` rather than merged line-by-line, so two developers' daemons
// self-registering at the list's end don't collide the way plain text
// merge would. Mirrors mergeTask.ts's shape (same sentinel, same pick()).
//
// Operates on raw parsed YAML rather than going through parseTeam/
// upsertMember — those intentionally drop a malformed entry, which is the
// wrong behavior for a merge driver: a member neither side rejected must
// not silently disappear just because the driver saw it first.

// Sentinel for "no consensus" — distinct from any real member value so it
// can't collide with a member field that legitimately holds `null` or
// `undefined` (see mergeTask.ts's identical sentinel for why a `null`
// sentinel is the wrong choice here).
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

interface Roster {
  byHandle: Map<string, Record<string, unknown>>;
  order: string[];
}

function parseRoster(text: string): Roster {
  const raw =
    text.trim() === '' ? {} : ((parse(text) ?? {}) as Record<string, unknown>);
  const list = Array.isArray(raw.members) ? (raw.members as unknown[]) : [];
  const byHandle = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  for (const item of list) {
    const entry = item as Record<string, unknown>;
    const handle = typeof entry?.handle === 'string' ? entry.handle : undefined;
    // An entry with no usable handle has no key to merge by — dropped, same
    // failure mode parseTeam already treats as acceptable for a bad entry.
    if (handle === undefined) continue;
    if (!byHandle.has(handle)) order.push(handle);
    byHandle.set(handle, entry);
  }
  return { byHandle, order };
}

// Renders one member as a `members:`-list item — the same text
// `stringify({ members: [member] })` would produce for it alone, minus the
// leading `members:` line, so blocks can be joined back under one heading.
function renderMember(member: Record<string, unknown>): string {
  const text = stringify({ members: [member] });
  return text.slice('members:\n'.length).replace(/\n$/, '');
}

// A member edited differently on both sides: embeds raw conflict markers
// inside the YAML list rather than picking a side. This deliberately makes
// the file unparseable — the same degraded state a naive git text merge
// would have produced — so ActorContext.resolve()'s existing
// rosterReadable=false handling (never invent an empty roster) catches it.
function conflictBlock(ours: unknown, theirs: unknown): string {
  const render = (side: unknown) =>
    side === undefined
      ? '    (absent)'
      : renderMember(side as Record<string, unknown>).replace(/^  - /, '    ');
  return [
    '  - <<<<<<< ours',
    render(ours),
    '    =======',
    render(theirs),
    '    >>>>>>> theirs',
  ].join('\n');
}

export function mergeTeamFile(
  base: string,
  ours: string,
  theirs: string
): { ok: boolean; merged: string } {
  const b = parseRoster(base);
  const o = parseRoster(ours);
  const t = parseRoster(theirs);
  let ok = true;

  // Union order: our list order first, then any handle theirs added that we
  // don't have — same policy as mergeTaskFile's section order.
  const order = [...new Set([...o.order, ...t.order])];
  const blocks: string[] = [];

  for (const handle of order) {
    const chosen = pick(
      b.byHandle.get(handle),
      o.byHandle.get(handle),
      t.byHandle.get(handle),
      same
    );
    if (chosen === CONFLICT) {
      ok = false;
      blocks.push(
        conflictBlock(o.byHandle.get(handle), t.byHandle.get(handle))
      );
      continue;
    }
    // undefined means both sides agree the member is gone (e.g. removed on
    // one side, untouched on the other) — drop it, nothing to render.
    if (chosen !== undefined) blocks.push(renderMember(chosen));
  }

  const merged =
    blocks.length > 0 ? `members:\n${blocks.join('\n')}\n` : 'members: []\n';
  return { ok, merged };
}
