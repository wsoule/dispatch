// The merge view's hunks, pure: git's diff3 markers in either label style
// parsed into text and conflict parts, and resolved back without markers.

export type MergePart =
  | { kind: 'text'; lines: string[] }
  | {
      kind: 'conflict';
      head: string[];
      base: string[];
      mine: string[];
      headLabel: string;
      mineLabel: string;
    };

export type HunkChoice =
  | { take: 'head' }
  | { take: 'mine' }
  | { take: 'edit'; text: string };

// Lines with their newlines kept, so joining them gives the text back.
function splitKeep(text: string): string[] {
  const lines: string[] = [];
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push(text.slice(start, end));
    start = end;
  }
  return lines;
}

// Local labels (a 409's `head (rev N, X)` and `yours`) and revision ids (a
// stored merge) parse alike; a block left unclosed stays text, markers and all.
export function parseMarked(text: string): MergePart[] {
  const parts: MergePart[] = [];
  let plain: string[] = [];
  let hunk: {
    head: string[];
    base: string[];
    mine: string[];
    headLabel: string;
    raw: string[];
  } | null = null;
  let side: 'head' | 'base' | 'mine' = 'head';
  for (const line of splitKeep(text)) {
    const bare = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (hunk === null) {
      if (bare.startsWith('<<<<<<< ')) {
        if (plain.length > 0) parts.push({ kind: 'text', lines: plain });
        plain = [];
        hunk = {
          head: [],
          base: [],
          mine: [],
          headLabel: bare.slice(8),
          raw: [line],
        };
        side = 'head';
      } else plain.push(line);
      continue;
    }
    hunk.raw.push(line);
    if (side === 'head' && bare.startsWith('||||||| ')) side = 'base';
    else if (side !== 'mine' && bare === '=======') side = 'mine';
    else if (side === 'mine' && bare.startsWith('>>>>>>> ')) {
      const { head, base, mine, headLabel } = hunk;
      parts.push({
        kind: 'conflict',
        head,
        base,
        mine,
        headLabel,
        mineLabel: bare.slice(8),
      });
      hunk = null;
    } else hunk[side].push(line);
  }
  if (hunk !== null) plain.push(...hunk.raw);
  if (plain.length > 0) parts.push({ kind: 'text', lines: plain });
  return parts;
}

// The text with each conflict replaced by its choice, in order; an edit
// gains a closing newline so the next part starts on its own line.
export function resolveMarked(
  parts: readonly MergePart[],
  choices: readonly HunkChoice[]
): string {
  let hunk = 0;
  return parts
    .map((p) => {
      if (p.kind === 'text') return p.lines.join('');
      const choice = choices[hunk] ?? { take: 'head' };
      hunk += 1;
      if (choice.take === 'head') return p.head.join('');
      if (choice.take === 'mine') return p.mine.join('');
      return choice.text === '' || choice.text.endsWith('\n')
        ? choice.text
        : `${choice.text}\n`;
    })
    .join('');
}

export function labelFor(
  label: string,
  revisions: readonly { id: string; n: number | null; author: string }[]
): string {
  const rev = revisions.find((r) => r.id === label);
  return rev === undefined ? label : `rev ${rev.n ?? '-'} by ${rev.author}`;
}
