import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  TimelineChart,
  type TimelineChartProps,
  type TimelineGroup,
} from '../src/index';
import {
  barDueTone,
  laneSublabelTone,
  receiptsTone,
  undatedTone,
} from '../src/timeline/tones';

// Status colours on the timeline (owner decision 2026-10-22,
// docs/architecture.md §8.2 "Status colours"), rendered the Gr8r way
// (owner decision 2026-10-23): bars are tinted with their status hue and
// outlined in the full hue (red overdue, amber at risk, green on track,
// the neutral --text-2 for complete, grey inactive), a missing input is a
// dashed --text-3 outline, the due-date and Milestones-row diamonds take
// StatusMark's shapes (overdue solid, at risk half filled, on track
// hollow, complete solid neutral with a tick, missing dotted, inactive a
// grey outline), and the legend is StatusMark itself. The purple accent
// stays for today, selection, focus and the drag grip only. CSS modules
// resolve to empty objects under Bun, so the colours are checked in the
// stylesheets and the components through their data-tone.

afterEach(cleanup);

const srcDir = path.join(import.meta.dir, '..', 'src');

/** A stylesheet under src, comments removed and whitespace collapsed. */
function css(file: string): string {
  return readFileSync(path.join(srcDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
}

/** The declarations of the first rule whose selector is exactly
    `selector` (the whole selector list, not a part of a longer one). */
function rule(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[{}]) ?${escaped} \\{`).exec(sheet);
  expect([selector, match !== null]).toEqual([selector, true]);
  const open = sheet.indexOf('{', (match?.index ?? 0) + 1);
  return sheet.slice(open + 1, sheet.indexOf('}', open)).trim();
}

describe('bars and diamonds (timeline-bar.module.css)', () => {
  const sheet = css('timeline/timeline-bar.module.css');

  test('a bar is its hue at 16% over the surface, edged in the full hue', () => {
    const bar = rule(sheet, '.bar');
    expect(bar).toContain('--c: var(--gray)');
    expect(bar).toContain('border: 1px solid var(--c)');
    expect(bar).toContain(
      'background: color-mix(in srgb, var(--c) 16%, var(--surface))'
    );
    expect(bar).toContain('border-radius: var(--r-sm)');
    expect(bar).toContain('color: var(--text)');
  });

  test('each status takes its hue; complete stays neutral, never green', () => {
    expect(rule(sheet, '.on_track')).toBe('--c: var(--green);');
    expect(rule(sheet, '.at_risk')).toBe('--c: var(--amber);');
    expect(rule(sheet, '.overdue')).toBe('--c: var(--red);');
    // Done is the neutral grey: a green bar has the red one's lightness,
    // so without red-green vision the two would read the same.
    const done = rule(sheet, '.done');
    expect(done).toContain('--c: var(--text-2)');
    expect(done).toContain('10%');
    expect(rule(sheet, '.done .label')).toBe('color: var(--text-2);');
    // Missing input: a dashed --text-3 outline on the plain surface.
    const missing = rule(sheet, '.missing');
    expect(missing).toContain('border: 1px dashed var(--text-3)');
    expect(missing).toContain('background: var(--surface)');
    // An inactive lane: the inactive mark grey, a lighter 8% fill, no hue
    // in its words.
    const muted = rule(sheet, '.muted');
    expect(muted).toContain('--c: var(--gray)');
    expect(muted).toContain('8%');
    expect(rule(sheet, '.muted .missingLine')).toBe('color: var(--text-3);');
  });

  test('opacity never carries the status, and no bar is a flood', () => {
    // Gr8r fades a done bar to 60%; a faded label falls under 4.5:1, so
    // the bar steps back by colour instead.
    for (const selector of ['.bar', '.content', '.done', '.label']) {
      expect([selector, rule(sheet, selector)]).not.toEqual([
        selector,
        expect.stringContaining('opacity'),
      ]);
    }
    expect(sheet).not.toContain('.done .content { opacity');
    expect(sheet).not.toContain('repeating-linear-gradient');
  });

  test('the missing input is named in the warning text', () => {
    expect(rule(sheet, '.missingLine')).toContain('color: var(--amber)');
    expect(rule(sheet, '.progress')).toBe('color: var(--text-2);');
  });

  test('the due-date diamond repeats StatusMark’s shapes', () => {
    const diamond = rule(sheet, '.diamond');
    expect(diamond).toContain('border: 2px solid var(--c)');
    expect(diamond).toContain('background: var(--c)');
    expect(diamond).toContain('transform: rotate(45deg)');
    expect(rule(sheet, '.d_done')).toBe('--c: var(--text);');
    expect(rule(sheet, '.d_done::after')).toContain(
      'border: solid var(--hollow)'
    );
    expect(rule(sheet, '.d_on_track')).toContain('--c: var(--green)');
    expect(rule(sheet, '.d_overdue')).toBe('--c: var(--red);');
    expect(rule(sheet, '.d_at_risk')).toContain('--c: var(--amber)');
    expect(rule(sheet, '.d_at_risk')).toContain(
      'linear-gradient(135deg, var(--hollow) 50%, var(--c) 50%)'
    );
    expect(rule(sheet, '.d_missing')).toContain('border-style: dotted');
    expect(rule(sheet, '.d_muted')).toContain('--c: var(--gray)');
  });

  test('no status rule uses the purple accent', () => {
    for (const selector of [
      '.on_track',
      '.at_risk',
      '.overdue',
      '.done',
      '.missing',
      '.missingLine',
      '.muted',
      '.d_done',
      '.d_on_track',
      '.d_at_risk',
      '.d_overdue',
      '.d_missing',
      '.d_muted',
    ]) {
      expect([selector, rule(sheet, selector)]).not.toEqual([
        selector,
        expect.stringContaining('accent'),
      ]);
    }
  });

  test('the open bar takes the accent ring; forced colours keep shapes', () => {
    expect(rule(sheet, '.selected')).toContain('border-color: var(--accent)');
    const at = sheet.indexOf('@media (forced-colors: active) { .diamond');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(sheet.slice(at)).toContain('--c: CanvasText; --hollow: Canvas;');
    expect(sheet).toContain(
      '@media (forced-colors: active) { .selected { outline: 2px solid Highlight;'
    );
  });
});

describe('chart furniture (timeline-chart.module.css)', () => {
  const sheet = css('timeline/timeline-chart.module.css');

  test('the chart is one Gr8r panel', () => {
    const scroller = rule(sheet, '.scroller');
    expect(scroller).toContain('border: 1px solid var(--border)');
    expect(scroller).toContain('border-radius: var(--r-lg)');
    expect(scroller).toContain('background: var(--surface)');
    expect(rule(sheet, '.groupRow .laneCell')).toContain(
      'background: var(--sunken)'
    );
  });

  test('the milestones row marks take the diamonds’ hues and shapes', () => {
    expect(rule(sheet, '.m_on_track')).toContain('--c: var(--green)');
    expect(rule(sheet, '.m_done')).toBe('--c: var(--text);');
    expect(rule(sheet, '.m_at_risk')).toContain(
      'linear-gradient(135deg, var(--hollow) 50%, var(--c) 50%)'
    );
    expect(rule(sheet, '.m_overdue')).toBe('--c: var(--red);');
    expect(rule(sheet, '.m_missing')).toContain('border-style: dotted');
    expect(rule(sheet, '.m_muted')).toContain('--c: var(--gray)');
  });

  test('risk chains are amber, "No lead" and "No date" use the tone hook', () => {
    expect(rule(sheet, '.edgeRisk path')).toBe('stroke: var(--amber);');
    expect(rule(sheet, '.edgeSelected.edgeRisk path')).toBe(
      'stroke: var(--amber);'
    );
    expect(rule(sheet, '.edge path')).toContain('stroke: var(--text-3)');
    expect(rule(sheet, '.laneSubToned')).toContain('color: var(--tone-ink)');
    expect(rule(sheet, '.chipNoteToned')).toBe('color: var(--tone-ink);');
    // An undated chip is the dashed "missing" edge.
    expect(rule(sheet, '.chip')).toContain('border: 1px dashed var(--text-3)');
  });

  test('a save error is red', () => {
    expect(rule(sheet, '.liveError .liveKey')).toBe('color: var(--red);');
  });

  test('today stays the purple accent', () => {
    const scale = css('timeline/timeline-scale.module.css');
    expect(rule(scale, '.todayLine')).toContain('background: var(--accent)');
    expect(rule(scale, '.todayLine')).toContain('width: 2px');
    expect(rule(scale, '.todayLine')).not.toContain('opacity');
    // Today's number and the "Today" word: the accent ink at 600, no fill.
    expect(rule(scale, '.todayTick')).toContain('color: var(--accent-ink)');
    expect(rule(scale, '.todayFlag')).toContain('color: var(--accent-ink)');
    expect(rule(scale, '.todayFlag')).toContain('background: var(--surface)');
  });
});

describe('phone cards (timeline-cards.module.css)', () => {
  const sheet = css('timeline/timeline-cards.module.css');

  test('status words take their tone’s text colour', () => {
    expect(rule(sheet, '.cardSubToned')).toContain('color: var(--tone-ink)');
    expect(rule(sheet, '.rowMetaToned .rowStatus')).toContain(
      'color: var(--tone-ink)'
    );
    expect(rule(sheet, '.rowDueToned')).toContain('color: var(--tone-ink)');
  });

  test('a card is a Gr8r panel and the open row has the accent bar', () => {
    expect(rule(sheet, '.card')).toContain('border-radius: var(--r-lg)');
    expect(rule(sheet, '.rowSelected, .rowSelected:hover')).toContain(
      'box-shadow: inset 2px 0 0 var(--accent)'
    );
  });
});

describe('tone helpers (timeline/tones.ts)', () => {
  test('a sublabel is coloured only by a status tone on an active lane', () => {
    expect(laneSublabelTone({ sublabelTone: 'warning' })).toBe('warning');
    expect(
      laneSublabelTone({ sublabelTone: 'warning', muted: true })
    ).toBeUndefined();
    expect(laneSublabelTone({ sublabelTone: 'default' })).toBeUndefined();
    expect(laneSublabelTone({ sublabelTone: 'muted' })).toBeUndefined();
    expect(laneSublabelTone({})).toBeUndefined();
  });

  test('receipts: overdue danger, at risk or missing warning, else plain', () => {
    expect(receiptsTone({ status: 'overdue' }, true)).toBe('danger');
    expect(receiptsTone({ status: 'at_risk' }, true)).toBe('warning');
    expect(receiptsTone({ status: 'missing' }, true)).toBe('warning');
    expect(
      receiptsTone({ status: 'on_track', missing: 'Missing: lead' }, true)
    ).toBe('warning');
    expect(receiptsTone({ status: 'on_track' }, true)).toBe('default');
    expect(receiptsTone({ status: 'done' }, true)).toBe('default');
    expect(receiptsTone({ status: 'overdue' }, false)).toBe('default');
  });

  test('due dates: overdue danger; "No date" warning; never on a quiet lane', () => {
    expect(barDueTone({ status: 'overdue' }, true)).toBe('danger');
    expect(barDueTone({ status: 'at_risk' }, true)).toBe('default');
    expect(barDueTone({ status: 'overdue' }, false)).toBe('default');
    expect(undatedTone(true)).toBe('warning');
    expect(undatedTone(false)).toBe('default');
  });
});

const GROUPS: TimelineGroup[] = [
  {
    id: 'g',
    label: 'Platform',
    lanes: [
      {
        id: 'p-live',
        label: 'Ledger API',
        sublabel: 'No lead',
        sublabelTone: 'warning',
        bars: [
          {
            id: 'm-risk',
            label: 'Public beta',
            start: '2026-10-01',
            end: '2026-10-25',
            status: 'at_risk',
            statusLabel: 'At risk',
            progressLabel: '0/3',
          },
          {
            id: 'm-track',
            label: 'General availability',
            start: '2026-10-25',
            end: '2026-11-20',
            status: 'on_track',
            statusLabel: 'On track',
          },
        ],
        undated: [
          {
            id: 'm-undated',
            label: 'Pricing page',
            status: 'missing',
            statusLabel: 'No target date',
          },
        ],
      },
      {
        id: 'p-paused',
        label: 'Fjord analytics',
        sublabel: 'No lead',
        // An inactive lane never colours its sublabel, whatever it asks.
        sublabelTone: 'warning',
        muted: true,
        bars: [],
        undated: [
          {
            id: 'm-paused',
            label: 'Dashboards',
            status: 'missing',
            statusLabel: 'No target date',
          },
        ],
      },
    ],
  },
];

function renderChart(overrides: Partial<TimelineChartProps> = {}) {
  const props: TimelineChartProps = {
    today: '2026-10-21',
    windowStart: '2026-09-21',
    windowEnd: '2027-01-17',
    zoom: 'weeks',
    groups: GROUPS,
    onOpenBar: () => {},
    ...overrides,
  };
  return render(<TimelineChart {...props} />);
}

describe('the chart emits its tones', () => {
  test('"No lead" is a warning on an active lane and quiet on an inactive one', () => {
    const { container } = renderChart();
    const live = container.querySelector(
      '[role="group"][data-lane-id="p-live"]'
    );
    const paused = container.querySelector(
      '[role="group"][data-lane-id="p-paused"]'
    );
    // The innermost span that says it (its line wrapper says it too).
    const sub = (lane: Element | null) =>
      [...(lane?.querySelectorAll('span') ?? [])].find(
        (el) => el.textContent === 'No lead' && el.children.length === 0
      );
    expect(sub(live)?.getAttribute('data-tone')).toBe('warning');
    expect(sub(paused)?.hasAttribute('data-tone')).toBe(false);
  });

  test('an undated chip says "No date" as a warning, quietly when inactive', () => {
    const { container } = renderChart();
    const note = (lane: string) =>
      [
        ...container.querySelectorAll(
          `[role="group"][data-lane-id="${lane}"] button span`
        ),
      ].find((el) => el.textContent === 'No date');
    expect(note('p-live')?.getAttribute('data-tone')).toBe('warning');
    expect(note('p-paused')?.getAttribute('data-tone')).toBe('default');
  });

  test('the phone cards colour receipts and dates by status', () => {
    const { container } = renderChart();
    const card = container.querySelector('article[data-lane-id="p-live"]');
    if (card === null) throw new Error('no card');
    const tones = [...card.querySelectorAll('button [data-tone]')].map((el) => [
      el.textContent,
      el.getAttribute('data-tone'),
    ]);
    // Receipts then due date per row; the undated row's "No date" is a
    // warning (its target date is a missing input).
    expect(tones).toEqual([
      ['At risk · 0/3', 'warning'],
      ['Oct 25', 'default'],
      ['On track', 'default'],
      ['Nov 20', 'default'],
      ['No date', 'warning'],
    ]);
    const sub = card.querySelector('header [data-tone]');
    expect(sub?.textContent).toBe('No lead');
    expect(sub?.getAttribute('data-tone')).toBe('warning');
    const paused = container.querySelector('article[data-lane-id="p-paused"]');
    expect(paused?.querySelector('header [data-tone]')).toBeNull();
  });

  test('the legend shows the five status marks in order', () => {
    const { container } = renderChart();
    expect(
      [
        ...container.querySelectorAll('[aria-label="Legend"] [data-status]'),
      ].map((el) => el.getAttribute('data-status'))
    ).toEqual(['overdue', 'at_risk', 'on_track', 'done', 'missing']);
  });
});
