import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
  contrast,
  cssRule,
  hex,
  over,
  readCss,
  retiredNamesIn,
  sourceFiles,
  srcDir,
  THEMES,
  tintShare,
} from './contrast-helpers';

// The timeline in the Gr8r look (owner decision 2026-10-23,
// docs/architecture.md §8.2 and §8.4 "Timeline"), measured from tokens.css
// in both themes: every word on the bar tints and bands it sits on reads
// 4.5:1, and every mark the status depends on (bar edges, the leading
// StatusMark on its own bar, the due-date and Milestones-row diamonds,
// the today line, connectors, the selection ring, the dashed "missing"
// edges) holds 3:1 against what is next to it. The first test pins each
// job to the token measured below, so a sheet edit that swaps a token
// fails here instead of passing unmeasured.

const BAR = 'timeline/timeline-bar.module.css';
const CHART = 'timeline/timeline-chart.module.css';
const SCALE = 'timeline/timeline-scale.module.css';
const CARDS = 'timeline/timeline-cards.module.css';

describe('timeline sheets use the tokens measured below', () => {
  test('each job reads its token', () => {
    const uses: [string, string, string][] = [
      [BAR, '.bar', 'border: 1px solid var(--c)'],
      [
        BAR,
        '.bar',
        'background: color-mix(in srgb, var(--c) 16%, var(--surface))',
      ],
      [BAR, '.bar', 'color: var(--text)'],
      [BAR, '.on_track', '--c: var(--green)'],
      [BAR, '.at_risk', '--c: var(--amber)'],
      [BAR, '.overdue', '--c: var(--red)'],
      [BAR, '.done', '--c: var(--text-2)'],
      [
        BAR,
        '.done',
        'background: color-mix(in srgb, var(--c) 10%, var(--surface))',
      ],
      [BAR, '.done .label', 'color: var(--text-2)'],
      [BAR, '.missing', 'border: 1px dashed var(--text-3)'],
      [BAR, '.missing', 'background: var(--surface)'],
      [BAR, '.muted', '--c: var(--gray)'],
      [
        BAR,
        '.muted',
        'background: color-mix(in srgb, var(--c) 8%, var(--surface))',
      ],
      [BAR, '.muted', 'color: var(--text-2)'],
      [BAR, '.muted .missingLine', 'color: var(--text-3)'],
      [BAR, '.progress', 'color: var(--text-2)'],
      [BAR, '.missingLine', 'color: var(--amber)'],
      [BAR, '.cue', 'color: var(--text-2)'],
      [BAR, '.tag', 'background: var(--surface-2)'],
      [BAR, '.tag', 'color: var(--text-2)'],
      [BAR, '.selected', 'border-color: var(--accent)'],
      [BAR, '.tip', 'background: var(--text)'],
      [BAR, '.tip', 'color: var(--text-inv)'],
      [
        BAR,
        '.tipNote',
        'color: color-mix(in srgb, var(--text-inv) 72%, transparent)',
      ],
      [BAR, '.outside', 'color: var(--text-2)'],
      [BAR, '.outsideMeta', 'color: var(--text-3)'],
      [BAR, '.d_done', '--c: var(--text)'],
      [BAR, '.d_missing', '--c: var(--text-3)'],
      [CHART, '.edge path', 'stroke: var(--text-3)'],
      [CHART, '.edgeRisk path', 'stroke: var(--amber)'],
      [CHART, '.edgeSelected path', 'stroke: var(--text)'],
      [CHART, '.chip', 'border: 1px dashed var(--text-3)'],
      [CHART, '.chipNote', 'color: var(--text-3)'],
      [CHART, '.laneSub, .laneEdges', 'color: var(--text-3)'],
      [CHART, '.groupRow .laneCell', 'background: var(--sunken)'],
      [CHART, '.groupLabel', 'color: var(--text)'],
      [CHART, '.groupCount', 'color: var(--text-3)'],
      [CHART, '.groupLink', 'color: var(--text-2)'],
      [CHART, '.summaryCount', 'color: var(--text-3)'],
      [CHART, '.pointLabel', 'color: var(--text)'],
      [CHART, '.pointMuted .pointLabel', 'color: var(--text-3)'],
      [CHART, '.m_done', '--c: var(--text)'],
      [CHART, '.legendLabel', 'color: var(--text-2)'],
      [CHART, '.live', 'color: var(--text-2)'],
      [CHART, '.liveError .liveKey', 'color: var(--red)'],
      [SCALE, '.tick', 'color: var(--text-3)'],
      [SCALE, '.weekend', 'background: var(--sunken)'],
      [SCALE, '.todayTick', 'color: var(--accent-ink)'],
      [SCALE, '.todayFlag', 'color: var(--accent-ink)'],
      [SCALE, '.todayFlag', 'background: var(--surface)'],
      [SCALE, '.todayLine', 'background: var(--accent)'],
      [CARDS, '.rowMeta', 'color: var(--text-3)'],
      [CARDS, '.rowDue', 'color: var(--text-2)'],
      [CARDS, '.rowTag', 'color: var(--text-2)'],
      [CARDS, '.cardSub', 'color: var(--text-3)'],
    ];
    expect(
      uses
        .filter(
          ([file, selector, use]) => !cssRule(file, selector).includes(use)
        )
        .map(([file, selector, use]) => `${file} ${selector}: ${use}`)
    ).toEqual([]);
  });
});

