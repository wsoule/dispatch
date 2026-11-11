import type { TaskListItem } from '@dispatch-foo/core/browser';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'bun:test';

import type { TaskTab } from '../../lib/appNav';
import type { ListGroup } from '../../lib/listGrouping';
import { taskDoc } from '../../lib/taskDoc.test-helper';
import type { TaskBucket } from '../../lib/taskStatus';
import {
  MilestoneMapView,
  type MilestoneMapViewProps,
  TASK_DRAW_CAP,
} from './MilestoneMap';

function task(id: string, status = 'ready', blockedBy: string[] = []) {
  return taskDoc({
    id,
    title: `Task ${id}`,
    status,
    blockedBy,
  }) as TaskListItem;
}

function group(epicId: string, label: string, tasks: TaskListItem[]) {
  return {
    key: `milestone:${epicId}`,
    kind: 'milestone',
    label,
    icon: null,
    rows: tasks.map((doc) => ({ doc, indent: 0 })),
    preset: {},
    milestoneId: epicId,
    archived: false,
  } as ListGroup;
}

const BUCKETS: Record<string, TaskBucket> = {
  a2: 'failed',
  a3: 'ready',
  b1: 'need-you',
  b2: 'working',
};

function mount(extra: Partial<MilestoneMapViewProps> = {}) {
  const opened: [string, TaskTab | undefined][] = [];
  return { opened, ...mountWith(opened, extra) };
}

function mountWith(
  opened: [string, TaskTab | undefined][],
  extra: Partial<MilestoneMapViewProps> = {}
) {
  return render(
    <MilestoneMapView
      groups={[
        group('m1', 'Checkout', [task('a1', 'landed'), task('a2'), task('a3')]),
        group('m2', 'Search', [task('b1', 'ready', ['a2']), task('b2')]),
      ]}
      bucketOf={(doc) => BUCKETS[doc.meta.id] ?? null}
      asksByTask={new Map([['b1', 2]])}
      projectKey="test"
      dueDateOf={(id) => (id === 'm2' ? '2026-11-03' : null)}
      onOpenTask={(id, tab) => opened.push([id, tab])}
      {...extra}
    />
  );
}

// The chart lays out asynchronously (elkjs), so nodes appear after the first render.
async function node(title: string): Promise<HTMLElement> {
  const found = (await screen.findAllByTestId('milestone-node')).find((el) =>
    el.textContent?.includes(title)
  );
  if (found === undefined) throw new Error(`no node ${title}`);
  return found;
}

/** A task's card once it is on the chart (a new layout may still be bringing it in). */
async function taskNode(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen
      .queryAllByTestId('chart-task')
      .find(
        (el) =>
          el.closest('[data-chart-node]')?.getAttribute('data-chart-node') ===
          id
      );
    if (found === undefined) throw new Error(`no task ${id}`);
    return found;
  });
}

function traceOf(id: string): string | null {
  return (
    document
      .querySelector(`[data-chart-node="${id}"]`)
      ?.getAttribute('data-trace') ?? null
  );
}

function inspector() {
  return within(screen.getByTestId('chart-inspector'));
}

function showTasks() {
  fireEvent.click(screen.getByRole('radio', { name: 'Tasks' }));
}

beforeEach(() => localStorage.clear());

