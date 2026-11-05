import { describe, expect, test } from 'bun:test';

import {
  applyOverrides,
  computeConnectors,
  computeLayout,
  GROUP_HEIGHT,
  type LaneRow,
  ROW_HEIGHT,
  SUMMARY_HEIGHT,
} from '../src/timeline/layout';
import type {
  TimelineBar,
  TimelineGroup,
  TimelineLane,
} from '../src/timeline/types';
import type { UiStatus } from '../src/types';

// Weeks zoom (32px a day) over Mon Oct 19 – Sun Nov 15 2026.
const WINDOW = { windowStart: '2026-10-19', windowEnd: '2026-11-15' };
const TODAY = '2026-10-21';
// A dropped connector ends a pixel above the waiting bar's top edge: half
// the 24px bar plus one. A literal, so a change to the bar height or the
// gap shows up here rather than being recomputed from the same formula.
const TOP_EDGE = 13;

function bar(
  id: string,
  start: string,
  end: string,
  status: UiStatus = 'on_track'
): TimelineBar {
  return { id, label: id, start, end, status, statusLabel: status };
}

function lane(id: string, bars: TimelineBar[]): TimelineLane {
  return { id, label: id, bars, undated: [] };
}

function layoutOf(groups: TimelineGroup[], overrides?: Map<string, string>) {
  return computeLayout({
    groups,
    ...WINDOW,
    today: TODAY,
    zoom: 'weeks',
    overrides,
  });
}

function laneRow(layout: ReturnType<typeof layoutOf>, id: string): LaneRow {
  const row = layout.lanes.get(id);
  if (row === undefined) throw new Error(`no lane ${id}`);
  return row;
}

describe('computeLayout rows', () => {
  test('summary, then each initiative row followed by its lanes', () => {
    const layout = layoutOf([
      { id: 'g1', label: 'One', lanes: [lane('a', []), lane('b', [])] },
      { id: 'g2', label: 'Two', lanes: [lane('c', [])] },
    ]);
    expect(layout.rows.map((r) => r.key)).toEqual([
      'summary',
      'g:g1',
      'l:a',
      'l:b',
      'g:g2',
      'l:c',
    ]);
    // Rows stack edge to edge: no 1px overlaps (each row draws only its
    // own bottom rule).
    expect(layout.rows[1]?.top).toBe(SUMMARY_HEIGHT);
    expect(laneRow(layout, 'a').top).toBe(SUMMARY_HEIGHT + GROUP_HEIGHT);
    expect(laneRow(layout, 'b').top).toBe(
      SUMMARY_HEIGHT + GROUP_HEIGHT + ROW_HEIGHT
    );
    expect(layout.height).toBe(
      SUMMARY_HEIGHT + 2 * GROUP_HEIGHT + 3 * ROW_HEIGHT
    );
  });

  test('today is the centre of its column, null outside the window', () => {
    expect(layoutOf([]).todayX).toBe(2 * 32 + 16);
    const outside = computeLayout({
      groups: [],
      windowStart: '2026-11-01',
      windowEnd: '2026-11-30',
      today: TODAY,
      zoom: 'months',
    });
    expect(outside.todayX).toBeNull();
  });
});