for (const [theme, t] of THEMES) {
  describe(`timeline contrast (${theme})`, () => {
    const token = (name: string): string => hex(t, name);
    const surface = token('--surface');
    const surface2 = token('--surface-2');
    const sunken = token('--sunken');
    const mix = (name: string, share: number) =>
      over(token(name), surface, share);

    /** Each bar's fill, as the sheet mixes it over the surface. */
    const fills: Record<string, string> = {
      overdue: mix('--red', 0.16),
      at_risk: mix('--amber', 0.16),
      on_track: mix('--green', 0.16),
      done: mix('--text-2', 0.1),
      muted: mix('--gray', 0.08),
      missing: surface,
      'missing:hover': surface2,
    };
    /** Each bar's edge (and its leading StatusMark's hue). */
    const edges: Record<string, string> = {
      overdue: token('--red'),
      at_risk: token('--amber'),
      on_track: token('--green'),
      done: token('--text-2'),
      muted: token('--gray'),
      missing: token('--text-3'),
    };

    /** Every pair under `min`, as "fg on bg: ratio". */
    function below(min: number, pairs: [string, string, string][]): string[] {
      return pairs
        .filter(([, fg, bg]) => contrast(fg, bg) < min)
        .map(
          ([name, fg, bg]) =>
            `${name}: ${fg} on ${bg} ${contrast(fg, bg).toFixed(2)}`
        );
    }

    test('words on every bar fill are 4.5:1', () => {
      const pairs: [string, string, string][] = [];
      for (const [bar, fill] of Object.entries(fills)) {
        pairs.push([`${bar} label`, token('--text'), fill]);
        pairs.push([`${bar} receipts`, token('--text-2'), fill]);
      }
      // The "Missing: …" line sits on any bar that carries it (an at-risk
      // bar missing "done means…", a missing-input bar on the surface);
      // an inactive lane's is --text-3.
      for (const bar of ['overdue', 'at_risk', 'on_track', 'done', 'missing']) {
        pairs.push([`${bar} missing line`, token('--amber'), fills[bar] ?? '']);
      }
      pairs.push(['missing line on hover', token('--amber'), surface2]);
      pairs.push(['muted missing line', token('--text-3'), fills.muted ?? '']);
      // The tag pill's words on its own fill.
      pairs.push(['tag', token('--text-2'), surface2]);
      expect(below(4.5, pairs)).toEqual([]);
    });

    test('bar edges, marks and diamonds are 3:1', () => {
      const pairs: [string, string, string][] = [];
      for (const [bar, edge] of Object.entries(edges)) {
        // The edge against the lane row and the sunken weekend band
        // behind it, and the leading mark against its own bar's fill.
        pairs.push([`${bar} edge on surface`, edge, surface]);
        pairs.push([`${bar} edge on a weekend`, edge, sunken]);
        pairs.push([`${bar} mark on its bar`, edge, fills[bar] ?? '']);
      }
      // Complete bars lead with StatusMark's --text diamond.
      pairs.push(['done mark on its bar', token('--text'), fills.done ?? '']);
      // The due-date and Milestones-row diamonds, on the lane and on a
      // weekend band.
      for (const hue of [
        '--red',
        '--amber',
        '--green',
        '--text',
        '--text-3',
        '--gray',
      ]) {
        pairs.push([`${hue} diamond`, token(hue), surface]);
        pairs.push([`${hue} diamond on a weekend`, token(hue), sunken]);
      }
      expect(below(3, pairs)).toEqual([]);
    });

    test('the today line, connectors, rings and dashed edges are 3:1', () => {
      const pairs: [string, string, string][] = [
        ['today line', token('--accent'), surface],
        ['today line on a weekend', token('--accent'), sunken],
        ['connector', token('--text-3'), surface],
        ['connector on a weekend', token('--text-3'), sunken],
        ['risk connector', token('--amber'), surface],
        ['risk connector on a weekend', token('--amber'), sunken],
        ['open bar ring', token('--accent'), surface],
        ['undated chip edge', token('--text-3'), surface],
        ['phone selected-row bar', token('--accent'), surface],
      ];
      expect(below(3, pairs)).toEqual([]);
    });

    test('the header, lane column, chips, cards and tip read 4.5:1', () => {
      const accentSoft = over(
        token('--accent'),
        surface,
        tintShare(t, '--accent-soft')
      );
      const inv = token('--text-inv');
      const ink = token('--text');
      const pairs: [string, string, string][] = [
        ['month name', ink, surface],
        ['day number', token('--text-3'), surface],
        ['weekend day number', token('--text-3'), sunken],
        ["today's number", token('--accent-ink'), surface],
        ["today's number on a weekend", token('--accent-ink'), sunken],
        ['"Today" in the month row', token('--accent-ink'), surface],
        ['lane name', ink, surface],
        ['lane lead', token('--text-3'), surface],
        ['"No lead" (warning ink)', token('--amber'), surface],
        ['initiative name', ink, sunken],
        ['initiative count', token('--text-3'), sunken],
        ['initiative link', token('--text-2'), sunken],
        ['milestones row label', ink, surface],
        ['inactive milestones row label', token('--text-3'), surface],
        ['undated chip name', ink, surface],
        ['undated "No date" (warning ink)', token('--amber'), surface],
        ['legend label', token('--text-2'), surface],
        ['save error lead-in', token('--red'), surface],
        ['card receipts', token('--text-3'), surface],
        ['card receipts on hover', token('--text-3'), surface2],
        ['card receipts, selected', token('--text-3'), accentSoft],
        ['card status word (danger)', token('--red'), accentSoft],
        ['card status word (warning)', token('--amber'), accentSoft],
        ['card due date', token('--text-2'), surface],
        ['card tag', token('--text-2'), surface2],
        ['drag tip', inv, ink],
        ['drag tip note', over(inv, ink, 0.72), ink],
      ];
      expect(below(4.5, pairs)).toEqual([]);
    });
  });
}

