import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import type { DagTask } from '../../lib/dagLayout';
import { BRANCH_LINE_HEIGHT, BranchGraph } from './BranchGraph';

function task(
  id: string,
  blockedBy: string[] = [],
  status = 'ready',
  created = '2026-01-01'
): DagTask {
  return { id, title: `Task ${id}`, status, created, blockedBy };
}

// A → B, A → C, B,C → D: the trunk is A→B→D (B wins the tie against C by id), C forks
// onto lane 1 and merges back into D.
const diamond: DagTask[] = [
  task('t-a'),
  task('t-b', ['t-a']),
  task('t-c', ['t-a']),
  task('t-d', ['t-b', 't-c']),
];

function all<T extends Element>(container: HTMLElement, selector: string): T[] {
  return Array.from(container.querySelectorAll<T>(selector));
}

function lines(container: HTMLElement): HTMLElement[] {
  return all<HTMLElement>(container, '[data-slot="branch-line"]');
}

function edgePaths(container: HTMLElement): string[] {
  return all<SVGPathElement>(container, '[data-slot="branch-edge"]').map(
    (e) => e.getAttribute('d') ?? ''
  );
}

interface VerticalRun {
  x: number;
  y0: number;
  y1: number;
}

// The straight vertical segments of a path's `d` (M/L/C only, as `edgePath` emits), so a test
// can assert a run never passes through another row's dot.
function verticalRuns(d: string): VerticalRun[] {
  const runs: VerticalRun[] = [];
  let cur = { x: 0, y: 0 };
  for (const match of d.matchAll(/([MLC])\s*([^MLC]+)/g)) {
    const nums = (match[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const x = nums[nums.length - 2] ?? 0;
    const y = nums[nums.length - 1] ?? 0;
    if (match[1] === 'L' && x === cur.x) runs.push({ x, y0: cur.y, y1: y });
    cur = { x, y };
  }
  return runs;
}

function runsThrough(d: string, x: number, y: number): boolean {
  return verticalRuns(d).some(
    (run) =>
      run.x === x &&
      Math.min(run.y0, run.y1) < y &&
      Math.max(run.y0, run.y1) > y
  );
}

describe('BranchGraph', () => {
  test('draws one dot and one line per row and one path per edge', () => {
    const { container } = render(<BranchGraph tasks={diamond} />);
    expect(lines(container)).toHaveLength(4);
    expect(container.querySelectorAll('[data-slot="branch-dot"]')).toHaveLength(
      4
    );
    expect(
      container.querySelectorAll('[data-slot="branch-edge"]')
    ).toHaveLength(4);
    // Blockers sit above dependents, in layout order.
    expect(lines(container).map((line) => line.dataset['taskId'])).toEqual([
      't-a',
      't-b',
      't-c',
      't-d',
    ]);
  });

  test('every line is exactly 28px so dots align with titles', () => {
    const { container } = render(<BranchGraph tasks={diamond} />);
    for (const line of lines(container)) {
      expect(line.style.height).toBe(`${BRANCH_LINE_HEIGHT}px`);
    }
    const gutter = container.querySelector<SVGSVGElement>(
      '[data-slot="branch-gutter"]'
    );
    expect(gutter?.getAttribute('height')).toBe(String(4 * BRANCH_LINE_HEIGHT));
    // Each dot's centre is its row's vertical midpoint.
    const dots = all<SVGCircleElement>(container, '[data-slot="branch-dot"]');
    expect(dots.map((dot) => dot.getAttribute('cy'))).toEqual([
      '14',
      '42',
      '70',
      '98',
    ]);
  });

  test('gutter width scales with the lane count', () => {
    const flat = render(<BranchGraph tasks={[task('t-a'), task('t-b')]} />);
    const flatGutter = flat.container.querySelector<SVGSVGElement>(
      '[data-slot="branch-gutter"]'
    );
    expect(flatGutter?.getAttribute('width')).toBe('24');
    flat.unmount();

    const { container } = render(<BranchGraph tasks={diamond} />);
    const gutter = container.querySelector<SVGSVGElement>(
      '[data-slot="branch-gutter"]'
    );
    expect(gutter?.getAttribute('width')).toBe('40');
    // The lines pad past the gutter so titles never sit under a dot.
    for (const line of lines(container)) {
      expect(line.style.paddingLeft).toBe('40px');
    }
  });

  test('on-path rows carry data-path and the strong treatment; off-path rows are muted', () => {
    const { container } = render(<BranchGraph tasks={diamond} />);
    const byId = new Map(
      lines(container).map((line) => [line.dataset['taskId'], line])
    );
    for (const id of ['t-a', 't-b', 't-d']) {
      const line = byId.get(id);
      expect(line?.dataset['path']).toBe('true');
      expect(
        line?.querySelector('[data-slot="branch-line-title"]')?.className
      ).toContain('text-foreground');
    }
    const off = byId.get('t-c');
    expect(off?.dataset['path']).toBeUndefined();
    expect(
      off?.querySelector('[data-slot="branch-line-title"]')?.className
    ).toContain('text-(--text-secondary)');

    // The dots and edges mirror the lines: strong on the path, muted off it.
    const dots = all<SVGCircleElement>(container, '[data-slot="branch-dot"]');
    expect(dots.map((dot) => dot.dataset['path'])).toEqual([
      'true',
      'true',
      undefined,
      'true',
    ]);
    expect(dots.map((dot) => dot.getAttribute('r'))).toEqual([
      '4',
      '4',
      '3',
      '4',
    ]);
    const edges = all<SVGPathElement>(container, '[data-slot="branch-edge"]');
    const strong = edges.filter((e) => e.dataset['path'] === 'true');
    const muted = edges.filter((e) => e.dataset['path'] === undefined);
    expect(strong).toHaveLength(2);
    expect(muted).toHaveLength(2);
    for (const edge of strong) {
      expect(edge.getAttribute('stroke')).toBe('var(--border-strong)');
      expect(edge.getAttribute('stroke-width')).toBe('2');
    }
    for (const edge of muted) {
      expect(edge.getAttribute('stroke')).toBe('var(--border-default)');
      expect(edge.getAttribute('stroke-width')).toBe('1');
    }
  });

  test('fork and merge edges bend between lanes with a cubic bezier; same-lane edges are straight', () => {
    const { container } = render(<BranchGraph tasks={diamond} />);
    const edges = all<SVGPathElement>(container, '[data-slot="branch-edge"]');
    const paths = edges.map((e) => e.getAttribute('d') ?? '');
    // A→B and B→D stay on lane 0: a straight vertical line.
    expect(
      paths.filter((p) => p.startsWith('M 12 ') && !p.includes('C'))
    ).toHaveLength(2);
    // A→C forks out to lane 1 and C→D merges back: both carry a bezier segment.
    expect(paths.filter((p) => p.includes(' C '))).toHaveLength(2);
    // The fork bends in the first gap below A and runs down lane 1, so it never passes under
    // B's dot at (12, 42) and cannot read as B→C.
    const fork = paths.find((p) => p.startsWith('M 12 ') && p.includes(' C '));
    expect(fork).toBe('M 12 18 C 12 28, 28 28, 28 38 L 28 66');
    expect(runsThrough(fork ?? '', 12, 42)).toBe(false);
    // The merge holds lane 1 until the last gap above D, then bends back to the trunk.
    const merge = paths.find((p) => p.startsWith('M 28 '));
    expect(merge).toBe('M 28 74 C 28 84, 12 84, 12 94');
  });

  test('a long fork leaves the trunk at once rather than running through the trunk dots', () => {
    // A→X→Y on the trunk, A→C off it two rows later, C and Y merge into D.
    const { container } = render(
      <BranchGraph
        tasks={[
          task('t-a', [], 'ready', '2026-01-01'),
          task('t-x', ['t-a'], 'ready', '2026-01-02'),
          task('t-y', ['t-x'], 'ready', '2026-01-03'),
          task('t-c', ['t-a'], 'ready', '2026-01-04'),
          task('t-d', ['t-c', 't-y'], 'ready', '2026-01-05'),
        ]}
      />
    );
    expect(lines(container).map((line) => line.dataset['taskId'])).toEqual([
      't-a',
      't-x',
      't-y',
      't-c',
      't-d',
    ]);
    const fork = edgePaths(container).find(
      (p) => p.startsWith('M 12 ') && p.includes(' C ')
    );
    expect(fork).toBe('M 12 18 C 12 28, 28 28, 28 38 L 28 94');
    // No straight run on lane 0 spans X's row (y 42) or Y's (y 70).
    expect(runsThrough(fork ?? '', 12, 42)).toBe(false);
    expect(runsThrough(fork ?? '', 12, 70)).toBe(false);
  });

  test('a fork onto a reused lane bends below the dot already on it', () => {
    // P forks onto lane 1 and merges into Y, releasing the lane; C then reuses lane 1 below
    // it. A→C must not run down lane 1 through P's dot.
    const { container } = render(
      <BranchGraph
        tasks={[
          task('t-a', [], 'ready', '2026-01-01'),
          task('t-x', ['t-a'], 'ready', '2026-01-02'),
          task('t-p', ['t-a'], 'ready', '2026-01-03'),
          task('t-y', ['t-x', 't-p'], 'ready', '2026-01-04'),
          task('t-c', ['t-a'], 'ready', '2026-01-05'),
          task('t-d', ['t-y', 't-c'], 'ready', '2026-01-06'),
        ]}
      />
    );
    const dots = all<SVGCircleElement>(container, '[data-slot="branch-dot"]');
    const rowOf = new Map(
      lines(container).map((line, i) => [line.dataset['taskId'], i])
    );
    const pDot = dots[rowOf.get('t-p') ?? -1];
    const cDot = dots[rowOf.get('t-c') ?? -1];
    expect(pDot?.getAttribute('cx')).toBe(cDot?.getAttribute('cx'));
    expect(pDot?.getAttribute('cx')).toBe('28');

    const cY = Number(cDot?.getAttribute('cy'));
    const fork = edgePaths(container).find(
      (p) => p.startsWith('M 12 18') && p.endsWith(`L 28 ${cY - 4}`)
    );
    expect(fork).toBeDefined();
    expect(runsThrough(fork ?? '', 28, Number(pDot?.getAttribute('cy')))).toBe(
      false
    );
  });

  test('a cycle draws its back-edge as one visible upward line beside the forward edge', () => {
    const { container } = render(
      <BranchGraph tasks={[task('t-a', ['t-b']), task('t-b', ['t-a'])]} />
    );
    const paths = edgePaths(container);
    expect(paths).toHaveLength(2);
    expect(paths).toContain('M 12 18 L 12 38');
    // The back-edge runs upward, offset from the lane so the forward edge does not hide it.
    const upward = paths.filter((p) => {
      const [run] = verticalRuns(p);
      return run !== undefined && run.y1 < run.y0;
    });
    expect(upward).toEqual(['M 14 38 L 14 18']);
  });

  test('done, open and live dots render distinctly via the status tokens', () => {
    const { container } = render(
      <BranchGraph
        tasks={[
          task('t-a', [], 'landed'),
          task('t-b', ['t-a'], 'working'),
          task('t-c', ['t-b'], 'ready'),
        ]}
      />
    );
    const dots = all<SVGCircleElement>(container, '[data-slot="branch-dot"]');
    expect(dots.map((dot) => dot.dataset['dot'])).toEqual([
      'done',
      'live',
      'open',
    ]);
    // Done fills in its status colour, open is a ring on the page surface, live fills and
    // grows a halo.
    expect(dots[0]?.getAttribute('fill')).toBe('var(--status-done)');
    expect(dots[1]?.getAttribute('fill')).toBe('var(--status-progress)');
    expect(dots[2]?.getAttribute('fill')).toBe('var(--surface-page)');
    expect(dots[2]?.getAttribute('stroke')).toBe('var(--status-todo)');
    expect(
      container.querySelectorAll('[data-slot="branch-dot-halo"]')
    ).toHaveLength(1);
  });

  test('a flat milestone joins its trunk with lane segments', () => {
    const { container } = render(
      <BranchGraph tasks={[task('t-a'), task('t-b'), task('t-c')]} />
    );
    expect(
      container.querySelectorAll('[data-slot="branch-edge"]')
    ).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-slot="branch-lane"]')
    ).toHaveLength(2);
  });

  test('clicking a line or its dot calls onOpenNode with the id', () => {
    const onOpenNode = mock((_id: string) => {});
    const { container } = render(
      <BranchGraph tasks={diamond} onOpenNode={onOpenNode} />
    );
    fireEvent.click(screen.getByRole('button', { name: /Task t-c/ }));
    expect(onOpenNode).toHaveBeenLastCalledWith('t-c');

    const dots = container.querySelectorAll('[data-slot="branch-dot"]');
    fireEvent.click(dots[3]);
    expect(onOpenNode).toHaveBeenLastCalledWith('t-d');
    expect(onOpenNode).toHaveBeenCalledTimes(2);
  });

  test('a keyboard-focused line takes the neutral focus wash', () => {
    const { container } = render(
      <BranchGraph tasks={diamond} onOpenNode={() => {}} />
    );
    const line = lines(container)[1];
    expect(line?.tagName).toBe('BUTTON');
    line?.focus();
    expect(document.activeElement).toBe(line ?? null);
    expect(line?.className).toContain('focus-visible:bg-surface-active');
    expect(line?.className).not.toContain('accent');
  });

  test('the row wash is rounded like the list rows', () => {
    const { container } = render(
      <BranchGraph tasks={diamond} onOpenNode={() => {}} />
    );
    for (const line of lines(container)) {
      expect(line.className).toContain('rounded-control');
    }
  });

  test('renders plain lines without onOpenNode', () => {
    const { container } = render(<BranchGraph tasks={diamond} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    for (const line of lines(container)) {
      expect(line.tagName).toBe('DIV');
      expect(line.className).not.toContain('cursor-pointer');
    }
  });

  test('the focused row is marked with the active surface, no accent', () => {
    const { container } = render(
      <BranchGraph tasks={diamond} focusedId="t-b" onOpenNode={() => {}} />
    );
    const focused = lines(container).filter(
      (line) => line.dataset['focused'] === 'true'
    );
    expect(focused).toHaveLength(1);
    expect(focused[0]?.dataset['taskId']).toBe('t-b');
    expect(focused[0]?.classList.contains('bg-surface-active')).toBe(true);
    expect(focused[0]?.className).not.toContain('accent');
    // Only the roving cursor's line carries the unconditional wash (the focus-visible variant
    // on every button is a different class token).
    for (const line of lines(container)) {
      if (line.dataset['taskId'] !== 't-b') {
        expect(line.classList.contains('bg-surface-active')).toBe(false);
      }
    }
  });

  test('refFor and accessoryFor fill the id and trailing slots', () => {
    const { container } = render(
      <BranchGraph
        tasks={diamond}
        refFor={(id) => id.toUpperCase()}
        accessoryFor={(id) => (id === 't-d' ? <span>live</span> : undefined)}
      />
    );
    const ids = all(container, '[data-slot="branch-line-id"]').map(
      (el) => el.textContent
    );
    expect(ids).toEqual(['T-A', 'T-B', 'T-C', 'T-D']);
    expect(
      container.querySelectorAll('[data-slot="branch-line-trailing"]')
    ).toHaveLength(1);
    expect(screen.getByText('live')).toBeTruthy();
  });

  test('an empty set renders one muted line', () => {
    const { container } = render(<BranchGraph tasks={[]} />);
    expect(lines(container)).toHaveLength(0);
    expect(
      container.querySelector('[data-slot="branch-graph-empty"]')?.textContent
    ).toBe('No tasks');
  });

  test('a band draws only its lines and clips the gutter to them', () => {
    const chain = Array.from({ length: 40 }, (_, i) =>
      task(
        `t-${String(i).padStart(2, '0')}`,
        i === 0 ? [] : [`t-${String(i - 1).padStart(2, '0')}`]
      )
    );
    const { container } = render(
      <BranchGraph tasks={chain} band={{ start: 16, end: 32 }} />
    );
    const drawn = lines(container).map((line) => line.dataset['taskId']);
    expect(drawn).toHaveLength(16);
    expect(drawn[0]).toBe('t-16');
    const svg = container.querySelector('[data-slot="branch-gutter"]');
    expect(svg?.getAttribute('height')).toBe(String(16 * BRANCH_LINE_HEIGHT));
    expect(svg?.getAttribute('viewBox')?.split(' ')[1]).toBe(
      String(16 * BRANCH_LINE_HEIGHT)
    );
    // The 15 inside the band plus the one in and the one out; not the other 22.
    expect(edgePaths(container)).toHaveLength(17);
    expect(container.querySelectorAll('[data-slot="branch-dot"]')).toHaveLength(
      16
    );
  });
});
