// A deterministic markdown body near the docs cap, and the six edit shapes the
// spec measured merge cost on (Merge, "Measured").

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'token',
  'session',
  'cookie',
  'route',
  'daemon',
  'agent',
  'review',
  'merge',
  'anchor',
  'budget',
  'queue',
  'signal',
  'branch',
  'commit',
  'worktree',
  'proposal',
  'gate',
  'ledger',
  'memory',
  'thread',
];

// ~16k lines in ## sections of 40, every line unique (a numbered prefix), within `maxBytes`.
export function corpusLines(maxBytes = 768 * 1024 - 4096, seed = 7): string[] {
  const rand = mulberry32(seed);
  const lines = ['# Corpus\n'];
  let bytes = lines[0].length;
  for (let n = 0; ; n++) {
    const line =
      n % 40 === 0
        ? `## Section ${n / 40}\n`
        : `${n}: ${Array.from({ length: 4 + Math.floor(rand() * 6) }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ')}\n`;
    const size = Buffer.byteLength(line);
    if (bytes + size > maxBytes) break;
    lines.push(line);
    bytes += size;
  }
  return lines;
}

export type Shape =
  | 'block move'
  | 'swapped halves'
  | 'scattered edits'
  | 'blanked thirds'
  | 'reversed sections'
  | 'every line rewritten';

export const SHAPES: readonly Shape[] = [
  'block move',
  'swapped halves',
  'scattered edits',
  'blanked thirds',
  'reversed sections',
  'every line rewritten',
];

export function reshape(lines: readonly string[], shape: Shape): string[] {
  const n = lines.length;
  switch (shape) {
    case 'block move': {
      const start = Math.floor(n / 3);
      const block = lines.slice(start, start + 2000);
      const rest = [...lines.slice(0, start), ...lines.slice(start + 2000)];
      return [
        ...rest.slice(0, rest.length - 100),
        ...block,
        ...rest.slice(rest.length - 100),
      ];
    }
    case 'swapped halves':
      return [
        ...lines.slice(Math.floor(n / 2)),
        ...lines.slice(0, Math.floor(n / 2)),
      ];
    case 'scattered edits':
      return lines.map((line, i) =>
        i % 8 === 3 ? line.replace('\n', ' edited\n') : line
      );
    case 'blanked thirds':
      return lines.map((line, i) => (i % 3 === 0 ? '\n' : line));
    case 'reversed sections': {
      const sections: string[][] = [];
      for (const line of lines) {
        if (line.startsWith('## ') || sections.length === 0)
          sections.push([line]);
        else sections[sections.length - 1].push(line);
      }
      return sections.reverse().flat();
    }
    case 'every line rewritten':
      return lines.map((line) => `x${line}`);
  }
}
