import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  TimelineChart,
  type TimelineChartProps,
  type TimelineGroup,
  type UiLinkProps,
  UiLinkProvider,
} from '../src/index';

afterEach(cleanup);

const GROUPS: TimelineGroup[] = [
  {
    id: 'ini-payments',
    label: 'Payments platform',
    lanes: [
      {
        id: 'p-atlas',
        label: 'Atlas migration',
        href: '/timeline?project=p-atlas',
        sublabel: 'Pat Lee',
        bars: [
          {
            id: 'm-rehearsal',
            label: 'Cutover rehearsal',
            start: '2026-10-08',
            end: '2026-10-19',
            status: 'overdue',
            statusLabel: 'Overdue',
            progressLabel: '4/7',
            tags: ['Next'],
            editable: true,
          },
          {
            id: 'm-cutover',
            label: 'Cutover',
            start: '2026-10-19',
            end: '2026-11-06',
            status: 'on_track',
            statusLabel: 'On track',
          },
        ],
        undated: [
          {
            id: 'm-pricing',
            label: 'Pricing page',
            status: 'missing',
            statusLabel: 'No target date',
          },
        ],
      },
      {
        id: 'p-ledger',
        label: 'Ledger API',
        sublabel: 'No lead',
        sublabelTone: 'warning',
        bars: [
          {
            id: 'm-v2',
            label: 'v2 endpoints',
            start: '2026-09-28',
            end: '2026-11-02',
            status: 'missing',
            statusLabel: 'Missing input',
            missing: 'Missing: done means',
            editable: true,
          },
        ],
        undated: [],
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
  const utils = render(<TimelineChart {...props} />);
  // The phone cards render the same milestones (hidden by CSS above
  // 900px), so chart queries are scoped to the chart's region.
  const chart = within(utils.getByRole('region', { name: /^Timeline/ }));
  return { ...utils, chart, props };
}

/** A promise whose settling the test controls. */
function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('bars', () => {
  test('are buttons named with status, due date and receipts', () => {
    const onOpenBar = mock((_id: string) => {});
    const { chart } = renderChart({ onOpenBar });
    const rehearsal = chart.getByRole('button', {
      name: 'Cutover rehearsal, Overdue, due Mon, Oct 19, 4/7 done, Next',
    });
    expect(rehearsal.tagName).toBe('BUTTON');
    expect(rehearsal.getAttribute('type')).toBe('button');
    fireEvent.click(rehearsal);
    expect(onOpenBar).toHaveBeenCalledWith('m-rehearsal');

    expect(
      chart.getByRole('button', {
        name: 'v2 endpoints, Missing input, due Mon, Nov 2, Missing: done means',
      })
    ).toBeTruthy();
  });

  test('give their sticky label the scroll offset and the bar end to fit in', () => {
    // timeline-bar.module.css caps .content at --bar-end less
    // --timeline-scroll-x, so a bar mostly under the lane column keeps its
    // name readable instead of pinning full-width content to its end.
    const { container, chart } = renderChart();
    const item = chart
      .getByRole('button', { name: /^Cutover rehearsal/ })
      .closest('[data-bar-id]') as HTMLElement;
    const left = Number.parseFloat(item.style.left);
    const width = Number.parseFloat(item.style.width);
    expect(item.style.getPropertyValue('--bar-end')).toBe(`${left + width}px`);
    const scroller = container.querySelector<HTMLElement>(
      '[style*="--timeline-scroll-x"]'
    );
    expect(scroller).not.toBeNull();
    if (scroller === null) return;
    scroller.scrollLeft = 240;
    fireEvent.scroll(scroller);
    expect(scroller.style.getPropertyValue('--timeline-scroll-x')).toBe(
      '240px'
    );
  });

  test('say their status by shape, not only by hue (WCAG 1.4.1)', () => {
    // Each bar's name is led by the status mark, and its due-date diamond
    // takes the status's shape (data-status); the mark is drawing only
    // (the bar's name already says the status).
    const { chart } = renderChart();
    for (const [name, status] of [
      [/^Cutover rehearsal/, 'overdue'],
      [/^Cutover, On track/, 'on_track'],
      [/^v2 endpoints/, 'missing'],
    ] as const) {
      const bar = chart.getByRole('button', { name });
      const mark = bar.querySelector('[data-status]');
      expect(mark?.getAttribute('data-status')).toBe(status);
      expect(mark?.closest('[aria-hidden="true"]')).not.toBeNull();
      const item = bar.closest('[data-bar-id]') as HTMLElement;
      const diamond = item.querySelector(':scope > [data-status]');
      expect(diamond?.getAttribute('data-status')).toBe(status);
    }
    // The undated chip carries its mark too.
    const chip = chart.getByRole('button', {
      name: 'Pricing page, No target date, no due date',
    });
    expect(
      chip.querySelector('[data-status]')?.getAttribute('data-status')
    ).toBe('missing');
  });

  test('mark the selected bar as current', () => {
    const { chart } = renderChart({ selectedBarId: 'm-cutover' });
    const cutover = chart.getByRole('button', { name: /^Cutover, On track/ });
    expect(cutover.getAttribute('aria-current')).toBe('true');
  });

  test('undated milestones are chips that open too', () => {
    const onOpenBar = mock((_id: string) => {});
    const { chart } = renderChart({ onOpenBar });
    fireEvent.click(
      chart.getByRole('button', {
        name: 'Pricing page, No target date, no due date',
      })
    );
    expect(onOpenBar).toHaveBeenCalledWith('m-pricing');
  });

  test('lanes are labelled groups whose names route through the host link', () => {
    function HostLink({ children, ...rest }: UiLinkProps) {
      return (
        <a {...rest} data-host-link="">
          {children}
        </a>
      );
    }
    const { getByRole } = render(
      <UiLinkProvider link={HostLink}>
        <TimelineChart
          today="2026-10-21"
          windowStart="2026-09-21"
          windowEnd="2027-01-17"
          zoom="weeks"
          groups={GROUPS}
          onOpenBar={() => {}}
        />
      </UiLinkProvider>
    );
    const chart = within(getByRole('region', { name: /^Timeline/ }));
    const lane = chart.getByRole('group', { name: 'Ledger API, No lead' });
    expect(lane).toBeTruthy();
    const link = chart.getByRole('link', { name: 'Atlas migration' });
    expect(link.getAttribute('href')).toBe('/timeline?project=p-atlas');
    expect(link.hasAttribute('data-host-link')).toBe(true);
  });
});

describe('group links', () => {
  function HostLink({ children, ...rest }: UiLinkProps) {
    return (
      <a {...rest} data-host-link="">
        {children}
      </a>
    );
  }

  const LINKED: TimelineGroup[] = GROUPS.map((group) => ({
    ...group,
    link: {
      label: 'Graph',
      href: `/graph?initiative=${group.id}`,
      ariaLabel: `Dependency graph of ${group.label}`,
    },
  }));

  function renderLinked(groups: TimelineGroup[]) {
    const utils = render(
      <UiLinkProvider link={HostLink}>
        <TimelineChart
          today="2026-10-21"
          windowStart="2026-09-21"
          windowEnd="2027-01-17"
          zoom="weeks"
          groups={groups}
          onOpenBar={() => {}}
        />
      </UiLinkProvider>
    );
    return {
      ...utils,
      chart: within(utils.getByRole('region', { name: /^Timeline/ })),
      card: within(utils.getByRole('region', { name: 'Payments platform' })),
    };
  }

  test('render through the host Link in the chart and in the phone cards', () => {
    const { chart, card } = renderLinked(LINKED);
    for (const view of [chart, card]) {
      const link = view.getByRole('link', {
        name: 'Dependency graph of Payments platform',
      });
      expect(link.getAttribute('href')).toBe('/graph?initiative=ini-payments');
      expect(link.hasAttribute('data-host-link')).toBe(true);
      expect(link.textContent).toBe('Graph');
      // The heading stays the group's name: the link and count sit beside it.
      expect(
        view.getByRole('heading', { level: 3, name: 'Payments platform' })
      ).toBeTruthy();
    }
  });

  test('in the chart the link follows the count at the cell edge', () => {
    const { chart } = renderLinked(LINKED);
    const link = chart.getByRole('link', {
      name: 'Dependency graph of Payments platform',
    });
    // Gr8r's group row: the name, the quiet count beside it, then the
    // link pushed to the cell's right edge as a ghost button.
    const cell = link.parentElement;
    const parts = Array.from(cell?.children ?? []);
    expect(parts.map((el) => el.tagName)).toEqual(['H3', 'SPAN', 'A']);
    expect(parts[1]?.textContent).toMatch(/^\d+ projects?$/);
    expect(parts[2]).toBe(link);
    // The name keeps its full text as a tooltip when it ellipsizes.
    expect(parts[0]?.getAttribute('title')).toBe('Payments platform');
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'timeline',
        'timeline-chart.module.css'
      ),
      'utf8'
    );
    const rule = /\.groupLink \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('margin: 0 -6px 0 auto;');
    expect(rule).not.toContain('font-family');
    expect(rule).not.toContain('text-transform');
  });

  test('the label names the link when there is no ariaLabel', () => {
    const plain = GROUPS.map((group) => ({
      ...group,
      link: { label: 'Graph', href: `/graph?initiative=${group.id}` },
    }));
    const { chart, card } = renderLinked(plain);
    expect(chart.getByRole('link', { name: 'Graph' })).toBeTruthy();
    expect(card.getByRole('link', { name: 'Graph' })).toBeTruthy();
  });

  test('no link is drawn when the group has none', () => {
    const { chart, card } = renderLinked(GROUPS);
    for (const view of [chart, card]) {
      expect(view.getAllByRole('link').map((link) => link.textContent)).toEqual(
        ['Atlas migration']
      );
      expect(
        view.getByRole('heading', { level: 3, name: 'Payments platform' })
      ).toBeTruthy();
    }
  });
});

describe('keyboard re-dating', () => {
  test('←/→ move a day, Shift a week; Enter saves through onRedate', async () => {
    const save = deferred();
    const onRedate = mock((_id: string, _end: string) => save.promise);
    const { chart, getByRole } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    expect(handle.getAttribute('aria-valuetext')).toBe('Mon, Oct 19');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuetext')).toContain('Tue, Oct 27');
    expect(onRedate).not.toHaveBeenCalled();

    fireEvent.keyDown(handle, { key: 'Enter' });
    await flush();
    expect(onRedate).toHaveBeenCalledTimes(1);
    expect(onRedate).toHaveBeenCalledWith('m-rehearsal', '2026-10-27');

    // Optimistic: the bar already says the new date while saving.
    const moved = chart.getByRole('button', { name: /^Cutover rehearsal/ });
    expect(moved.getAttribute('aria-label')).toContain('due Tue, Oct 27');
    expect(moved.getAttribute('aria-label')).toContain('saving');
    expect(getByRole('status').textContent).toContain(
      'Moving Cutover rehearsal'
    );

    save.resolve();
    await flush();
    expect(moved.getAttribute('aria-label')).not.toContain('saving');
    expect(moved.getAttribute('aria-label')).toContain('due Tue, Oct 27');
    expect(getByRole('status').textContent).toContain(
      'Cutover rehearsal is now due Tue, Oct 27'
    );
  });

  test('a rejected save rolls the bar back and says why', async () => {
    const onRedate = mock((_id: string, _end: string) =>
      Promise.reject(new Error('Linear refused the change'))
    );
    const { chart, getByRole } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'Enter' });
    await flush();
    await flush();

    expect(onRedate).toHaveBeenCalledWith('m-rehearsal', '2026-10-26');
    const bar = chart.getByRole('button', { name: /^Cutover rehearsal/ });
    expect(bar.getAttribute('aria-label')).toContain('due Mon, Oct 19');
    expect(bar.getAttribute('aria-label')).not.toContain('saving');
    const alert = getByRole('alert').textContent ?? '';
    expect(alert).toContain('Could not move Cutover rehearsal.');
    expect(alert).toContain('Linear refused the change.');
    expect(alert).toContain('restored to Mon, Oct 19');
    expect(handle.getAttribute('aria-valuetext')).toBe('Mon, Oct 19');
  });

  test('Esc cancels without saving; blur discards too', () => {
    const onRedate = mock((_id: string, _end: string) => Promise.resolve());
    const { chart } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuetext')).toContain('Tue, Oct 20');
    fireEvent.keyDown(handle, { key: 'Escape' });
    expect(handle.getAttribute('aria-valuetext')).toBe('Mon, Oct 19');
    fireEvent.keyDown(handle, { key: 'Enter' });

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.blur(handle);
    expect(handle.getAttribute('aria-valuetext')).toBe('Mon, Oct 19');
    expect(onRedate).not.toHaveBeenCalled();
  });

  test('the due date clamps to the bar start and the window end', () => {
    const onRedate = mock((_id: string, _end: string) => Promise.resolve());
    const { chart } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    }
    expect(handle.getAttribute('aria-valuetext')).toContain('Thu, Oct 8');
    for (let i = 0; i < 30; i++) {
      fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    }
    expect(handle.getAttribute('aria-valuetext')).toContain(
      'Sun, Jan 17, 2027'
    );
  });

  test('read-only charts and non-editable bars have no handle', () => {
    const readOnly = renderChart();
    expect(readOnly.chart.queryAllByRole('slider')).toHaveLength(0);
    cleanup();
    const { chart } = renderChart({ onRedate: () => Promise.resolve() });
    expect(
      chart.getAllByRole('slider').map((s) => s.getAttribute('aria-label'))
    ).toEqual(['Due date of Cutover rehearsal', 'Due date of v2 endpoints']);
  });
});

