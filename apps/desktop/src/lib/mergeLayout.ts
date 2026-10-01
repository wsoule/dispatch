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

const OPEN = '<<<<<<< ';
const BASE = '||||||| ';
const SEPARATOR = '=======';
const CLOSE = '>>>>>>> ';

// A block being read: the lines after its opening marker, how deep inside a
// block nested in one of its sides the next line sits, and where its own
// base marker and `=======` lines fall among those lines.
interface OpenBlock {
  opening: string;
  headLabel: string;
  lines: string[];
  depth: number;
  base: number;
  separators: number[];
}

// A closed block split at its separator: the first `=======` after its base
// marker, so an underline on the head side stays text, else the first one.
function conflictOf(block: OpenBlock, mineLabel: string): MergePart {
  const { lines, base, separators } = block;
  const separator =
    separators.find((i) => i > base) ?? separators.at(0) ?? lines.length;
  const hasBase = base !== -1 && base < separator;
  return {
    kind: 'conflict',
    head: lines.slice(0, hasBase ? base : separator),
    base: hasBase ? lines.slice(base + 1, separator) : [],
    mine: lines.slice(separator + 1),
    headLabel: block.headLabel,
    mineLabel,
  };
}

// Local labels (a 409's `head (rev N, X)` and `yours`) and revision ids (a
// stored merge) parse alike. A block nested in a side is that side's text, and
// a block left unclosed stays text, markers and all.
export function parseMarked(text: string): MergePart[] {
  const parts: MergePart[] = [];
  let plain: string[] = [];
  let block: OpenBlock | null = null;
  for (const line of splitKeep(text)) {
    const bare = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (block === null) {
      if (bare.startsWith(OPEN)) {
        if (plain.length > 0) parts.push({ kind: 'text', lines: plain });
        plain = [];
        block = {
          opening: line,
          headLabel: bare.slice(OPEN.length),
          lines: [],
          depth: 0,
          base: -1,
          separators: [],
        };
      } else plain.push(line);
      continue;
    }
    if (bare.startsWith(OPEN)) block.depth += 1;
    else if (block.depth > 0) {
      if (bare.startsWith(CLOSE)) block.depth -= 1;
    } else if (bare.startsWith(BASE) && block.base === -1) {
      block.base = block.lines.length;
    } else if (bare === SEPARATOR) block.separators.push(block.lines.length);
    else if (bare.startsWith(CLOSE) && block.separators.length > 0) {
      parts.push(conflictOf(block, bare.slice(CLOSE.length)));
      block = null;
      continue;
    }
    block.lines.push(line);
  }
  if (block !== null) plain.push(block.opening, ...block.lines);
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
