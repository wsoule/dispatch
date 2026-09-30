import type { ActivityEntry } from './activityFeed';

/** What one Activity line records, for its glyph. */
export type TimelineKind =
  | 'dispatched'
  | 'finished'
  | 'failed'
  | 'merged'
  | 'discarded'
  | 'pr'
  | 'changes'
  | 'stopped'
  | 'note';

// Checked in order; the first match wins. The daemon writes these lines (see the
// orchestrator's appendActivity calls), so the words are stable.
const RULES: [RegExp, TimelineKind][] = [
  [/\bmerged\b|\blanded\b/, 'merged'],
  [/\bdiscarded\b/, 'discarded'],
  [/opened (?:landing )?PR|\bPR\b.*\bopened\b/, 'pr'],
  [/requested changes|\bresumed\b|\bcontinued\b/, 'changes'],
  // Also matches a re-dispatch.
  [/dispatched\b/, 'dispatched'],
  [/finished: (?:failed|interrupted)|\bfailed\b/, 'failed'],
  [/\bfinished\b/, 'finished'],
  [/\bcancelled\b|stop requested/, 'stopped'],
];

export function timelineKind(text: string): TimelineKind {
  for (const [pattern, kind] of RULES) {
    if (pattern.test(text)) return kind;
  }
  return 'note';
}

/** An Activity line as a timeline row reads it: no `[run r-…]`/`[epic]` routing tag, and
 * a run's `finished: finished — …` said once. */
function timelineText(text: string): string {
  return text
    .replace(/^\[(?:run [^\]]+|epic|plan)\]\s*/, '')
    .replace(/^finished: (\S+)/, (_, state: string) =>
      state === 'finished' ? 'finished' : state
    );
}

export interface TimelineItem {
  at: string | null;
  kind: TimelineKind;
  text: string;
  actor: string | null;
}

/** The task's Activity as timeline items, newest first; undated lines keep their order at
 * the end. */
export function taskTimeline(
  entries: readonly ActivityEntry[]
): TimelineItem[] {
  const items = entries.map((entry) => ({
    at: entry.at,
    // Classified by what the line says: a dispatch credited to a person is still a
    // dispatch, and a free-form note matches no rule.
    kind: timelineKind(entry.text),
    text: timelineText(entry.text),
    actor: entry.actor,
  }));
  const dated = items.filter((i) => i.at !== null);
  const undated = items.filter((i) => i.at === null);
  dated.sort((a, b) => ((a.at ?? '') < (b.at ?? '') ? 1 : -1));
  return [...dated, ...undated];
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

/** `+120 −30 in 6 files` from a unified patch: body lines only, never the `+++`/`---`
 * file headers. */
export function diffStat(patch: string, files: number): DiffStat {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { files, additions, deletions };
}
