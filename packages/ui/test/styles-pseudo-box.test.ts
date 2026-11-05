import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The page-mode reset's `box-sizing: border-box` (tokens.css) reaches
// elements, not their ::before and ::after: a universal pseudo-element rule
// made each style recalculation resolve both pseudo-elements of every
// element (15 to 20 per cent of that time in a theme switch or a scroll on
// a 2,000-task list). A pseudo-element whose drawn size depends on box-sizing,
// one given a width or height and a border or padding, therefore sets its own
// box-sizing in its module; one sized by `inset` or left `auto` does not need
// to. This scan holds both halves.

const SRC = path.join(import.meta.dir, '..', 'src');

/** Every .css file under src/, relative to it. */
function sheets(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.css'))
    .sort();
}

/** Every innermost rule of `css` (an @media block's rules, not the block),
    comments stripped, as its selector list and its declarations. */
function rulesOf(css: string): { selectors: string[]; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: (m[1] ?? '')
      .split(/,(?![^(]*\))/)
      .map((s) => s.trim().replace(/\s+/g, ' ')),
    body: m[2] ?? '',
  }));
}

const PSEUDO = /::?(before|after)$/;
const SIZE =
  /(?:^|[\s;])(?:min-|max-)?(?:width|height|inline-size|block-size)\s*:/;
// A border or padding with a width: `border: solid <colour>` alone is a
// medium (3px) border, so only a zero or `none` value is left out.
const EDGE =
  /(?:^|[\s;])(?:padding|border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-width)?)\s*:\s*(?!0(?:px)?\s*(?:;|$)|none\s*(?:;|$))[^;]+/;
const BOX_SIZING = /(?:^|[\s;])box-sizing\s*:/;

/** The pseudo-element a selector draws, keyed by the last class of its last
    compound and the pseudo: `.muted .mark::before` and `.mark::before` are
    both `.mark::before`, so a size in one rule and a border in another
    (a tone's ring) count as one box. */
function pseudoKey(selector: string): string | null {
  const pseudo = PSEUDO.exec(selector);
  if (pseudo === null) return null;
  const last = selector.split(/[\s>+~]+/).pop() ?? '';
  const classes = last.match(/\.[\w-]+/g);
  return `${classes?.[0] ?? last.replace(PSEUDO, '')}::${pseudo[1]}`;
}

interface PseudoBox {
  sized: boolean;
  edged: boolean;
  boxSizing: boolean;
}

/** Per sheet, each pseudo-element's declarations folded over every rule
    that draws it (states, tones and media queries included). */
function pseudoBoxes(): Map<string, PseudoBox> {
  const boxes = new Map<string, PseudoBox>();
  for (const file of sheets()) {
    for (const { selectors, body } of rulesOf(
      readFileSync(path.join(SRC, file), 'utf8')
    )) {
      for (const selector of selectors) {
        const key = pseudoKey(selector);
        if (key === null) continue;
        const id = `${file} ${key}`;
        const box = boxes.get(id) ?? {
          sized: false,
          edged: false,
          boxSizing: false,
        };
        box.sized ||= SIZE.test(body);
        box.edged ||= EDGE.test(body);
        box.boxSizing ||= BOX_SIZING.test(body);
        boxes.set(id, box);
      }
    }
  }
  return boxes;
}

describe('pseudo-element box sizing', () => {
  test('the reset reaches elements, not every ::before or ::after', () => {
    const universal = sheets().flatMap((file) =>
      rulesOf(readFileSync(path.join(SRC, file), 'utf8'))
        .flatMap(({ selectors }) => selectors)
        .filter((s) => /(?:^|[\s>+~])\*?::?(?:before|after)$/.test(s))
        .map((s) => `${file}: ${s}`)
    );
    expect(universal).toEqual([]);
  });

  test('every sized pseudo-element with a border or padding sets its own box-sizing', () => {
    const boxes = pseudoBoxes();
    const dependent = [...boxes].filter(([, b]) => b.sized && b.edged);
    // The scan finds the boxes it is about (the done ticks, the activity
    // ring, the Mermaid gutter, the timeline legend's diamond).
    expect(dependent.map(([id]) => id)).toEqual(
      expect.arrayContaining([
        'components/status-mark.module.css .done::after',
        'graph/mermaid-source.module.css .line::before',
        'task/task-activity-list.module.css .mark::before',
        'tasks/checklist.module.css .mark::after',
        'timeline/timeline-chart.module.css .legendDiamond::after',
      ])
    );
    expect(dependent.filter(([, b]) => !b.boxSizing).map(([id]) => id)).toEqual(
      []
    );
  });
});