describe('bar geometry', () => {
  test('a bar runs from the centre of its start day to its due date', () => {
    const layout = layoutOf([
      {
        id: 'g',
        label: 'G',
        lanes: [lane('a', [bar('m', '2026-10-21', '2026-10-28')])],
      },
    ]);
    const g = layout.bars.get('m');
    expect(g?.left).toBe(2 * 32 + 16);
    expect(g?.width).toBe(7 * 32);
    expect(g?.endX).toBe(9 * 32 + 16);
    expect(g?.clippedStart).toBe(false);
    expect(g?.clippedEnd).toBe(false);
  });

  test('bars are clipped at the window edges and counted when outside', () => {
    const layout = layoutOf([
      {
        id: 'g',
        label: 'G',
        lanes: [
          lane('a', [
            bar('before', '2026-09-01', '2026-10-01', 'done'),
            bar('left', '2026-10-01', '2026-10-22'),
            bar('right', '2026-11-10', '2026-12-20'),
            bar('after', '2026-12-20', '2027-01-10'),
          ]),
        ],
      },
    ]);
    const row = laneRow(layout, 'a');
    expect(row.earlier).toBe(1);
    expect(row.later).toBe(1);
    const left = layout.bars.get('left');
    expect(left?.left).toBe(0);
    expect(left?.clippedStart).toBe(true);
    const right = layout.bars.get('right');
    expect(right?.clippedEnd).toBe(true);
    expect((right?.left ?? 0) + (right?.width ?? 0)).toBe(layout.scale.width);
    expect(layout.bars.has('before')).toBe(false);
  });

  test('consecutive milestones share a line; overlapping ones stack', () => {
    const sequential = laneRow(
      layoutOf([
        {
          id: 'g',
          label: 'G',
          lanes: [
            lane('a', [
              bar('m1', '2026-10-19', '2026-10-23'),
              bar('m2', '2026-10-23', '2026-11-02'),
              bar('m3', '2026-11-02', '2026-11-09'),
            ]),
          ],
        },
      ]),
      'a'
    );
    expect(sequential.subRows).toBe(1);
    expect(sequential.height).toBe(ROW_HEIGHT);

    const sameDay = layoutOf([
      {
        id: 'g',
        label: 'G',
        lanes: [
          lane('a', [
            bar('m1', '2026-10-19', '2026-10-30'),
            bar('m2', '2026-10-30', '2026-10-30'),
          ]),
        ],
      },
    ]);
    const row = laneRow(sameDay, 'a');
    expect(row.subRows).toBe(2);
    expect(row.height).toBe(2 * ROW_HEIGHT);
    const point = sameDay.bars.get('m2');
    expect(point?.point).toBe(true);
    expect(point?.subRow).toBe(1);
    expect(point?.centerY).toBe(row.top + ROW_HEIGHT + ROW_HEIGHT / 2);
  });

  test('a narrow bar with room after it carries its label outside', () => {
    const layout = layoutOf([
      {
        id: 'g',
        label: 'G',
        lanes: [lane('a', [bar('m', '2026-10-20', '2026-10-21')])],
      },
    ]);
    expect(layout.bars.get('m')?.labelOutside).toBe(true);
  });

  test('a narrow bar with no room after it draws no label at all', () => {
    // Months zoom (11px a day): m1 is two days (22px) wide and m2 abuts
    // it, so an inside label would be a bare ellipsis.
    const layout = computeLayout({
      groups: [
        {
          id: 'g',
          label: 'G',
          lanes: [
            lane('a', [
              bar('m1', '2026-10-20', '2026-10-22'),
              bar('m2', '2026-10-22', '2026-11-12'),
            ]),
          ],
        },
      ],
      ...WINDOW,
      today: TODAY,
      zoom: 'months',
    });
    const m1 = layout.bars.get('m1');
    expect(m1?.labelOutside).toBe(false);
    expect(m1?.labelHidden).toBe(true);
    expect(layout.bars.get('m2')?.labelHidden).toBe(false);
  });

  test('marks a bar that starts on the previous milestone’s diamond', () => {
    const layout = layoutOf([
      {
        id: 'g',
        label: 'G',
        lanes: [
          lane('a', [
            bar('a1', '2026-10-19', '2026-10-23'),
            bar('a2', '2026-10-23', '2026-11-02'),
            bar('a3', '2026-11-05', '2026-11-09'),
          ]),
        ],
      },
    ]);
    expect(layout.bars.get('a1')?.startsAtDiamond).toBe(false);
    expect(layout.bars.get('a2')?.startsAtDiamond).toBe(true);
    // A gap before it: its start is clear.
    expect(layout.bars.get('a3')?.startsAtDiamond).toBe(false);
  });

  test('summary points merge same-day milestones under the worst status', () => {
    const layout = layoutOf([
      {
        id: 'g',
        label: 'G',
        lanes: [
          lane('a', [bar('a1', '2026-10-19', '2026-10-23', 'on_track')]),
          lane('b', [bar('b1', '2026-10-19', '2026-10-23', 'overdue')]),
          lane('c', [bar('c1', '2026-10-19', '2026-10-24', 'done')]),
        ],
      },
    ]);
    const summary = layout.rows[0];
    if (summary?.kind !== 'summary') throw new Error('no summary row');
    expect(summary.count).toBe(3);
    expect(summary.points.map((p) => p.end)).toEqual([
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(summary.points[0]?.status).toBe('overdue');
    expect(summary.points[0]?.bars.map((b) => b.id)).toEqual(['a1', 'b1']);
    // One day apart (32px) leaves no room for a label before the next.
    expect(summary.points[0]?.labelRoom).toBeNull();
    expect(summary.points[1]?.labelRoom).not.toBeNull();
    expect(summary.points.map((p) => p.muted)).toEqual([false, false]);
  });

  test('an inactive (muted) lane never makes a summary diamond loud', () => {
    const quiet = (id: string, bars: TimelineBar[]): TimelineLane => ({
      ...lane(id, bars),
      muted: true,
    });
    const layout = layoutOf([
      {
        id: 'g',
        label: 'G',
        lanes: [
          lane('a', [bar('a1', '2026-10-19', '2026-10-23', 'on_track')]),
          quiet('b', [
            bar('b1', '2026-10-19', '2026-10-23', 'overdue'),
            bar('b2', '2026-10-23', '2026-10-30', 'at_risk'),
          ]),
        ],
      },
    ]);
    const summary = layout.rows[0];
    if (summary?.kind !== 'summary') throw new Error('no summary row');
    // Same day as an active lane's milestone: the active one decides.
    expect(summary.points[0]?.status).toBe('on_track');
    expect(summary.points[0]?.muted).toBe(false);
    expect(summary.points[0]?.bars.map((b) => b.id)).toEqual(['a1', 'b1']);
    // Only the muted lane is due that day: drawn muted.
    expect(summary.points[1]?.muted).toBe(true);
  });
});

describe('applyOverrides', () => {
  test('moves the due date and pulls the next milestone’s start along', () => {
    const bars = [
      bar('m1', '2026-10-19', '2026-10-23'),
      bar('m2', '2026-10-23', '2026-11-02'),
    ];
    const moved = applyOverrides(bars, new Map([['m1', '2026-10-26']]));
    expect(moved[0]).toMatchObject({ start: '2026-10-19', end: '2026-10-26' });
    expect(moved[1]).toMatchObject({ start: '2026-10-26', end: '2026-11-02' });
    expect(applyOverrides(bars, new Map())).toBe(bars);
  });

  test('a start never passes its end', () => {
    const bars = [
      bar('m1', '2026-10-19', '2026-10-23'),
      bar('m2', '2026-10-23', '2026-10-25'),
    ];
    const moved = applyOverrides(bars, new Map([['m1', '2026-10-28']]));
    expect(moved[1]).toMatchObject({ start: '2026-10-25', end: '2026-10-25' });
    const back = applyOverrides(bars, new Map([['m2', '2026-10-20']]));
    expect(back[1]).toMatchObject({ start: '2026-10-20', end: '2026-10-20' });
  });

  test('the layout keeps a moved lane on one line', () => {
    const groups: TimelineGroup[] = [
      {
        id: 'g',
        label: 'G',
        lanes: [
          lane('a', [
            bar('m1', '2026-10-19', '2026-10-23'),
            bar('m2', '2026-10-23', '2026-11-02'),
          ]),
        ],
      },
    ];
    const layout = layoutOf(groups, new Map([['m1', '2026-10-27']]));
    expect(laneRow(layout, 'a').subRows).toBe(1);
    expect(layout.bars.get('m2')?.left).toBe(8 * 32 + 16);
  });
});

describe('computeConnectors', () => {
  const groups: TimelineGroup[] = [
    {
      id: 'g',
      label: 'G',
      lanes: [
        lane('a', [
          bar('a1', '2026-10-19', '2026-10-23', 'overdue'),
          bar('a2', '2026-10-23', '2026-11-02'),
        ]),
        lane('b', [
          bar('b1', '2026-10-19', '2026-11-06'),
          bar('b2', '2026-11-06', '2026-11-13'),
        ]),
        lane('c', [bar('c1', '2026-10-28', '2026-11-09')]),
      ],
    },
  ];
  const layout = layoutOf(groups);

  test('into the waiting bar’s start when it begins after the blocker', () => {
    const [edge] = computeConnectors(layout, [
      { from: 'a1', to: 'c1', onRiskChain: true },
    ]);
    expect(edge?.route).toBe('start');
    expect(edge?.onRiskChain).toBe(true);
    expect(edge?.conflict).toBe(false);
    const c1 = layout.bars.get('c1');
    // Ends one pixel short of the waiting bar's left edge.
    expect(edge?.d.endsWith(`${(c1?.left ?? 0) - 1} ${c1?.centerY}`)).toBe(
      true
    );
  });

  test('drops onto a waiting bar that is already under way', () => {
    const [edge] = computeConnectors(layout, [
      { from: 'a1', to: 'b1', onRiskChain: false },
    ]);
    expect(edge?.route).toBe('drop');
    const a1 = layout.bars.get('a1');
    const b1 = layout.bars.get('b1');
    // Lands on b1's top edge (a pixel above it), straight under a1's
    // diamond.
    expect(edge?.d.startsWith(`M${a1?.endX} `)).toBe(true);
    expect(
      edge?.d.endsWith(`${a1?.endX} ${(b1?.centerY ?? 0) - TOP_EDGE}`)
    ).toBe(true);
  });

  test('never aims at a start hidden under the previous diamond', () => {
    // b2 begins after a2 is due, but its start is b1's diamond: an arrow
    // into it would vanish under that diamond and read as pointing at b1.
    const [edge] = computeConnectors(layout, [
      { from: 'a2', to: 'b2', onRiskChain: false },
    ]);
    const a2 = layout.bars.get('a2');
    const b2 = layout.bars.get('b2');
    expect(b2?.startsAtDiamond).toBe(true);
    expect(edge?.route).toBe('drop');
    expect(edge?.d.startsWith(`M${a2?.endX} `)).toBe(true);
    // Lands on b2's top edge, clear of the 8px diamond reach (+6).
    expect(
      edge?.d.endsWith(
        `${(b2?.left ?? 0) + 14} ${(b2?.centerY ?? 0) - TOP_EDGE}`
      )
    ).toBe(true);
  });

  test('flags a waiting milestone due before its blocker', () => {
    const [edge] = computeConnectors(layout, [
      { from: 'b1', to: 'a2', onRiskChain: false },
    ]);
    expect(edge?.conflict).toBe(true);
    expect(edge?.route).toBe('drop');
  });

  test('skips abutting bars on one line and edges to undrawn bars', () => {
    expect(
      computeConnectors(layout, [
        { from: 'a1', to: 'a2', onRiskChain: false },
        { from: 'a1', to: 'missing', onRiskChain: false },
        { from: 'a1', to: 'a1', onRiskChain: false },
      ])
    ).toEqual([]);
  });
});