// Contract §9: rotated marks have 2px edges, since Chrome draws a 1.5px
// border at 1px (at every pixel ratio) and the mark would look thinner
// than the 2px StatusMark and due-date diamonds it stands for: the
// legend's "Due date" diamond and the "Milestones" row glyph included.
describe('rotated marks keep 2px edges', () => {
  test('no turned diamond in the timeline sheets has a 1.5px edge', () => {
    const offenders: string[] = [];
    for (const file of [BAR, CHART, SCALE, CARDS]) {
      const sheet = readCss(file).replace(/\s+/g, ' ');
      for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = match[2] ?? '';
        if (!body.includes('rotate(45deg)')) continue;
        if (/border: 1\.5px/.test(body)) {
          offenders.push(`${file}: ${(match[1] ?? '').trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(cssRule(CHART, '.legendDiamond::after')).toContain(
      'border: 2px solid var(--text-3);'
    );
    expect(cssRule(CHART, '.summaryGlyph')).toContain(
      'border: 2px solid var(--text-3);'
    );
  });
});

describe('the timeline sheets are migrated', () => {
  test('no timeline file reads a retired (pre-Gr8r) token name', () => {
    expect(retiredNamesIn(sourceFiles(path.join(srcDir, 'timeline')))).toEqual(
      []
    );
  });
});