describe('MilestoneMapView milestones', () => {
  test('a node shows landed over total and only the urgent counts it has', async () => {
    mount();
    const checkout = await node('Checkout');
    expect(checkout.textContent).toContain('1/3 landed');
    expect(checkout.textContent).not.toContain('%');
    // A zero counter is left out rather than drawn as "◐ 0".
    expect(within(checkout).queryByTestId('milestone-node-working')).toBeNull();
    expect(
      within(checkout).getByTestId('milestone-node-failed').textContent
    ).toBe('✕ 1');
    const search = await node('Search');
    expect(within(search).getByTestId('milestone-node-asks').textContent).toBe(
      '● 2'
    );
    expect(
      within(search).getByTestId('milestone-node-working').textContent
    ).toBe('◐ 1');
    expect(search.textContent).toContain('due');
  });

  test('a node names the next ready task to start', async () => {
    mount();
    const next = (await node('Checkout')).textContent ?? '';
    expect(next).toMatch(/Next\s*a3\s*Task a3/);
  });

  test('a wait across milestones is a counted edge in the summary', async () => {
    mount();
    await node('Search');
    expect(screen.getByTestId('milestone-map-summary').textContent).toContain(
      '1 wait between them'
    );
    const label = document.querySelector('[data-slot="graph-edge"] text');
    expect(label?.textContent).toBe('1');
  });

  test('selecting a milestone traces its neighbours and lists its tasks, most urgent first', async () => {
    mount();
    fireEvent.click(await node('Search'));
    expect(traceOf('m2')).toBe('sel');
    expect(traceOf('m1')).toBe('up');
    expect(
      document
        .querySelector('[data-slot="graph-edge"]')
        ?.getAttribute('data-tone')
    ).toBe('up');
    const rows = inspector().getAllByTestId('chart-inspector-task');
    // b1 waits on a2 behind the link, then the milestone's own tasks.
    expect(rows.map((r) => r.title)).toEqual(['Task b1', 'Task b1', 'Task b2']);
    expect(inspector().getByText('Checkout')).toBeTruthy();
    // Checkout has a failed task: its line is an attention line, and the legend keeps
    // saying so while a selection changes the lines' colours.
    expect(screen.getByTestId('chart-legend').textContent).toContain(
      'needs attention'
    );
  });

  test('the inspector opens the flight plan; a double-click on the node does too', async () => {
    const { opened } = mount();
    const select = await node('Search');
    fireEvent.click(select);
    fireEvent.click(inspector().getByTestId('milestone-node-open'));
    fireEvent.doubleClick(select);
    expect(opened).toEqual([
      ['m2', 'plan'],
      ['m2', 'plan'],
    ]);
  });

  test('a counted edge opens the task waits behind it', async () => {
    mount();
    await node('Search');
    fireEvent.click(
      screen.getByRole('button', { name: 'Search waits on Checkout 1 time' })
    );
    expect(inspector().getByText('Search waits on Checkout')).toBeTruthy();
    const rows = inspector().getAllByTestId('chart-inspector-task');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Task b1');
    expect(rows[0].textContent).toContain('waits on a2');
  });

  test('Escape on the chart clears the selection; a background click does too', async () => {
    mount();
    const select = await node('Search');
    const stage = screen.getByTestId('chart-stage');
    fireEvent.click(select);
    expect(traceOf('m2')).toBe('sel');
    fireEvent.keyDown(stage, { key: 'Escape' });
    expect(traceOf('m2')).toBeNull();
    expect(screen.getByTestId('chart-inspector-overview')).toBeTruthy();
    fireEvent.click(select);
    // A click that was not pressed on the canvas (a closing popover's) keeps the selection.
    fireEvent.click(stage);
    expect(traceOf('m2')).toBe('sel');
    fireEvent.pointerDown(stage);
    fireEvent.click(stage);
    expect(traceOf('m2')).toBeNull();
  });
});