describe('optimistic dates and the host’s data', () => {
  const props = (groups: TimelineGroup[], extra = {}): TimelineChartProps => ({
    today: '2026-10-21',
    windowStart: '2026-09-21',
    windowEnd: '2027-01-17',
    zoom: 'weeks',
    groups,
    onOpenBar: () => {},
    ...extra,
  });

  /** GROUPS with m-rehearsal due on `end` (a host refetch). */
  function withRehearsalEnd(end: string): TimelineGroup[] {
    return GROUPS.map((g) => ({
      ...g,
      lanes: g.lanes.map((l) => ({
        ...l,
        bars: l.bars.map((b) => (b.id === 'm-rehearsal' ? { ...b, end } : b)),
      })),
    }));
  }

  const rehearsal = (container: HTMLElement) =>
    within(container)
      .getByRole('region', { name: /^Timeline/ })
      .querySelector('[data-bar-id="m-rehearsal"] button')
      ?.getAttribute('aria-label') ?? '';

  test('a confirmed move holds until the host’s data moves, then the host wins', async () => {
    const onRedate = mock((_id: string, _end: string) => Promise.resolve());
    const { container, rerender } = render(
      <TimelineChart {...props(GROUPS, { onRedate })} />
    );
    const handle = within(container).getAllByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    })[0];
    if (handle === undefined) throw new Error('no handle');
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'Enter' });
    await flush();
    await flush();
    // Saved, host has not refetched yet: the new date stays.
    expect(rehearsal(container)).toContain('due Mon, Oct 26');

    // A refetch with a different date (someone moved it in Linear): the
    // host's date wins and the override is gone for good.
    rerender(
      <TimelineChart {...props(withRehearsalEnd('2026-10-30'), { onRedate })} />
    );
    expect(rehearsal(container)).toContain('due Fri, Oct 30');
    rerender(
      <TimelineChart {...props(withRehearsalEnd('2026-10-19'), { onRedate })} />
    );
    expect(rehearsal(container)).toContain('due Mon, Oct 19');
  });

  test('a rejected second move restores the first, confirmed one', async () => {
    let fail = false;
    const onRedate = mock((_id: string, _end: string) =>
      fail ? Promise.reject(new Error('Nope')) : Promise.resolve()
    );
    const { chart, getByRole } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'Enter' });
    await flush();
    await flush();
    fail = true;
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'Enter' });
    await flush();
    await flush();
    expect(onRedate.mock.calls.map((c) => c[1])).toEqual([
      '2026-10-20',
      '2026-10-27',
    ]);
    expect(handle.getAttribute('aria-valuetext')).toBe('Tue, Oct 20');
    expect(getByRole('alert').textContent).toContain(
      'Due date restored to Tue, Oct 20.'
    );
  });

  test('the handle ignores keys while its save is in flight', async () => {
    const save = deferred();
    const onRedate = mock((_id: string, _end: string) => save.promise);
    const { chart } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'Enter' });
    await flush();
    expect(handle.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'Enter' });
    await flush();
    expect(onRedate).toHaveBeenCalledTimes(1);
    save.resolve();
    await flush();
    expect(handle.getAttribute('aria-disabled')).toBeNull();
  });

  test('Home and End jump to the bar start and the window end', () => {
    const { chart } = renderChart({ onRedate: () => Promise.resolve() });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle.getAttribute('aria-valuetext')).toContain(
      'Sun, Jan 17, 2027'
    );
    expect(handle.getAttribute('aria-valuenow')).toBe(
      handle.getAttribute('aria-valuemax')
    );
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle.getAttribute('aria-valuetext')).toContain('Thu, Oct 8');
    expect(handle.getAttribute('aria-valuenow')).toBe('0');
  });
});

