import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
  contrast,
  hex,
  over,
  readCss,
  retiredNamesIn,
  sourceFiles,
  srcDir,
  THEMES,
  tintShare,
} from './contrast-helpers';

// The dependency graph in the Gr8r look (owner decision 2026-10-23;
// architecture §8.2 "Status colours", §8.4 Graph): Gr8r cards on a
// recessed canvas (--sunken), tinted for overdue (--red-soft) and for the
// selection and the box being read (--accent-soft), soft rounded frames in
// --control-border, thin connectors, accent and --text rings. Every line,
// ring, frame and mark is 3:1 against what it sits on and every word
// 4.5:1, in both themes, read from the tokens the graph's stylesheets
// actually use; no graph file reads a retired (pre-Gr8r) token name.
describe('graph marks meet WCAG in both themes', () => {
  const graphCss = readCss('graph/dependency-graph.module.css').replace(
    /\s+/g,
    ' '
  );

  /** The declarations of the first rule whose whole selector is exactly
      `selector` (not a rule whose list merely ends with it). */
  function graphRule(selector: string): string {
    // A leading "} " lets the sheet's first rule match like the rest.
    const sheet = `} ${graphCss.trim()}`;
    const at = sheet.indexOf(`} ${selector} {`);
    expect([selector, at >= 0]).toEqual([selector, true]);
    const open = sheet.indexOf('{', at + 1);
    return sheet.slice(open + 1, sheet.indexOf('}', open));
  }

  test('each job uses the token measured below', () => {
    const uses: [string, string][] = [
      // The panel, its canvas and the cards on it.
      ['.graph', 'background: var(--surface)'],
      ['.viewport', 'background: var(--sunken)'],
      ['.node', 'background: var(--surface)'],
      ['.node', 'color: var(--text)'],
      ['.sublabel', 'color: var(--text-3)'],
      // Edges: blocking lines, receding ones, unblocked dots.
      ['.edge', 'color: var(--text-2)'],
      ['.edgeResolved', 'color: var(--text-3)'],
      [":where(.graph[data-highlight='status']) .edgeResolved", 'var(--green)'],
      [
        ".edge.dim:is(.edgeDefault, .edgeCross), :where(.graph:not([data-highlight='risk'])) .edge.dim.edgeRisk",
        'color: var(--text-3)',
      ],
      [
        ".edge.lit:is(.edgeDefault, .edgeCross), :where(.graph:not([data-highlight='risk'])) .edge.lit.edgeRisk",
        'color: var(--accent)',
      ],
      [
        ".edge.lit:is(.edgeDefault, .edgeCross), :where(.graph:not([data-highlight='risk'])) .edge.lit.edgeRisk",
        '--edge-ink: var(--accent-ink)',
      ],
      ['.edge.chain:is(.edgeDefault, .edgeCross, .edgeRisk)', 'var(--text)'],
      ['.weight rect', 'fill: var(--surface)'],
      // Rings: --text, the accent for what the box waits on and itself.
      [
        '.node.lit:not(:focus-visible), .node.down:not(:focus-visible), .node.chain:not(:focus-visible), .node.active:not(.selected, :focus-visible)',
        'outline: 2px solid var(--text)',
      ],
      [
        '.node.lit:not(:focus-visible), .node.active:not(.selected, :focus-visible)',
        'outline-color: var(--accent)',
      ],
      ['.focus::after', 'border: 2px solid var(--accent)'],
      // Tints: the overdue box, the selection, the box being read.
      ['.node.overdueNode', 'var(--red-soft)'],
      ['.node.selected', 'var(--accent-soft)'],
      ['.node.selected', 'border: 2px solid var(--accent)'],
      ['.node.pointed:not(.selected, .overdueNode)', 'var(--accent-soft)'],
      // Receding words.
      ['.node.dim > .text > :is(.label, .sublabel)', 'color: var(--text-3)'],
      ['.toneMuted > .text > .label', 'color: var(--text-3)'],
      // Tone edges and outside boxes.
      ['.toned', 'var(--tone)'],
      ['.toneEdge', 'border-color: var(--tone)'],
      [
        '.external:not(.toned, .toneEdge, .overdueNode)',
        'border-color: var(--control-border)',
      ],
      // The pill and the step disc.
      ['.next', 'background: var(--surface)'],
      ['.next', 'color: var(--text)'],
      ['.next::before', 'background: var(--green)'],
      ['.step', 'background: var(--text)'],
      ['.step', 'color: var(--text-inv)'],
      // The readout row.
      ['.readout', 'color: var(--text-2)'],
      ['.readoutHint', 'color: var(--text-3)'],
      // Frames and their titles, each title on a patch of the canvas.
      ['.cluster', 'border: 1px solid var(--control-border)'],
      ['.clusterMuted', 'border-color: var(--gray)'],
      ['.clusterTitle', 'color: var(--text-3)'],
      ['.clusterTitle', 'background: var(--sunken)'],
      ['.clusterTitleTop', 'color: var(--text-2)'],
      ['.clusterTitleMuted', 'color: var(--text-3)'],
      // The diamonds' hues.
      ['.node', '--glyph-open: var(--text-2)'],
      ['.node', '--glyph-quiet: var(--text-3)'],
      ['.toneMuted', '--glyph-red: var(--gray)'],
      // A tinted chip on a tinted box sits on the card's surface.
      [
        ':is(.overdueNode, .selected, .pointed) > .text > .tags [data-filled]',
        'var(--surface)',
      ],
      // The lock: its corner ticks, the floating strip and its buttons,
      // the readout's lead-in.
      ['.lockMark', 'color: var(--accent)'],
      ['.lockMark', 'border: 2px solid currentcolor'],
      ['.lockStrip', 'background: var(--surface)'],
      ['.lockButton, .readoutAction', 'background: var(--surface)'],
      ['.lockButton, .readoutAction', 'color: var(--text)'],
      [
        '.lockButton.actionOpen, .readoutAction.actionOpen',
        'background: var(--accent)',
      ],
      [
        '.lockButton.actionOpen, .readoutAction.actionOpen',
        'color: var(--on-accent)',
      ],
      ['.lockClose', 'color: var(--text-2)'],
      ['.readoutLocked', 'color: var(--accent-ink)'],
    ];
    expect(
      uses
        .filter(([selector, use]) => !graphRule(selector).includes(use))
        .map(([selector, use]) => `${selector}: ${use}`)
    ).toEqual([]);
  });

  test('no graph file reads a retired token name', () => {
    expect(retiredNamesIn(sourceFiles(path.join(srcDir, 'graph')))).toEqual([]);
  });

  for (const [theme, t] of THEMES) {
    const token = (name: string): string => hex(t, name);
    const canvas = token('--sunken');
    const surface = token('--surface');
    /** A `color-mix(var(--hue) N%, transparent)` tint laid over the card. */
    const tint = (name: string, hue: string, base = surface) =>
      over(token(hue), base, tintShare(t, name));
    const overdueBox = tint('--red-soft', '--red');
    const accentBox = tint('--accent-soft', '--accent');

    test(`${theme}: lines, rings, edges and frames are 3:1 on the canvas`, () => {
      const pairs = [
        // Blocking lines, receding lines and dots, the --text rings.
        '--text-2',
        '--text-3',
        '--text',
        // Unblocked dots, the ready edge; blocked and stuck edges, risk
        // chains, cycles.
        '--green',
        '--amber',
        '--red',
        // The upstream ring and lines, the selection edge, a chain's focus.
        '--accent',
        // Frames, outside boxes' dashes, a paused frame.
        '--control-border',
        '--gray',
      ].map((name) => ({ name, ratio: contrast(token(name), canvas) }));
      expect(
        pairs.filter(({ ratio }) => !(ratio >= 3)).map(({ name }) => name)
      ).toEqual([]);
    });

    test(`${theme}: tone edges are 3:1 against the card they edge too`, () => {
      // The 2px edge sits between the canvas and the card: it reads
      // against both (the canvas side above).
      const pairs = ['--green', '--amber', '--red', '--accent'].map((name) => ({
        name,
        ratio: contrast(token(name), surface),
      }));
      expect(
        pairs.filter(({ ratio }) => !(ratio >= 3)).map(({ name }) => name)
      ).toEqual([]);
    });

    test(`${theme}: the diamonds are 3:1 on every card fill`, () => {
      const fills: [string, string][] = [
        ['card', surface],
        ['overdue tint', overdueBox],
        ['accent tint', accentBox],
      ];
      const marks = ['--text', '--text-2', '--text-3', '--green', '--amber'];
      const failing = fills.flatMap(([where, fill]) =>
        [...marks, '--red', '--gray']
          .filter((name) => !(contrast(token(name), fill) >= 3))
          .map((name) => `${name} on ${where}`)
      );
      expect(failing).toEqual([]);
    });

    test(`${theme}: the lock's corner ticks are 3:1 on every box they mark`, () => {
      // The locked box is the box being read (the accent tint), a selected
      // one keeps the same tint, and an overdue one its red tint; the
      // ticks are the accent on all three, and on a plain card while a
      // walked step lights over the lock.
      const fills: [string, string][] = [
        ['card', surface],
        ['accent tint', accentBox],
        ['overdue tint', overdueBox],
      ];
      expect(
        fills
          .filter(([, fill]) => !(contrast(token('--accent'), fill) >= 3))
          .map(([where]) => where)
      ).toEqual([]);
    });

    test(`${theme}: the upstream and downstream rings are 3:1 apart`, () => {
      expect(
        contrast(token('--accent'), token('--text'))
      ).toBeGreaterThanOrEqual(3);
    });

    test(`${theme}: the graph's words are 4.5:1 where they sit`, () => {
      const pairs: [string, string, string][] = [
        // Titles and lines on the card, on the overdue tint, on the accent
        // tint (selected, being read); receding and quiet words in
        // --text-3 on the same.
        ['title', token('--text'), surface],
        ['title on the overdue tint', token('--text'), overdueBox],
        ['title on the accent tint', token('--text'), accentBox],
        ['line', token('--text-3'), surface],
        ['line on the overdue tint', token('--text-3'), overdueBox],
        ['line on the accent tint', token('--text-3'), accentBox],
        // Chips on a tinted box: a tinted chip is laid over the card's
        // surface there (its own tint over --surface, as on any card); the
        // dot pill and the neutral badge are opaque (their own fills,
        // checked with the Chip atom).
        [
          'Unassigned on a tinted box',
          token('--amber'),
          tint('--amber-soft', '--amber'),
        ],
        ['Cycle on a tinted box', token('--red'), tint('--red-soft', '--red')],
        // "Ready next" and the step digits.
        ['pill', token('--text'), surface],
        ['step', token('--text-inv'), token('--text')],
        // The count on an edge, in each edge's ink.
        ['count', token('--text-2'), surface],
        ['receding count', token('--text-3'), surface],
        ['lit count', token('--accent-ink'), surface],
        ['risk count', token('--amber'), surface],
        ['cycle count', token('--red'), surface],
        ['unblocked count', token('--green'), surface],
        // The readout row and its hint.
        ['readout', token('--text-2'), surface],
        ['readout hint', token('--text-3'), surface],
        // Frame titles on their canvas patch: top-level, nested, muted.
        ['top frame title', token('--text-2'), canvas],
        ['nested frame title', token('--text-3'), canvas],
        // The toolbar's quiet hint and zoom figures.
        ['hint', token('--text-3'), surface],
        ['zoom', token('--text-2'), surface],
        // The lock strip's buttons, at rest and hovered, and the readout's
        // "Locked on" lead-in and quiet Unlock.
        ['Open', token('--on-accent'), token('--accent')],
        ['Open graph', token('--text'), surface],
        ['Open graph hovered', token('--text'), token('--surface-2')],
        ['Unlock', token('--text-2'), surface],
        ['Unlock hovered', token('--text'), token('--surface-2')],
        ['Locked on', token('--accent-ink'), surface],
      ];
      expect(
        pairs
          .filter(([, fg, bg]) => !(contrast(fg, bg) >= 4.5))
          .map(([label, fg, bg]) => `${label} ${contrast(fg, bg).toFixed(2)}`)
      ).toEqual([]);
    });
  }
});