describe('MilestoneMapView tasks', () => {
  test('draws the linked tasks with their milestone, and counts the unlinked ones', async () => {
    mount();
    showTasks();
    const drawn = (await screen.findAllByTestId('chart-task')).map((el) =>
      el.closest('[data-chart-node]')?.getAttribute('data-chart-node')
    );
    expect(drawn.sort()).toEqual(['a2', 'b1']);
    expect((await taskNode('b1')).textContent).toContain('Search');
    expect((await taskNode('a2')).getAttribute('data-state')).toBe('failed');
    expect(
      within(screen.getByTestId('chart-inspector-overview')).getByText(
        'Not on the chart'
      )
    ).toBeTruthy();
  });

  test('clicking a task traces what it unblocks; the inspector opens it', async () => {
    const { opened } = mount();
    showTasks();
    fireEvent.click(await taskNode('a2'));
    expect(traceOf('a2')).toBe('sel');
    expect(traceOf('b1')).toBe('down');
    expect(inspector().getByText('Unblocks')).toBeTruthy();
    expect(
      inspector()
        .getAllByTestId('chart-inspector-task')
        .map((r) => r.title)
    ).toEqual(['Task b1']);
    fireEvent.click(inspector().getByRole('button', { name: 'Open task' }));
    expect(opened).toEqual([['a2', undefined]]);
  });

  test('a preset highlights its set, turning on unlinked tasks it needs', async () => {
    mount();
    showTasks();
    await taskNode('a2');
    fireEvent.click(screen.getByTestId('chart-preset-ready'));
    // b1 waits on a2 (unfinished) so only a3 is ready, and a3 has no links.
    await waitFor(() => expect(traceOf('a3')).toBe('set'));
    expect(traceOf('a2')).toBe('dim');
    expect(inspector().getByText('Ready · 1')).toBeTruthy();
  });

  test('picking a task from the milestone inspector switches to Tasks and selects it', async () => {
    mount();
    fireEvent.click(await node('Checkout'));
    const a2 = inspector()
      .getAllByTestId('chart-inspector-task')
      .find((r) => r.title === 'Task a2');
    if (a2 === undefined) throw new Error('no a2 row');
    fireEvent.click(a2);
    await taskNode('a2');
    expect(traceOf('a2')).toBe('sel');
  });
});

// The default board, with a status changed or a link added per test.
function board(
  overrides: Record<string, { status?: string; blockedBy?: string[] }> = {}
): ListGroup[] {
  const t = (id: string, status: string, blockedBy: string[] = []) =>
    task(
      id,
      overrides[id]?.status ?? status,
      overrides[id]?.blockedBy ?? blockedBy
    );
  return [
    group('m1', 'Checkout', [
      t('a1', 'landed'),
      t('a2', 'ready'),
      t('a3', 'ready'),
    ]),
    group('m2', 'Search', [t('b1', 'ready', ['a2']), t('b2', 'ready')]),
  ];
}

/** The map over `groups`, rendered again with new data the way a live project updates. */
function live(
  groups: ListGroup[],
  buckets: Record<string, TaskBucket> = BUCKETS
) {
  const opened: [string, TaskTab | undefined][] = [];
  const element = (g: ListGroup[], b: Record<string, TaskBucket>) => (
    <MilestoneMapView
      groups={g}
      bucketOf={(doc) => b[doc.meta.id] ?? null}
      asksByTask={new Map()}
      projectKey="test"
      onOpenTask={(id, tab) => opened.push([id, tab])}
    />
  );
  const view = render(element(groups, buckets));
  return {
    opened,
    ...view,
    update: (g: ListGroup[], b: Record<string, TaskBucket> = buckets) =>
      view.rerender(element(g, b)),
  };
}

function remember(mode: 'milestones' | 'tasks', prefs: object = {}) {
  localStorage.setItem('dispatch:graph-mode:test', mode);
  localStorage.setItem('dispatch:graph-chart:test', JSON.stringify(prefs));
}

function storedPrefs(): Record<string, unknown> {
  return JSON.parse(
    localStorage.getItem('dispatch:graph-chart:test') ?? '{}'
  ) as Record<string, unknown>;
}

function layer(name: 'Task dependencies' | 'Milestone map'): HTMLElement {
  return screen.getByRole('group', { name });
}

/** A node's left/top on screen: its world position under the layer's transform. */
function screenAt(id: string): { x: number; y: number } {
  const node = document.querySelector<HTMLElement>(`[data-chart-node="${id}"]`);
  const match =
    /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(
      layer('Task dependencies').style.transform
    );
  if (node === null || match === null) throw new Error(`no node ${id}`);
  const [x, y, k] = match.slice(1).map(Number);
  return {
    x: parseFloat(node.style.left) * k + x,
    y: parseFloat(node.style.top) * k + y,
  };
}