describe('announcements and spoken text', () => {
  test('the live regions are rendered, empty, before anything is said', () => {
    const { getByRole } = renderChart({ legend: false });
    expect(getByRole('status').textContent).toBe('');
    expect(getByRole('alert').textContent).toBe('');
  });

  test('saved messages clear themselves after a while', async () => {
    const onRedate = mock((_id: string, _end: string) => Promise.resolve());
    const { chart, getByRole } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    const realSetTimeout = globalThis.setTimeout;
    const timers: (() => void)[] = [];
    globalThis.setTimeout = ((fn: () => void) => {
      timers.push(fn);
      return 0;
    }) as unknown as typeof setTimeout;
    try {
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      fireEvent.keyDown(handle, { key: 'Enter' });
      await flush();
      await flush();
      expect(getByRole('status').textContent).toContain('is now due');
      act(() => {
        for (const run of timers.splice(0)) run();
      });
      expect(getByRole('status').textContent).toBe('');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('a sublabel that asks for action carries its tone; a quiet one has none', () => {
    const { chart } = renderChart();
    const ledger = chart.getByRole('group', { name: 'Ledger API, No lead' });
    expect(within(ledger).getByText('No lead').getAttribute('data-tone')).toBe(
      'warning'
    );
    const atlas = chart.getByRole('group', {
      name: 'Atlas migration, Pat Lee',
    });
    expect(within(atlas).getByText('Pat Lee').hasAttribute('data-tone')).toBe(
      false
    );
    cleanup();
    // An inactive lane is never loud, whatever tone it is given.
    const quiet = renderChart({
      groups: [
        {
          id: 'g',
          label: 'Paused',
          lanes: [
            {
              id: 'p-fjord',
              label: 'Fjord analytics',
              sublabel: 'No lead',
              sublabelTone: 'warning',
              muted: true,
              bars: [],
              undated: [],
            },
          ],
        },
      ],
    });
    const fjord = quiet.chart.getByRole('group', {
      name: 'Fjord analytics, No lead',
    });
    expect(within(fjord).getByText('No lead').hasAttribute('data-tone')).toBe(
      false
    );
  });

  test('the legend says each status in words; its marks are drawing only', () => {
    const { getByRole } = renderChart();
    const legend = getByRole('list', { name: 'Legend' });
    expect(within(legend).queryAllByRole('img')).toHaveLength(0);
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      'Overdue',
      'At risk',
      'On track',
      'Complete',
      'Missing input',
      'Due date',
    ]);
  });

  test('edge cues are drawn, not read: the arrows are aria-hidden', () => {
    const { chart } = renderChart({ windowStart: '2026-10-25' });
    const atlas = chart.getByRole('group', {
      name: 'Atlas migration, Pat Lee',
    });
    const cue = within(atlas).getByText(/earlier/);
    expect(cue.textContent).toBe('◂ 1 earlier');
    const arrow = cue.querySelector('[aria-hidden="true"]');
    expect(arrow?.textContent?.trim()).toBe('◂');
  });

  test('the selected undated milestone is current in the phone cards too', () => {
    const { container } = renderChart({ selectedBarId: 'm-pricing' });
    const row = [...container.querySelectorAll('article button')].find(
      (b) => b.getAttribute('aria-label')?.startsWith('Pricing page') === true
    );
    expect(row?.getAttribute('aria-current')).toBe('true');
  });
});

describe('pointer re-dating', () => {
  test('losing the pointer capture mid-drag cancels the drag', async () => {
    const onRedate = mock((_id: string, _end: string) => Promise.resolve());
    const { chart } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 196 });
    expect(handle.getAttribute('aria-valuetext')).toContain('Thu, Oct 22');
    fireEvent(handle, new Event('lostpointercapture', { bubbles: true }));
    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 196 });
    await flush();
    expect(onRedate).not.toHaveBeenCalled();
    expect(handle.getAttribute('aria-valuetext')).toBe('Mon, Oct 19');
  });

  test('dragging the handle snaps to whole days and saves on release', async () => {
    const onRedate = mock((_id: string, _end: string) => Promise.resolve());
    const { chart } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 130 }); // 0.94 day
    expect(handle.getAttribute('aria-valuetext')).toContain('Tue, Oct 20');
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 164 }); // 2 days
    expect(handle.getAttribute('aria-valuetext')).toContain('Wed, Oct 21');
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 164 });
    await flush();
    expect(onRedate).toHaveBeenCalledWith('m-rehearsal', '2026-10-21');
  });

  test('Esc mid-drag cancels; the release then does nothing', async () => {
    const onRedate = mock((_id: string, _end: string) => Promise.resolve());
    const { chart } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 228 });
    fireEvent.keyDown(handle, { key: 'Escape' });
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 228 });
    await flush();
    expect(onRedate).not.toHaveBeenCalled();
    expect(handle.getAttribute('aria-valuetext')).toBe('Mon, Oct 19');
  });

  test('a release where it started saves nothing', async () => {
    const onRedate = mock((_id: string, _end: string) => Promise.resolve());
    const { chart } = renderChart({ onRedate });
    const handle = chart.getByRole('slider', {
      name: 'Due date of Cutover rehearsal',
    });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 110 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 110 });
    await flush();
    expect(onRedate).not.toHaveBeenCalled();
  });
});