describe('MilestoneMapView search, keys and display', () => {
  test('a search pick of an unlinked task switches to Tasks, reveals and selects it, and remembers', async () => {
    mount();
    await node('Checkout');
    fireEvent.keyDown(screen.getByTestId('chart-stage'), { key: '/' });
    const input = await screen.findByPlaceholderText(
      'Find a task or milestone'
    );
    fireEvent.change(input, { target: { value: 'a3' } });
    const option = (await screen.findAllByRole('option')).find((o) =>
      o.textContent?.includes('Task a3')
    );
    if (option === undefined) throw new Error('no a3 option');
    fireEvent.click(option);
    await taskNode('a3');
    expect(traceOf('a3')).toBe('sel');
    expect(storedPrefs().showUnlinked).toBe(true);
    expect(localStorage.getItem('dispatch:graph-mode:test')).toBe('tasks');
  });

  test('+ and 0 on the canvas zoom and fit; typing in search does not', async () => {
    remember('tasks');
    live(board());
    await taskNode('a2');
    const stage = screen.getByTestId('chart-stage');
    fireEvent.keyDown(stage, { key: '+' });
    expect(layer('Task dependencies').style.transform).toContain('scale(1.35)');
    fireEvent.keyDown(stage, { key: '0' });
    expect(layer('Task dependencies').style.transform).toContain('scale(1)');
    fireEvent.keyDown(stage, { key: '/' });
    const input = await screen.findByPlaceholderText(
      'Find a task or milestone'
    );
    fireEvent.keyDown(input, { key: '+' });
    expect(layer('Task dependencies').style.transform).toContain('scale(1)');
  });

  test('Box by milestone draws a box per milestone, labelled', async () => {
    remember('tasks', { grouped: true });
    live(board());
    await taskNode('a2');
    const boxes = Array.from(
      document.querySelectorAll('[data-slot="graph-group"]')
    );
    expect(boxes.map((b) => b.textContent)).toEqual(['Checkout', 'Search']);
  });

  test('with landed tasks hidden and nothing else linked, it says so and offers them back', async () => {
    remember('tasks', { hideLanded: true });
    live(
      board({
        a2: { status: 'landed', blockedBy: ['a1'] },
        b1: { blockedBy: [] },
      })
    );
    expect(
      await screen.findByText('Every linked task has landed')
    ).toBeTruthy();
    expect(screen.queryByTestId('chart-message')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show landed tasks' }));
    await taskNode('a2');
    expect(storedPrefs().hideLanded).toBe(false);
  });

  test('an empty board shows the empty state for each view', () => {
    remember('tasks');
    const first = live([]);
    expect(screen.getByText('No tasks yet')).toBeTruthy();
    first.unmount();
    remember('milestones');
    live([]);
    expect(screen.getByText('No milestones yet')).toBeTruthy();
  });
});

describe('MilestoneMapView with live data', () => {
  test('a data change that moves the layout keeps a view the user zoomed', async () => {
    remember('tasks');
    const view = live(board());
    await taskNode('a2');
    fireEvent.wheel(screen.getByTestId('chart-stage'), { deltaY: -100 });
    const zoomed = layer('Task dependencies').style.transform;
    expect(zoomed).not.toContain('scale(1)');
    view.update(board({ b2: { blockedBy: ['a3'] } }));
    await taskNode('b2');
    expect(layer('Task dependencies').style.transform).toBe(zoomed);
  });

  test('a data change keeps the selected task where it was on screen', async () => {
    remember('tasks');
    const view = live(board());
    fireEvent.click(await taskNode('b1'));
    const before = screenAt('b1');
    view.update(
      board({ b1: { blockedBy: ['a2', 'a3'] }, b2: { blockedBy: ['a3'] } })
    );
    await taskNode('b2');
    const after = screenAt('b1');
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
    expect(traceOf('b1')).toBe('sel');
  });

  test('a selection whose task is dropped clears instead of fading the chart', async () => {
    remember('tasks');
    const view = live(board());
    fireEvent.click(await taskNode('b1'));
    expect(traceOf('a2')).toBe('up');
    view.update(
      board({ b1: { status: 'dropped' }, b2: { blockedBy: ['a2'] } })
    );
    await taskNode('b2');
    await waitFor(() => expect(traceOf('a2')).toBeNull());
    expect(screen.getByTestId('chart-inspector-overview')).toBeTruthy();
  });

  test('a preset follows the data, stays pressed (and releasable) once it empties, then hides', async () => {
    remember('tasks');
    const view = live(board());
    await taskNode('a2');
    const moving = screen.getByTestId('chart-preset-moving');
    fireEvent.click(moving);
    await waitFor(() => expect(traceOf('b2')).toBe('set'));
    view.update(board({ b2: { status: 'landed' } }), {
      ...BUCKETS,
      b2: 'ready',
    });
    await waitFor(() => expect(moving.textContent).toBe('In progress 0'));
    expect(moving.getAttribute('aria-pressed')).toBe('true');
    expect(moving.hasAttribute('disabled')).toBe(false);
    expect(inspector().getByText('In progress · 0')).toBeTruthy();
    fireEvent.click(moving);
    // Let go while empty, the chip leaves the toolbar with the other empty ones.
    expect(screen.queryByTestId('chart-preset-moving')).toBeNull();
    expect(screen.getByTestId('chart-inspector-overview')).toBeTruthy();
  });

  test('picking a landed task the chart cannot draw opens it instead', async () => {
    const { opened } = mount();
    fireEvent.click(await node('Checkout'));
    const a1 = inspector()
      .getAllByTestId('chart-inspector-task')
      .find((r) => r.title === 'Task a1');
    if (a1 === undefined) throw new Error('no a1 row');
    fireEvent.click(a1);
    expect(opened).toEqual([['a1', undefined]]);
    expect(screen.getAllByTestId('milestone-node')).toHaveLength(2);
    expect(storedPrefs().showUnlinked).toBeUndefined();
  });
});

function viewNames(): string[] {
  const group = screen.getByRole('radiogroup', { name: 'Graph of' });
  return within(group)
    .getAllByRole('radio')
    .map((b) => b.textContent ?? '');
}

describe('MilestoneMapView views', () => {
  test('the switch offers Milestones and Tasks', async () => {
    mount();
    expect(viewNames()).toEqual(['Milestones', 'Tasks']);
    await screen.findAllByTestId('milestone-node');
  });

  test('the choice is remembered per project and restored', async () => {
    const first = mount();
    await node('Checkout');
    showTasks();
    first.unmount();
    mount();
    await taskNode('a2');
  });

  test('a remembered view it no longer knows falls back to Milestones', async () => {
    localStorage.setItem('dispatch:graph-mode:test', 'live');
    mount();
    expect(await screen.findAllByTestId('milestone-node')).toHaveLength(2);
  });

  test('a task named on arrival opens the Tasks chart with it selected', async () => {
    mount({ arrivalTaskId: 'b1' });
    await taskNode('b1');
    await waitFor(() => expect(traceOf('b1')).toBe('sel'));
  });
});

describe('MilestoneMapView draw cap', () => {
  test('past the cap the Tasks chart is not laid out; the host’s narrowing stands in', () => {
    remember('tasks');
    const chain = Array.from({ length: TASK_DRAW_CAP + 1 }, (_, i) =>
      task(`c${i}`, 'ready', i === 0 ? [] : [`c${i - 1}`])
    );
    render(
      <MilestoneMapView
        groups={[group('m1', 'Big', chain)]}
        bucketOf={() => null}
        asksByTask={new Map()}
        projectKey="test"
        renderTooLarge={(count) => (
          <p data-testid="too-large">{`${count} to draw`}</p>
        )}
        onOpenTask={() => {}}
      />
    );
    expect(screen.getByTestId('too-large').textContent).toBe(
      `${TASK_DRAW_CAP + 1} to draw`
    );
    expect(screen.queryByTestId('chart-stage')).toBeNull();
  });
});

describe('MilestoneMapView cards above milestones', () => {
  const PROJECT = {
    one: 'project',
    many: 'projects',
    drill: 'Show its milestones',
  };

  test('a unit renames the cards, and a double-click drills instead of opening', async () => {
    const drilled: string[] = [];
    const { opened } = mount({
      views: ['milestones'],
      unit: PROJECT,
      onDrill: (id) => drilled.push(id),
    });
    fireEvent.doubleClick(await node('Search'));
    expect(drilled).toEqual(['m2']);
    expect(opened).toEqual([]);
    expect(screen.getByTestId('milestone-map-summary').textContent).toMatch(
      /^2 projects · /
    );
    // No Tasks view here: no switch, and no way onto it from the inspector.
    expect(screen.queryByRole('radiogroup', { name: 'Graph of' })).toBeNull();
    fireEvent.click(await node('Search'));
    const inspector = screen.getByTestId('chart-inspector');
    expect(within(inspector).getByText('Project')).toBeTruthy();
    expect(
      within(inspector).queryByRole('button', { name: 'Show its tasks' })
    ).toBeNull();
    fireEvent.click(
      within(inspector).getByRole('button', { name: 'Show its milestones' })
    );
    expect(drilled).toEqual(['m2', 'm2']);
    fireEvent.click(
      within(inspector).getByRole('button', { name: 'Open project' })
    );
    expect(opened).toEqual([['m2', 'plan']]);
  });

  test('Box by … frames each card in its parent', async () => {
    mount({
      views: ['milestones'],
      cardParents: {
        of: new Map([
          ['m1', { id: 'p1', label: 'Storefront' }],
          ['m2', { id: 'p1', label: 'Storefront' }],
        ]),
        one: 'project',
      },
    });
    await node('Search');
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Box by project' }));
    await waitFor(() =>
      expect(
        Array.from(
          document.querySelectorAll('[data-slot=graph-group] text'),
          (t) => t.textContent
        )
      ).toEqual(['Storefront'])
    );
  });
});

describe('MilestoneMapView chrome', () => {
  test('the toolbar chips carry the counts; help and Mermaid sit behind buttons', async () => {
    mount();
    await node('Search');
    // The overview lists, with no stat tiles repeating the chips.
    const overview = screen.getByTestId('chart-inspector-overview');
    expect(overview.querySelector('dl')).toBeNull();
    expect(screen.queryByTestId('chart-help')).toBeNull();
    expect(screen.queryByText('Copy as Mermaid')).toBeNull();
    fireEvent.click(screen.getByTestId('chart-help-toggle'));
    expect(screen.getByTestId('chart-help').textContent).toContain(
      'to see its neighbours'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    expect(screen.getByTestId('chart-copy-mermaid').textContent).toBe(
      'Copy as Mermaid'
    );
  });

  test('compact: the view switch and Open in Graph, no Find, chips, Display or inspector', async () => {
    mount({ variant: 'compact', graphHref: '#/graph?milestone=m1' });
    const search = await node('Search');
    expect(screen.getByRole('radio', { name: 'Tasks' })).toBeTruthy();
    expect(screen.queryByTestId('chart-search')).toBeNull();
    expect(screen.queryByTestId('chart-preset-chain')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Display' })).toBeNull();
    expect(screen.queryByTestId('milestone-map-summary')).toBeNull();
    expect(screen.queryByTestId('chart-inspector')).toBeNull();
    expect(screen.getByTestId('chart-open-graph').getAttribute('href')).toBe(
      '#/graph?milestone=m1'
    );
    // A selection still opens the inspector, for the host's verbs.
    fireEvent.click(search);
    expect(screen.getByTestId('chart-inspector')).toBeTruthy();
  });

  test('compact with one view and no link draws no toolbar at all', async () => {
    mount({ variant: 'compact', views: ['tasks'] });
    await taskNode('b1');
    expect(screen.queryByTestId('chart-toolbar')).toBeNull();
  });
});