describe('toolbar', () => {
  test('the zoom switch reports the new zoom; no switch without a handler', () => {
    const onZoomChange = mock((_zoom: string) => {});
    const { getByRole } = renderChart({ onZoomChange });
    fireEvent.click(getByRole('radio', { name: 'Months' }));
    expect(onZoomChange).toHaveBeenCalledWith('months');
    cleanup();
    const plain = renderChart();
    expect(plain.queryByRole('radiogroup', { name: 'Zoom' })).toBeNull();
  });

  test('dependencies toggle the connectors (uncontrolled)', () => {
    const onShowDependenciesChange = mock((_show: boolean) => {});
    const { getByRole, getByTestId, queryByTestId } = renderChart({
      dependencies: [{ from: 'm-rehearsal', to: 'm-v2', onRiskChain: true }],
      onShowDependenciesChange,
    });
    expect(
      getByTestId('timeline-connectors').querySelectorAll('g')
    ).toHaveLength(1);
    const toggle = getByRole('switch', { name: /Dependencies/ });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onShowDependenciesChange).toHaveBeenCalledWith(false);
    expect(queryByTestId('timeline-connectors')).toBeNull();
  });

  test('a controlled showDependencies wins over clicks', () => {
    const { getByRole, queryByTestId } = renderChart({
      dependencies: [{ from: 'm-rehearsal', to: 'm-v2', onRiskChain: false }],
      showDependencies: false,
    });
    expect(queryByTestId('timeline-connectors')).toBeNull();
    fireEvent.click(getByRole('switch', { name: /Dependencies/ }));
    expect(queryByTestId('timeline-connectors')).toBeNull();
  });

  test('the Today button is disabled when today is outside the window', () => {
    const { getByRole } = renderChart({
      windowStart: '2026-11-01',
      windowEnd: '2026-12-31',
    });
    expect(
      (getByRole('button', { name: 'Today' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});

describe('phone cards and empty state', () => {
  test('the card fallback lists every milestone with the same names', () => {
    const { container } = renderChart();
    const buttons = [...container.querySelectorAll('article button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Cutover rehearsal, Overdue, due Mon, Oct 19, 4/7 done, Next',
      'Cutover, On track, due Fri, Nov 6',
      'Pricing page, No target date, no due date',
      'v2 endpoints, Missing input, due Mon, Nov 2, Missing: done means',
    ]);
    expect(container.querySelectorAll('article [role="slider"]')).toHaveLength(
      0
    );
  });

  test('an inactive lane draws its cards in greys, overdue or not', () => {
    const quiet: TimelineGroup[] = [
      {
        id: 'g',
        label: 'Paused work',
        lanes: [
          {
            id: 'p-fjord',
            label: 'Fjord analytics',
            muted: true,
            bars: [
              {
                id: 'm-dash',
                label: 'Dashboards',
                start: '2026-10-01',
                end: '2026-10-16',
                status: 'overdue',
                statusLabel: 'Overdue',
                missing: 'Missing: issues',
              },
            ],
            undated: [],
          },
          {
            id: 'p-live',
            label: 'Live project',
            bars: [
              {
                id: 'm-live',
                label: 'Launch',
                start: '2026-10-01',
                end: '2026-10-16',
                status: 'overdue',
                statusLabel: 'Overdue',
              },
            ],
            undated: [],
          },
        ],
      },
    ];
    const { container } = renderChart({ groups: quiet });
    const muted = container.querySelector('article[data-lane-id="p-fjord"]');
    const live = container.querySelector('article[data-lane-id="p-live"]');
    if (muted === null || live === null) throw new Error('no cards');
    const tones = (card: Element) =>
      [...card.querySelectorAll('button [data-tone]')].map((el) =>
        el.getAttribute('data-tone')
      );
    // Receipts line, its missing input, then the due date: no tone at all
    // in the inactive lane; the live lane's overdue receipts and date in
    // the danger tone (docs/architecture.md §8.2).
    expect(tones(muted)).toEqual(['default', 'default', 'default']);
    expect(tones(live)).toEqual(['danger', 'danger']);
    // The inactive lane's mark is the grey hollow ring, still named with
    // its status; the live lane keeps its status mark.
    const markOf = (card: Element) => card.querySelector('[role="img"]');
    expect(markOf(muted)?.hasAttribute('data-muted')).toBe(true);
    expect(markOf(muted)?.getAttribute('aria-label')).toBe('Overdue');
    expect(markOf(live)?.hasAttribute('data-muted')).toBe(false);
  });

  test('a missing-input card names what is missing once', () => {
    const empty: TimelineGroup[] = [
      {
        id: 'g',
        label: 'Mobile',
        lanes: [
          {
            id: 'p-garnet',
            label: 'Garnet mobile app',
            bars: [
              {
                id: 'm-push',
                label: 'Push notifications',
                start: '2026-10-27',
                end: '2026-11-10',
                status: 'missing',
                statusLabel: 'No issues yet',
                progressLabel: '0/0',
                missing: 'Missing: issues',
              },
              {
                id: 'm-beta',
                label: 'Public beta',
                start: '2026-10-01',
                end: '2026-10-25',
                status: 'at_risk',
                statusLabel: 'At risk',
                progressLabel: '0/3',
                missing: 'Missing: done means…',
              },
            ],
            undated: [],
          },
        ],
      },
    ];
    const { container } = renderChart({ groups: empty });
    const lines = [...container.querySelectorAll('article button')].map(
      (button) => button.querySelector('[data-tone]')?.textContent
    );
    // The dashed mark plus the missing line say it; the status label would
    // repeat it. A milestone with its own status keeps the label.
    expect(lines).toEqual([
      'At risk · 0/3 · Missing: done means…',
      '0/0 · Missing: issues',
    ]);
    // The spoken name still carries the status.
    expect(
      container
        .querySelector('article button[aria-label^="Push notifications"]')
        ?.getAttribute('aria-label')
    ).toBe(
      'Push notifications, No issues yet, due Tue, Nov 10, 0/0 done, Missing: issues'
    );
  });

  test('no lanes renders the empty copy instead of a chart', () => {
    const { getByText, queryByRole } = render(
      <TimelineChart
        today="2026-10-21"
        windowStart="2026-09-21"
        windowEnd="2027-01-17"
        zoom="weeks"
        groups={[]}
        onOpenBar={() => {}}
        emptyLabel="Nothing on the timeline"
      />
    );
    expect(getByText('Nothing on the timeline')).toBeTruthy();
    expect(queryByRole('region')).toBeNull();
  });
});

describe('focused lane', () => {
  // Records which elements were asked to scroll into the page's view.
  function spyScrollIntoView() {
    const original = Element.prototype.scrollIntoView;
    const calls: { el: Element; options: unknown }[] = [];
    Element.prototype.scrollIntoView = function (this: Element, options) {
      calls.push({ el: this, options });
    };
    return {
      calls,
      restore: () => {
        Element.prototype.scrollIntoView = original;
      },
    };
  }

  test('a lane focused from outside brings the chart and its phone card into view', () => {
    const spy = spyScrollIntoView();
    try {
      const { getByRole, container } = renderChart({ focusLaneId: 'p-ledger' });
      const region = getByRole('region', { name: /^Timeline/ });
      const card = container.querySelector('article[data-lane-id="p-ledger"]');
      expect(card).not.toBeNull();
      const byChart = spy.calls.find((c) => c.el === region);
      const byCard = spy.calls.find((c) => c.el === card);
      expect(spy.calls).toHaveLength(2);
      expect(byChart?.options).toEqual({ block: 'nearest', inline: 'nearest' });
      expect(byCard?.options).toEqual({ block: 'start' });
    } finally {
      spy.restore();
    }
  });

  test('changing the focus reveals the new lane; a selected bar alone does not move the page', () => {
    const spy = spyScrollIntoView();
    try {
      const { rerender, props, container } = renderChart({
        selectedBarId: 'm-cutover',
      });
      expect(spy.calls).toHaveLength(0);
      rerender(<TimelineChart {...props} focusLaneId="p-atlas" />);
      const card = container.querySelector('article[data-lane-id="p-atlas"]');
      // The cards' effect runs before the chart's (children first).
      expect(spy.calls.map((c) => c.el.tagName).sort()).toEqual([
        'ARTICLE',
        'DIV',
      ]);
      expect(spy.calls.some((c) => c.el === card)).toBe(true);
    } finally {
      spy.restore();
    }
  });
});
