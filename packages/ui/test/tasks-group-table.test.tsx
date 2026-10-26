import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';

import {
  parseCollapsed,
  serializeCollapsed,
  type TaskColumnId,
  type TaskGroupData,
  TaskGroupTable,
  type TaskRowData,
  type TaskSectionData,
  toggleCollapsed,
  type UiLinkProps,
  UiLinkProvider,
} from '../src/index';

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
});

function HostLink({ children, ...rest }: UiLinkProps) {
  return (
    <a {...rest} data-host-link="">
      {children}
    </a>
  );
}

function row(id: string, extra: Partial<TaskRowData> = {}): TaskRowData {
  return {
    id,
    key: id.toUpperCase(),
    title: `Issue ${id}`,
    href: `/issues/${id}`,
    project: 'Atlas',
    state: 'Todo',
    stateKind: 'unstarted',
    priority: 3,
    priorityLabel: 'Medium',
    due: 'Oct 23',
    ...extra,
  };
}

const SECTIONS: TaskSectionData[] = [
  {
    id: 'week',
    label: 'This week',
    groups: [
      {
        id: 'g1',
        eyebrow: 'Atlas',
        title: 'Cutover',
        href: '/timeline?milestone=g1',
        status: 'overdue',
        statusLabel: 'Overdue',
        dueLabel: 'Oct 19',
        daysLeftLabel: '2 days overdue',
        dueTone: 'danger',
        progress: { done: 4, total: 7 },
        rows: [
          row('a-1', {
            chips: [
              {
                label: 'New — given to you because you lead Atlas',
                tone: 'accent',
              },
            ],
          }),
          row('a-2', {
            stateKind: 'started',
            state: 'In Progress',
            priority: 1,
            priorityLabel: 'Urgent',
          }),
        ],
      },
      {
        id: 'g2',
        eyebrow: 'Beacon',
        title: 'Public beta',
        rows: [
          row('b-1', {
            href: 'https://linear.app/x/issue/B-1',
            external: true,
            stateKind: 'triage',
            state: 'Triage',
          }),
        ],
      },
    ],
  },
  {
    id: 'none',
    label: 'No milestone',
    groups: [{ id: 'g3', title: 'Unplanned', rows: [row('c-1')] }],
  },
];

function renderTable(
  props: Partial<Parameters<typeof TaskGroupTable>[0]> = {}
) {
  return render(
    <UiLinkProvider link={HostLink}>
      <TaskGroupTable sections={SECTIONS} label="My issues" {...props} />
    </UiLinkProvider>
  );
}

const toggleOf = (name: string) => (el: ReturnType<typeof renderTable>) =>
  el.getByRole('button', { name });

describe('TaskGroupTable structure', () => {
  test('sections and groups are headings; rows are links via the host', () => {
    const view = renderTable();
    expect(view.getByRole('group', { name: 'My issues' })).toBeTruthy();
    expect(view.getByRole('heading', { name: /This week/ })).toBeTruthy();
    expect(view.getByRole('heading', { name: /No milestone/ })).toBeTruthy();
    const link = view.getByRole('link', { name: 'Issue a-1' });
    expect(link.getAttribute('href')).toBe('/issues/a-1');
    expect(link.hasAttribute('data-host-link')).toBe(true);
    // The milestone title links through the host too.
    const group = view.getByRole('link', { name: 'Cutover' });
    expect(group.getAttribute('href')).toBe('/timeline?milestone=g1');
    expect(group.hasAttribute('data-host-link')).toBe(true);
  });

  test('section notes count issues', () => {
    const view = renderTable();
    expect(
      view.getByRole('heading', { name: /This week/ }).textContent
    ).toContain('3 issues');
  });

  test('group header carries status, due, days left and progress', () => {
    const view = renderTable();
    const header = view.container.querySelector('[data-group-id="g1"]');
    expect(header).not.toBeNull();
    const scope = within(header as HTMLElement);
    expect(scope.getByRole('img', { name: 'Overdue' })).toBeTruthy();
    expect(header?.textContent).toContain('Oct 19');
    expect(header?.textContent).toContain('2 days overdue');
    expect(
      scope
        .getByRole('progressbar', { name: 'Cutover progress' })
        .getAttribute('aria-valuetext')
    ).toBe('4 of 7 done');
  });

  test('chips and meta cells are readable text with column labels', () => {
    const view = renderTable();
    const item = view.getByRole('link', { name: 'Issue a-1' }).closest('li');
    const text = item?.textContent ?? '';
    expect(text).toContain('New — given to you because you lead Atlas');
    expect(text).toContain('State: Todo');
    expect(text).toContain('Priority: Medium');
    expect(text).toContain('Project: Atlas');
    expect(text).toContain('Due: Oct 23');
  });

  test('external rows open a new tab with a screen-reader note', () => {
    const view = renderTable();
    const link = view.getByRole('link', { name: /Issue b-1/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.textContent).toContain('(opens in a new tab)');
    // Absolute URLs bypass the host router (Link renders a plain anchor).
    expect(link.hasAttribute('data-host-link')).toBe(false);
  });

  test('a row can carry a separate ↗ link beside an in-app title', () => {
    const onOpenRow = mock((_row: TaskRowData, _group: TaskGroupData) => {});
    const sections: TaskSectionData[] = [
      {
        id: 'week',
        label: 'This week',
        groups: [
          {
            id: 'g1',
            title: 'Cutover',
            rows: [
              row('a-1', {
                href: '/week?issue=A-1',
                externalHref: 'https://linear.app/x/issue/A-1',
                externalLabel: 'Open A-1 in Linear',
              }),
              row('a-2'),
            ],
          },
        ],
      },
    ];
    const view = renderTable({ sections, onOpenRow });
    const title = view.getByRole('link', { name: 'Issue a-1' });
    expect(title.getAttribute('href')).toBe('/week?issue=A-1');
    expect(title.getAttribute('target')).toBeNull();
    const out = view.getByRole('link', { name: 'Open A-1 in Linear' });
    expect(out.getAttribute('href')).toBe('https://linear.app/x/issue/A-1');
    expect(out.getAttribute('target')).toBe('_blank');
    expect(out.getAttribute('rel')).toContain('noopener');
    // The title keeps the row's own behaviour; the icon is its own link,
    // outside the title's nav target.
    fireEvent.click(title);
    expect(onOpenRow).toHaveBeenCalledTimes(1);
    expect(out.closest('[data-nav-target]')).toBeNull();
    expect(title.closest('[data-nav-target]')).not.toBeNull();
    // Rows without one draw no extra link.
    expect(view.queryByRole('link', { name: /A-2 in/ })).toBeNull();
    // The title and the ↗ share one no-wrap run (a word joiner cannot
    // hold an atomic inline), so a wrapped title never leaves the icon on
    // a line of its own; a row without a ↗ has no run and no glued word.
    const run = out.parentElement;
    expect(run?.contains(title)).toBe(true);
    expect(run?.querySelectorAll('a')).toHaveLength(2);
    expect(out.previousSibling).toBe(title.closest('[data-nav-target]'));
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'tasks',
        'task-group-table.module.css'
      ),
      'utf8'
    );
    expect(css).toMatch(
      /\.titleRun,\s*\.titleRun \.titleText,\s*\.titleRun \.titleLink,\s*\.titleTail \{\s*white-space: nowrap;\s*\}/
    );
    expect(css).toMatch(/\.titleHead \{\s*white-space: normal;\s*\}/);
    // A break before an atomic inline is closed only when every box
    // ending in front of it is no-wrap: the words before the last wrap in
    // a span of their own, the last one stays with the ↗.
    expect(title.textContent).toBe('Issue a-1');
    expect([...title.children].map((span) => span.textContent)).toEqual([
      'Issue ',
      'a-1',
    ]);
    // A row without one keeps its title straight in the title cell.
    const plain = view.getByRole('link', { name: 'Issue a-2' });
    const target = plain.closest('[data-nav-target]');
    expect(
      target?.parentElement?.querySelector('a[target="_blank"]')
    ).toBeNull();
    expect(plain.querySelector('span')).toBeNull();
  });

  test('rows stack by the table’s own width, not the viewport’s', () => {
    // In the sidebar shell a 1024px window leaves the week table ~680px
    // wide: a viewport query kept three fixed columns and a 70px title.
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'tasks',
        'task-group-table.module.css'
      ),
      'utf8'
    );
    expect(css).toContain('container: task-table / inline-size;');
    expect(css).toMatch(/@container task-table \(width < 720px\)/);
    expect(css).not.toMatch(/@media \(width <= 900px\)/);
  });

  test('columns are configurable', () => {
    const view = renderTable({ columns: ['due'] });
    const item = view.getByRole('link', { name: 'Issue a-1' }).closest('li');
    expect(item?.textContent).toContain('Due: Oct 23');
    expect(item?.textContent).not.toContain('Project:');
  });

  test('renders the empty message when there are no groups', () => {
    const view = render(
      <TaskGroupTable sections={[]} emptyMessage="Nothing assigned to you" />
    );
    expect(view.getByText('Nothing assigned to you')).toBeTruthy();
    expect(view.queryByRole('group')).toBeNull();
  });
});

describe('TaskGroupTable collapse', () => {
  test('the toggle is a disclosure that hides and shows rows', () => {
    const onToggleGroup = mock((_id: string, _c: boolean) => {});
    const view = renderTable({ onToggleGroup });
    const toggle = toggleOf('Atlas, Cutover')(view);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(
      toggle.getAttribute('aria-controls') ?? ''
    );
    expect(list?.tagName).toBe('UL');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByRole('link', { name: 'Issue a-1' })).toBeNull();
    expect(list?.hasAttribute('hidden')).toBe(true);
    expect(onToggleGroup).toHaveBeenCalledWith('g1', true);
    fireEvent.click(toggle);
    expect(view.getByRole('link', { name: 'Issue a-1' })).toBeTruthy();
  });

  test('defaultCollapsed applies when nothing is stored', () => {
    const view = renderTable({ defaultCollapsed: ['g2'] });
    expect(
      toggleOf('Beacon, Public beta')(view).getAttribute('aria-expanded')
    ).toBe('false');
    expect(view.queryByRole('link', { name: /Issue b-1/ })).toBeNull();
  });

  test('folds persist under storageKey and survive a remount', () => {
    const first = renderTable({ storageKey: 'test:folds' });
    fireEvent.click(toggleOf('Atlas, Cutover')(first));
    expect(localStorage.getItem('test:folds')).toBe('["g1"]');
    first.unmount();

    const second = renderTable({ storageKey: 'test:folds' });
    expect(
      toggleOf('Atlas, Cutover')(second).getAttribute('aria-expanded')
    ).toBe('false');
    expect(second.queryByRole('link', { name: 'Issue a-1' })).toBeNull();
  });

  test('session storage is honoured when asked for', () => {
    const view = renderTable({
      storageKey: 'test:session',
      storage: 'session',
    });
    fireEvent.click(toggleOf('Beacon, Public beta')(view));
    expect(sessionStorage.getItem('test:session')).toBe('["g2"]');
    expect(localStorage.getItem('test:session')).toBeNull();
    sessionStorage.clear();
  });

  test('a stored value wins over defaultCollapsed; corrupt storage means none', () => {
    localStorage.setItem('test:corrupt', '{not json');
    const view = renderTable({
      storageKey: 'test:corrupt',
      defaultCollapsed: ['g1'],
    });
    expect(toggleOf('Atlas, Cutover')(view).getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  test('collapse helpers are pure and stable', () => {
    expect(parseCollapsed('["b","a"]')).toEqual(new Set(['a', 'b']));
    expect(parseCollapsed('[1,"x"]')).toEqual(new Set(['x']));
    expect(parseCollapsed('nope')).toEqual(new Set());
    expect(serializeCollapsed(new Set(['b', 'a']))).toBe('["a","b"]');
    const base = new Set(['a']);
    expect(toggleCollapsed(base, 'a')).toEqual(new Set());
    expect(toggleCollapsed(base, 'b')).toEqual(new Set(['a', 'b']));
    expect(base).toEqual(new Set(['a']));
  });
});

describe('TaskGroupTable keyboard', () => {
  test('↑/↓ and j/k move between toggles and rows; Home/End jump', () => {
    const view = renderTable();
    const root = view.getByRole('group', { name: 'My issues' });
    const cutover = toggleOf('Atlas, Cutover')(view);
    cutover.focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-1' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'j' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-2' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(toggleOf('Beacon, Public beta')(view));
    fireEvent.keyDown(document.activeElement as Element, { key: 'k' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-2' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue c-1' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toBe(cutover);
    // ↑ at the top stays put rather than wrapping.
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cutover);
    expect(root.contains(document.activeElement)).toBe(true);
  });

  test('← goes to the group, then collapses it; → expands, then enters', () => {
    const view = renderTable();
    const link = view.getByRole('link', { name: 'Issue a-2' });
    const toggle = toggleOf('Atlas, Cutover')(view);
    link.focus();
    fireEvent.keyDown(link, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(toggle, { key: 'ArrowLeft' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed rows are skipped by ↓.
    fireEvent.keyDown(toggle, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(toggleOf('Beacon, Public beta')(view));
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'ArrowRight' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(toggle, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-1' })
    );
  });

  test('keys with modifiers are left to the host', () => {
    const view = renderTable();
    const toggle = toggleOf('Atlas, Cutover')(view);
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'ArrowDown', metaKey: true });
    expect(document.activeElement).toBe(toggle);
  });
});

describe('TaskGroupTable callbacks', () => {
  test('onOpenRow takes plain clicks; modified clicks stay native', () => {
    const onOpenRow = mock((_r: TaskRowData, _g: TaskGroupData) => {});
    const view = renderTable({ onOpenRow });
    const link = view.getByRole('link', { name: 'Issue a-1' });
    const plain = fireEvent.click(link);
    expect(plain).toBe(false); // default prevented
    expect(onOpenRow).toHaveBeenCalledTimes(1);
    expect(onOpenRow.mock.calls[0][0].id).toBe('a-1');
    expect(onOpenRow.mock.calls[0][1].id).toBe('g1');
    const modified = fireEvent.click(link, { metaKey: true });
    expect(modified).toBe(true);
    expect(onOpenRow).toHaveBeenCalledTimes(1);
  });

  test('rows without href are buttons that call onOpenRow', () => {
    const onOpenRow = mock((_r: TaskRowData, _g: TaskGroupData) => {});
    const view = render(
      <TaskGroupTable
        onOpenRow={onOpenRow}
        sections={[
          {
            id: 's',
            label: 'Tasks',
            groups: [
              {
                id: 'g',
                title: 'Ready',
                rows: [row('t-1', { href: undefined })],
              },
            ],
          },
        ]}
      />
    );
    fireEvent.click(view.getByRole('button', { name: 'Issue t-1' }));
    expect(onOpenRow).toHaveBeenCalledTimes(1);
  });

  test('onOpenGroup takes the group title click', () => {
    const onOpenGroup = mock((_g: TaskGroupData) => {});
    const view = renderTable({ onOpenGroup });
    fireEvent.click(view.getByRole('link', { name: 'Cutover' }));
    expect(onOpenGroup).toHaveBeenCalledTimes(1);
    expect(onOpenGroup.mock.calls[0][0].id).toBe('g1');
  });
});

// The table's markup with React's generated ids (useId) replaced by
// stable placeholders, so the snapshot does not depend on test order.
function stableMarkup(container: HTMLElement): string {
  const seen = new Map<string, string>();
  return container.innerHTML.replace(/_r_[0-9a-z]+_|«r[0-9a-z]+»/g, (id) => {
    let stable = seen.get(id);
    if (stable === undefined) {
      stable = `react-id-${seen.size}`;
      seen.set(id, stable);
    }
    return stable;
  });
}

describe('TaskGroupTable without the issue list props', () => {
  test('My week’s props render the same DOM as before the additions', () => {
    // The props week-issues.tsx passes: sections, columns, a label, a
    // heading level, a storage key, the empty message, onOpenRow and the
    // open row. The snapshot was taken before selection, drag and the
    // slots were added; none of them may change this markup. It was
    // re-taken when the status colours came in (architecture §8.2): the
    // overdue date's data-tone is danger, StatusMark carries data-status
    // and a muted group's progress rule is the inactive grey; and when a
    // row's ↗ joined its title in one no-wrap run (the word joiner before
    // it went: it could not keep the icon on the title's line).
    const sections: TaskSectionData[] = [
      ...SECTIONS,
      {
        id: 'later',
        label: 'Later',
        groups: [
          {
            id: 'quiet',
            eyebrow: 'Fjord',
            title: 'Dashboards',
            status: 'overdue',
            statusLabel: 'Overdue · inactive project',
            dueLabel: 'Oct 16',
            daysLeftLabel: 'Inactive project',
            dueTone: 'danger',
            progress: { done: 0, total: 2, tone: 'danger' },
            muted: true,
            rows: [
              row('f-1', {
                href: '/week?issue=F-1',
                externalHref: 'https://linear.app/x/issue/F-1',
                externalLabel: 'Open F-1 in Linear',
                dueTone: 'danger',
              }),
            ],
          },
          { id: 'empty', title: 'Quiet', rows: [] },
        ],
      },
      { id: 'nothing', label: 'Nothing', emptyLabel: 'None yet.', groups: [] },
    ];
    const view = renderTable({
      sections,
      columns: ['project', 'state', 'priority', 'due'],
      headingLevel: 2,
      storageKey: 'test:week-dom',
      emptyMessage: 'Nothing assigned to you',
      onOpenRow: () => undefined,
      activeRowId: 'a-2',
    });
    expect(stableMarkup(view.container)).toMatchSnapshot();
  });
});

describe('TaskGroupTable review additions', () => {
  test('folding a group while focus sits in its rows hands focus to its toggle', () => {
    const view = renderTable();
    const link = view.getByRole('link', { name: 'Issue a-2' });
    const toggle = toggleOf('Atlas, Cutover')(view);
    link.focus();
    expect(document.activeElement).toBe(link);
    // A pointer (or host) fold while a row has focus: the rows unmount, so
    // focus must not fall back to <body>.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  test('two tables on one key stay in step, and so do other tabs', () => {
    renderTable({ storageKey: 'test:sync' });
    render(
      <TaskGroupTable
        sections={SECTIONS}
        label="Second"
        storageKey="test:sync"
      />
    );
    // Both tables are in document.body, so every query is scoped.
    const toggleIn = (table: string, name: string) =>
      within(
        within(document.body).getByRole('group', { name: table })
      ).getByRole('button', { name });
    fireEvent.click(toggleIn('My issues', 'Atlas, Cutover'));
    expect(
      toggleIn('Second', 'Atlas, Cutover').getAttribute('aria-expanded')
    ).toBe('false');
    // Another document writes the key: the 'storage' event re-reads it.
    localStorage.setItem('test:sync', '["g2"]');
    act(() => {
      window.dispatchEvent(new Event('storage'));
    });
    expect(
      toggleIn('Second', 'Atlas, Cutover').getAttribute('aria-expanded')
    ).toBe('true');
    expect(
      toggleIn('My issues', 'Beacon, Public beta').getAttribute('aria-expanded')
    ).toBe('false');
  });

  test('blocked storage never throws; the fold still works for the session', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      const view = renderTable({ storageKey: 'test:blocked' });
      const toggle = toggleOf('Atlas, Cutover')(view);
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  test('headingLevel sets sections and groups one level apart', () => {
    const view = renderTable({ headingLevel: 2 });
    expect(
      view.getByRole('heading', { level: 2, name: /This week/ })
    ).toBeTruthy();
    expect(
      view.getByRole('heading', { level: 3, name: /Cutover/ })
    ).toBeTruthy();
  });

  test('activeRowId marks the open row current', () => {
    const view = renderTable({ activeRowId: 'a-2' });
    const item = view.getByRole('link', { name: 'Issue a-2' }).closest('li');
    expect(item?.getAttribute('aria-current')).toBe('true');
    const other = view.getByRole('link', { name: 'Issue a-1' }).closest('li');
    expect(other?.hasAttribute('aria-current')).toBe(false);
  });

  test('onRowKeyDown gets keys the table leaves alone, modified ones too', () => {
    const seen: string[] = [];
    const onRowKeyDown = mock(
      (event: { key: string; metaKey: boolean }, r: TaskRowData) => {
        seen.push(`${event.metaKey ? 'meta+' : ''}${event.key}:${r.id}`);
      }
    );
    const view = renderTable({ onRowKeyDown });
    const link = view.getByRole('link', { name: 'Issue a-1' });
    link.focus();
    fireEvent.keyDown(link, { key: 'x' });
    fireEvent.keyDown(link, { key: 'c', metaKey: true });
    // Navigation keys stay the table's and are not forwarded.
    fireEvent.keyDown(link, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-2' })
    );
    // A modified arrow is not navigation; it reaches the host instead.
    fireEvent.keyDown(document.activeElement as Element, {
      key: 'ArrowDown',
      metaKey: true,
    });
    // Keys on a group toggle are not row commands.
    fireEvent.keyDown(toggleOf('Atlas, Cutover')(view), { key: 'x' });
    expect(seen).toEqual(['x:a-1', 'meta+c:a-1', 'meta+ArrowDown:a-2']);
  });

  test('the project cell is flagged when it repeats the group heading', () => {
    const view = renderTable({
      sections: [
        {
          id: 's',
          label: 'This week',
          groups: [
            {
              id: 'g',
              eyebrow: 'Atlas',
              title: 'Cutover',
              rows: [row('r-1'), row('r-2', { project: 'Beacon' })],
            },
          ],
        },
      ],
    });
    const cellOf = (name: string) =>
      view
        .getByRole('link', { name })
        .closest('li')
        ?.querySelector('[data-column="project"]');
    expect(cellOf('Issue r-1')?.hasAttribute('data-repeats-heading')).toBe(
      true
    );
    expect(cellOf('Issue r-2')?.hasAttribute('data-repeats-heading')).toBe(
      false
    );
  });

  test('a section without groups says so; a group without rows says so', () => {
    const view = renderTable({
      sections: [
        { id: 'empty', label: 'Later', groups: [] },
        {
          id: 's',
          label: 'This week',
          groups: [{ id: 'g', title: 'Quiet', rows: [] }],
        },
      ],
    });
    expect(view.getByText('Nothing in this section')).toBeTruthy();
    expect(view.getByText('No open issues')).toBeTruthy();
  });

  test('an empty section can say its own sentence', () => {
    const view = renderTable({
      sections: [
        {
          id: 'week',
          label: 'This week',
          emptyLabel: 'Nothing of yours is due this week.',
          groups: [],
        },
        {
          id: 'later',
          label: 'Later',
          groups: [{ id: 'g', title: 'Cutover', rows: [row('l-1')] }],
        },
      ],
    });
    expect(view.getByText('Nothing of yours is due this week.')).toBeTruthy();
    expect(view.queryByText('Nothing in this section')).toBeNull();
  });

  test('a muted group is never loud: grey mark, no status date, grey progress', () => {
    const view = renderTable({
      sections: [
        {
          id: 'week',
          label: 'This week',
          groups: [
            {
              id: 'quiet',
              eyebrow: 'Fjord',
              title: 'Dashboards',
              status: 'overdue',
              statusLabel: 'Overdue · inactive project',
              dueLabel: 'Oct 16',
              daysLeftLabel: 'Inactive project',
              dueTone: 'danger',
              progress: { done: 0, total: 2, tone: 'danger' },
              muted: true,
              rows: [row('f-1')],
            },
            {
              id: 'loud',
              title: 'Cutover',
              status: 'overdue',
              statusLabel: 'Overdue',
              dueLabel: 'Oct 19',
              dueTone: 'danger',
              progress: { done: 1, total: 2, tone: 'danger' },
              rows: [row('a-1')],
            },
          ],
        },
      ],
    });
    const header = (id: string) => {
      const el = view.container.querySelector(
        `[data-group-id="${id}"] [data-nav-item="group"]`
      );
      if (el === null) throw new Error(`no group ${id}`);
      return el;
    };
    const quiet = header('quiet');
    const quietMark = within(quiet as HTMLElement).getByRole('img', {
      name: 'Overdue · inactive project',
    });
    expect(quietMark.hasAttribute('data-muted')).toBe(true);
    const tones = (el: Element) =>
      [...el.querySelectorAll('[data-tone]')].map((n) =>
        n.getAttribute('data-tone')
      );
    // The due date (ink), then the progress rule (the inactive grey).
    expect(tones(quiet)).toEqual(['default', 'muted']);
    const loud = header('loud');
    expect(
      within(loud as HTMLElement)
        .getByRole('img', { name: 'Overdue' })
        .hasAttribute('data-muted')
    ).toBe(false);
    expect(tones(loud)).toEqual(['danger', 'danger']);
  });
});

/* ---- the issue list's additions ------------------------------------------ */

/** A host that owns the selection, as the Issues page does. */
function SelectHost({
  sections = SECTIONS,
  initial = [],
  onSelection,
  ...rest
}: Partial<Parameters<typeof TaskGroupTable>[0]> & {
  initial?: string[];
  onSelection?: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initial)
  );
  return (
    <UiLinkProvider link={HostLink}>
      <TaskGroupTable
        sections={sections}
        label="Issues"
        {...rest}
        selection={{
          selected,
          onChange: (next) => {
            setSelected(next);
            onSelection?.([...next].sort());
          },
          toggleOnClick: rest.selection?.toggleOnClick,
        }}
      />
    </UiLinkProvider>
  );
}

function checkboxNamed(view: ReturnType<typeof render>, name: string) {
  return view.getByRole('checkbox', { name }) as HTMLInputElement;
}

function selectedRows(view: ReturnType<typeof render>): string[] {
  return [...view.container.querySelectorAll('li[data-selected="true"]')]
    .map((li) => li.getAttribute('data-row-id') ?? '')
    .sort();
}

describe('TaskGroupTable selection', () => {
  test('a row checkbox toggles, and the row takes the selected state', () => {
    const view = render(<SelectHost />);
    const box = checkboxNamed(view, 'Select A-1');
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(checkboxNamed(view, 'Select A-1').checked).toBe(true);
    expect(selectedRows(view)).toEqual(['a-1']);
    // The checkbox carries the state; list items never get aria-selected.
    expect(view.container.querySelector('[aria-selected]')).toBeNull();
    fireEvent.click(checkboxNamed(view, 'Select A-1'));
    expect(selectedRows(view)).toEqual([]);
  });

  test('shift-click selects the range from the anchor across groups', () => {
    const view = render(<SelectHost />);
    fireEvent.click(checkboxNamed(view, 'Select A-2'));
    fireEvent.click(checkboxNamed(view, 'Select C-1'), { shiftKey: true });
    expect(selectedRows(view)).toEqual(['a-2', 'b-1', 'c-1']);
  });

  test('group and header checkboxes are tri-state over the shown rows', () => {
    const view = render(<SelectHost />);
    const group = checkboxNamed(view, 'Select the 2 shown issues in Cutover');
    const all = checkboxNamed(view, 'Select all 4 shown issues');
    fireEvent.click(checkboxNamed(view, 'Select A-1'));
    expect(group.getAttribute('aria-checked')).toBe('mixed');
    expect(all.getAttribute('aria-checked')).toBe('mixed');
    // A click on a mixed box selects the rest of the group.
    fireEvent.click(group);
    expect(selectedRows(view)).toEqual(['a-1', 'a-2']);
    expect(group.checked).toBe(true);
    expect(group.hasAttribute('aria-checked')).toBe(false);
    fireEvent.click(all);
    expect(selectedRows(view)).toEqual(['a-1', 'a-2', 'b-1', 'c-1']);
    expect(all.checked).toBe(true);
    fireEvent.click(all);
    expect(selectedRows(view)).toEqual([]);
  });

  test('x toggles the focused row; Shift+↓ extends; ⌘A selects every shown row', () => {
    const view = render(<SelectHost />);
    const a1 = view.getByRole('link', { name: 'Issue a-1' });
    a1.focus();
    fireEvent.keyDown(a1, { key: 'x' });
    expect(selectedRows(view)).toEqual(['a-1']);
    fireEvent.keyDown(a1, { key: 'ArrowDown', shiftKey: true });
    expect(selectedRows(view)).toEqual(['a-1', 'a-2']);
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-2' })
    );
    // Across the group boundary to the next row (headers are skipped).
    fireEvent.keyDown(document.activeElement as Element, {
      key: 'ArrowDown',
      shiftKey: true,
    });
    expect(selectedRows(view)).toEqual(['a-1', 'a-2', 'b-1']);
    // Back up shrinks the range over what the anchor started from.
    fireEvent.keyDown(document.activeElement as Element, {
      key: 'ArrowUp',
      shiftKey: true,
    });
    expect(selectedRows(view)).toEqual(['a-1', 'a-2']);
    fireEvent.keyDown(document.activeElement as Element, {
      key: 'a',
      metaKey: true,
    });
    expect(selectedRows(view)).toEqual(['a-1', 'a-2', 'b-1', 'c-1']);
    fireEvent.keyDown(document.activeElement as Element, {
      key: 'a',
      ctrlKey: true,
    });
    expect(selectedRows(view)).toEqual(['a-1', 'a-2', 'b-1', 'c-1']);
  });

  test('selection keys are not forwarded to onRowKeyDown; other keys are', () => {
    const seen: string[] = [];
    const view = render(
      <SelectHost onRowKeyDown={(event) => seen.push(event.key)} />
    );
    const a1 = view.getByRole('link', { name: 'Issue a-1' });
    a1.focus();
    fireEvent.keyDown(a1, { key: 'x' });
    fireEvent.keyDown(a1, { key: 'm' });
    expect(seen).toEqual(['m']);
  });

  test('the head row is real with selection: its checkbox, labels hidden', () => {
    const plain = renderTable();
    const plainHead = plain.container.querySelector('[role="group"] > div');
    expect(plainHead?.getAttribute('aria-hidden')).toBe('true');
    cleanup();
    const view = render(<SelectHost />);
    const box = checkboxNamed(view, 'Select all 4 shown issues');
    const head = box.closest('[role="group"] > div');
    expect(head?.hasAttribute('aria-hidden')).toBe(false);
    const labels = [...(head?.querySelectorAll('span') ?? [])].filter(
      (s) => s.textContent === 'Issue' || s.textContent === 'Due'
    );
    expect(labels.map((s) => s.getAttribute('aria-hidden'))).toEqual([
      'true',
      'true',
    ]);
  });

  test('rows of a folded group leave the selection', () => {
    const changes: string[][] = [];
    const view = render(
      <SelectHost
        initial={['a-1', 'b-1']}
        onSelection={(ids) => changes.push(ids)}
      />
    );
    expect(selectedRows(view)).toEqual(['a-1', 'b-1']);
    fireEvent.click(view.getByRole('button', { name: 'Atlas, Cutover' }));
    expect(changes.at(-1)).toEqual(['b-1']);
    expect(selectedRows(view)).toEqual(['b-1']);
  });

  test('a folded group’s checkbox unfolds it and selects its rows', () => {
    const view = render(<SelectHost defaultCollapsed={['g1']} />);
    expect(view.queryByRole('link', { name: 'Issue a-1' })).toBeNull();
    fireEvent.click(
      checkboxNamed(view, 'Select the 2 shown issues in Cutover')
    );
    expect(view.getByRole('link', { name: 'Issue a-1' })).toBeTruthy();
    expect(selectedRows(view)).toEqual(['a-1', 'a-2']);
  });

  test('toggleOnClick: a plain click on a row toggles it instead of opening', () => {
    const onOpenRow = mock((_r: TaskRowData, _g: TaskGroupData) => {});
    const view = render(
      <SelectHost
        onOpenRow={onOpenRow}
        selection={{
          selected: new Set(),
          onChange: () => undefined,
          toggleOnClick: true,
        }}
      />
    );
    // The title says what a tap does: a checkbox named by the title, with
    // the selection as its state, not a link that would not open. A native
    // input inside the title's label, so Space toggles it too.
    expect(view.queryByRole('link', { name: 'Issue a-1' })).toBeNull();
    const title = checkboxNamed(view, 'Issue a-1');
    expect(title.tagName).toBe('INPUT');
    expect(title.checked).toBe(false);
    expect(title.closest('label')?.textContent).toBe('Issue a-1');
    fireEvent.click(title);
    expect(onOpenRow).not.toHaveBeenCalled();
    expect(selectedRows(view)).toEqual(['a-1']);
    expect(checkboxNamed(view, 'Issue a-1').checked).toBe(true);
  });
});

// A click on a long list redraws what it touches, not every row: rows
// and groups are memoized (the showcase's 300-row /issues re-ran 10,000
// components per checkbox before). Counted through renderCell, which a
// row calls each time it draws.
describe('TaskGroupTable redraws', () => {
  const COLUMNS: TaskColumnId[] = ['state'];
  function CountingHost({ drawn }: { drawn: string[] }) {
    const [selected, setSelected] = useState<ReadonlySet<string>>(
      () => new Set()
    );
    const [ticks, setTicks] = useState(0);
    // Stable slots, as a host with many rows keeps them.
    const [renderCell] = useState(
      () =>
        (column: string, r: TaskRowData): undefined => {
          if (column === 'state') drawn.push(r.id);
          return undefined;
        }
    );
    return (
      <UiLinkProvider link={HostLink}>
        <button type="button" onClick={() => setTicks(ticks + 1)}>
          {`Host render ${ticks}`}
        </button>
        <TaskGroupTable
          sections={SECTIONS}
          label="Issues"
          columns={COLUMNS}
          // Event callbacks need not be stable.
          onOpenRow={() => undefined}
          onRowContextMenu={() => undefined}
          renderCell={renderCell}
          selection={{ selected, onChange: setSelected }}
        />
      </UiLinkProvider>
    );
  }

  test('a checkbox redraws its own row; a host render or a fold redraws none of the others', () => {
    const drawn: string[] = [];
    const view = render(<CountingHost drawn={drawn} />);
    expect(drawn.sort()).toEqual(['a-1', 'a-2', 'b-1', 'c-1']);

    drawn.length = 0;
    fireEvent.click(checkboxNamed(view, 'Select A-2'));
    expect(drawn).toEqual(['a-2']);
    expect(selectedRows(view)).toEqual(['a-2']);
    // Its group's checkbox follows (the group redrew its header).
    const group = checkboxNamed(view, 'Select the 2 shown issues in Cutover');
    expect(group.indeterminate).toBe(true);

    drawn.length = 0;
    fireEvent.click(group);
    expect(drawn).toEqual(['a-1']);
    expect(selectedRows(view)).toEqual(['a-1', 'a-2']);

    drawn.length = 0;
    fireEvent.click(view.getByRole('button', { name: 'Host render 0' }));
    expect(drawn).toEqual([]);

    // Folding Public beta draws nothing else; unfolding draws its row.
    fireEvent.click(view.getByRole('button', { name: 'Beacon, Public beta' }));
    expect(drawn).toEqual([]);
    fireEvent.click(view.getByRole('button', { name: 'Beacon, Public beta' }));
    expect(drawn).toEqual(['b-1']);
  });
});

describe('TaskGroupTable slots', () => {
  test('renderCell replaces a value; rowActions and groupActions add cells', () => {
    const view = renderTable({
      columns: ['state', 'assignee'],
      renderCell: (column, r) =>
        column === 'state' ? (
          <button type="button">{`Status of ${r.key}: ${r.state}`}</button>
        ) : undefined,
      rowActions: (r) => (
        <button type="button" aria-label={`Actions for ${r.key}`}>
          …
        </button>
      ),
      groupActions: (g) => (
        <button type="button" aria-label={`Actions for ${g.title}`}>
          …
        </button>
      ),
    });
    const item = view.getByRole('link', { name: 'Issue a-1' }).closest('li');
    const scope = within(item as HTMLElement);
    expect(
      scope.getByRole('button', { name: 'Status of A-1: Todo' })
    ).toBeTruthy();
    // A replaced cell drops its "State:" label (the control names itself);
    // the plain assignee cell keeps "Assignee:".
    expect(item?.textContent).not.toContain('State:');
    expect(item?.textContent).toContain('Assignee: Unassigned');
    expect(scope.getByRole('button', { name: 'Actions for A-1' })).toBeTruthy();
    expect(
      view.getByRole('button', { name: 'Actions for Cutover' })
    ).toBeTruthy();
    const template = view
      .getByRole('group', { name: 'My issues' })
      .style.getPropertyValue('--task-cols');
    expect(template).toBe('minmax(0, 1fr) 136px 140px var(--task-actions-col)');
  });

  test('onRowContextMenu gets a right-click on the row', () => {
    const onRowContextMenu = mock(
      (event: { preventDefault: () => void }, r: TaskRowData) => {
        event.preventDefault();
        return r;
      }
    );
    const view = renderTable({ onRowContextMenu });
    const item = view.getByRole('link', { name: 'Issue a-2' }).closest('li');
    const shown = fireEvent.contextMenu(item as HTMLElement);
    expect(shown).toBe(false);
    expect(onRowContextMenu).toHaveBeenCalledTimes(1);
    expect(onRowContextMenu.mock.calls[0][1].id).toBe('a-2');
  });

  test('keys inside a host control are not the list’s', () => {
    const seen: string[] = [];
    const view = render(
      <SelectHost
        renderCell={(column) =>
          column === 'state' ? <input aria-label="Filter states" /> : undefined
        }
        onRowKeyDown={(event) => seen.push(event.key)}
      />
    );
    const field = view.getAllByRole('textbox', { name: 'Filter states' })[0];
    field.focus();
    fireEvent.keyDown(field, { key: 'x' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'm' });
    expect(selectedRows(view)).toEqual([]);
    expect(document.activeElement).toBe(field);
    expect(seen).toEqual([]);
  });
});

describe('TaskGroupTable group and row additions', () => {
  const sections: TaskSectionData[] = [
    {
      id: 'only',
      groups: [
        {
          id: 'm1',
          eyebrow: 'Atlas',
          title: 'Dual-write',
          count: 212,
          tags: ['Next', '↑2'],
          missingLabel: 'Missing: done means…',
          footer: {
            text: 'Showing 2 of 212',
            actions: [
              { label: 'Show more', onActivate: () => undefined },
              {
                label: 'Only this milestone',
                onActivate: () => undefined,
                disabled: true,
              },
            ],
          },
          rows: [
            row('p-1', {
              pending: true,
              note: { text: 'Moving to Dual-write…' },
            }),
            row('p-2', {
              done: true,
              note: { text: 'Not moved · Linear refused', tone: 'danger' },
            }),
          ],
        },
        {
          id: 's1',
          title: 'In Review',
          mark: { kind: 'state', state: 'started' },
          emptyLabel: 'No open issues here yet. Drag issues here.',
          rows: [],
        },
      ],
    },
  ];

  test('count, tags, the missing line and a footer with actions', () => {
    const view = renderTable({ sections });
    const group = view.container.querySelector('[data-group-id="m1"]');
    const text = group?.textContent ?? '';
    expect(text).toContain('212 issues');
    expect(text).toContain('Next');
    expect(text).toContain('↑2');
    expect(text).toContain('Missing: done means…');
    expect(text).toContain('Showing 2 of 212');
    const more = view.getByRole('button', { name: 'Show more' });
    expect((more as HTMLButtonElement).disabled).toBe(false);
    const only = view.getByRole('button', { name: 'Only this milestone' });
    expect((only as HTMLButtonElement).disabled).toBe(true);
  });

  test('a group with no rows and a footer shows only the footer', () => {
    const view = renderTable({
      sections: [
        {
          id: 'budget',
          groups: [
            {
              id: 'unloaded',
              title: 'Push notifications',
              count: 9,
              rows: [],
              footer: {
                text: '9 issues not shown',
                actions: [{ label: 'Show more', onActivate: () => undefined }],
              },
            },
          ],
        },
      ],
    });
    const group = view.container.querySelector('[data-group-id="unloaded"]');
    const text = group?.textContent ?? '';
    expect(text).toContain('9 issues not shown');
    expect(text).not.toContain('No open issues');
    expect(group?.querySelectorAll('li')).toHaveLength(1);
  });

  test('a section without a label draws no divider', () => {
    const view = renderTable({ sections });
    expect(view.queryByRole('heading', { level: 3 })).toBeNull();
    expect(
      view.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)
    ).toEqual([
      expect.stringContaining('Dual-write'),
      expect.stringContaining('In Review'),
    ]);
  });

  test('a mark in the status mark’s place, and the group’s own empty line', () => {
    const view = renderTable({ sections });
    const group = view.container.querySelector('[data-group-id="s1"]');
    expect(group?.querySelector('svg[data-kind="started"]')).not.toBeNull();
    expect(group?.textContent).toContain(
      'No open issues here yet. Drag issues here.'
    );
    expect(group?.textContent).toContain('0 issues');
  });

  test('pending rows are busy with their note; done rows are marked', () => {
    const view = renderTable({ sections });
    const pending = view.getByRole('link', { name: 'Issue p-1' }).closest('li');
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.getAttribute('data-pending')).toBe('true');
    expect(pending?.textContent).toContain('Moving to Dual-write…');
    const done = view.getByRole('link', { name: 'Issue p-2' }).closest('li');
    expect(done?.getAttribute('data-done')).toBe('true');
    expect(done?.hasAttribute('aria-busy')).toBe(false);
    const note = within(done as HTMLElement).getByText(
      'Not moved · Linear refused'
    );
    expect(note.getAttribute('data-tone')).toBe('danger');
  });

  test('assignee and milestone columns', () => {
    const view = renderTable({
      columns: ['milestone', 'assignee'],
      sections: [
        {
          id: 's',
          label: 'All',
          groups: [
            {
              id: 'g',
              title: 'All issues',
              rows: [
                row('r-1', {
                  assignee: 'Ana Moreno',
                  milestone: 'Atlas › Dual-write',
                }),
                row('r-2', {
                  assignee: null,
                  assigneeTone: 'warning',
                  milestone: null,
                }),
              ],
            },
          ],
        },
      ],
    });
    const cell = (name: string, column: string) =>
      view
        .getByRole('link', { name })
        .closest('li')
        ?.querySelector(`[data-column="${column}"]`);
    expect(cell('Issue r-1', 'assignee')?.textContent).toBe(
      'Assignee: AMAna Moreno'
    );
    expect(cell('Issue r-1', 'milestone')?.textContent).toBe(
      'Milestone: Atlas › Dual-write'
    );
    const unassigned = cell('Issue r-2', 'assignee');
    expect(unassigned?.textContent).toBe('Assignee: Unassigned');
    expect(
      unassigned?.querySelector('[data-tone]')?.getAttribute('data-tone')
    ).toBe('warning');
    expect(cell('Issue r-2', 'milestone')?.textContent).toBe(
      'Milestone: No milestone'
    );
  });
});

describe('TaskGroupTable narrow tables (review fixes)', () => {
  const css = readFileSync(
    path.join(
      import.meta.dir,
      '..',
      'src',
      'tasks',
      'task-group-table.module.css'
    ),
    'utf8'
  );
  const ISSUE_COLUMNS = [
    'milestone',
    'assignee',
    'state',
    'priority',
    'due',
  ] as const;

  test('the milestone cell names the milestone first, its project muted after', () => {
    const view = renderTable({
      columns: ['milestone'],
      sections: [
        {
          id: 's',
          groups: [
            {
              id: 'g',
              title: 'All issues',
              rows: [
                row('r-1', {
                  milestone: 'Search v2 GA',
                  milestoneProject: 'Beacon search',
                }),
                row('r-2', { milestone: 'Dual-write' }),
              ],
            },
          ],
        },
      ],
    });
    const cell = (name: string) =>
      view
        .getByRole('link', { name })
        .closest('li')
        ?.querySelector('[data-column="milestone"] [title]');
    expect(cell('Issue r-1')?.getAttribute('title')).toBe(
      'Beacon search › Search v2 GA'
    );
    expect(
      Array.from(cell('Issue r-1')?.children ?? []).map((el) => el.textContent)
    ).toEqual(['Search v2 GA', ' · Beacon search']);
    expect(cell('Issue r-2')?.textContent).toBe('Dual-write');
    expect(cell('Issue r-2')?.getAttribute('title')).toBe('Dual-write');
  });

  test('dropColumns: each narrow step names what gives way and the grid without it', () => {
    const view = renderTable({
      columns: [...ISSUE_COLUMNS],
      dropColumns: ['due', 'priority', 'state', 'assignee'],
      selection: { selected: new Set(), onChange: () => {} },
      drag: { canDrop: () => true, onDrop: () => {}, label: (n) => `${n}` },
      rowActions: () => null,
    });
    const root = view.getByRole('group', { name: 'My issues' });
    const lead = 'var(--task-grip-col) var(--task-check-col) minmax(0, 1fr)';
    const tail = 'var(--task-actions-col)';
    expect(root.style.getPropertyValue('--task-cols')).toBe(
      `${lead} 180px 140px 136px 128px 88px ${tail}`
    );
    // 1000px wide: the title keeps 260px once Due and Priority go.
    expect(root.getAttribute('data-drop-lg')).toBe('priority due');
    expect(root.style.getPropertyValue('--task-cols-lg')).toBe(
      `${lead} 180px 140px 136px ${tail}`
    );
    expect(root.getAttribute('data-drop-md')).toBe('state priority due');
    expect(root.style.getPropertyValue('--task-cols-md')).toBe(
      `${lead} 180px 140px ${tail}`
    );
    expect(root.getAttribute('data-drop-sm')).toBe(
      'assignee state priority due'
    );
    expect(root.style.getPropertyValue('--task-cols-sm')).toBe(
      `${lead} 180px ${tail}`
    );
    // Head cells carry their column, so a step can hide them with the rows'.
    expect(
      Array.from(root.querySelectorAll('[data-column]'))
        .slice(0, 5)
        .map((el) => el.getAttribute('data-column'))
    ).toEqual([...ISSUE_COLUMNS]);
    expect(css).toMatch(/@container task-table \(720px <= width < 1160px\)/);
    expect(css).toMatch(/@container task-table \(720px <= width < 1000px\)/);
    expect(css).toMatch(/@container task-table \(720px <= width < 860px\)/);
    expect(css).toContain(".root[data-drop-md~='due'] [data-column='due']");
  });

  test('dropColumns: a table that fits drops nothing; without it nothing is marked', () => {
    const fits = renderTable({
      columns: ['state', 'priority'],
      dropColumns: ['priority'],
    });
    const root = fits.getByRole('group', { name: 'My issues' });
    for (const step of ['lg', 'md', 'sm']) {
      expect(root.hasAttribute(`data-drop-${step}`)).toBe(false);
    }
    cleanup();
    const plain = renderTable({ columns: [...ISSUE_COLUMNS] });
    const table = plain.getByRole('group', { name: 'My issues' });
    expect(
      table.getAttributeNames().filter((name) => name.startsWith('data-drop'))
    ).toEqual([]);
  });

  test('hideOnTouch hides the checkboxes on touch screens in CSS, not after hydration', () => {
    const view = renderTable({
      selection: { selected: new Set(), onChange: () => {}, hideOnTouch: true },
    });
    const root = view.getByRole('group', { name: 'My issues' });
    expect(root.getAttribute('data-touch-select')).toBe('hidden');
    // The boxes are still rendered (the same markup on server and client).
    expect(view.getAllByRole('checkbox').length).toBeGreaterThan(0);
    expect(css).toMatch(
      /@media \(pointer: coarse\), \(width <= 640px\) \{\s*\.root\[data-touch-select='hidden'\] \{\s*--task-check-col: 0px;/
    );
    cleanup();
    const shown = renderTable({
      selection: { selected: new Set(), onChange: () => {} },
    });
    expect(
      shown
        .getByRole('group', { name: 'My issues' })
        .hasAttribute('data-touch-select')
    ).toBe(false);
  });

  test('the sticky column header paints above every in-row layer', () => {
    const head = /\.head \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(head).toContain('position: sticky;');
    expect(head).toContain('z-index: 3;');
    const inRow = [...css.matchAll(/z-index: (\d+);/g)].map((m) =>
      Number(m[1])
    );
    expect(Math.max(...inRow)).toBe(3);
  });
});

/** A DataTransfer stand-in: happy-dom's drag events carry none. */
function fakeTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    setDragImage: mock((_el: Element, _x: number, _y: number) => {}),
    data,
  };
}

describe('TaskGroupTable drag', () => {
  test('dragging a selected row carries the selection; dragover asks canDrop', () => {
    const canDrop = mock((ids: readonly string[], groupId: string) =>
      groupId === 'g3' ? true : `No ${ids.length} into ${groupId}`
    );
    const onDrop = mock((_ids: readonly string[], _groupId: string) => {});
    const view = render(
      <SelectHost
        initial={['a-1', 'b-1']}
        drag={{ canDrop, onDrop, label: (n) => `${n} issues` }}
      />
    );
    const grip = view.container.querySelector(
      'li[data-row-id="b-1"] [draggable="true"]'
    );
    expect(grip).not.toBeNull();
    const transfer = fakeTransfer();
    fireEvent.dragStart(grip as Element, { dataTransfer: transfer });
    // Shown order, not click order.
    expect(transfer.data.get('text/plain')).toBe('a-1,b-1');
    expect(transfer.setDragImage).toHaveBeenCalledTimes(1);
    expect(
      [...view.container.querySelectorAll('li[data-dragged="true"]')].map(
        (li) => li.getAttribute('data-row-id')
      )
    ).toEqual(['a-1', 'b-1']);

    const group = (id: string) =>
      view.container.querySelector(`[data-group-id="${id}"][data-collapsed]`);
    const refused = fireEvent.dragOver(
      group('g2')?.querySelector('li') as Element,
      { dataTransfer: transfer }
    );
    expect(refused).toBe(true); // not prevented: no drop here
    expect(group('g2')?.getAttribute('data-drop')).toBe('no');
    expect(group('g2')?.getAttribute('title')).toBe('No 2 into g2');
    expect(group('g2')?.textContent).toContain('No 2 into g2');

    const accepted = fireEvent.dragOver(
      group('g3')?.querySelector('[data-nav-item="group"]') as Element,
      { dataTransfer: transfer }
    );
    expect(accepted).toBe(false); // prevented: a drop is allowed
    expect(group('g3')?.getAttribute('data-drop')).toBe('ok');
    // Asked once per group per drag.
    fireEvent.dragOver(group('g3') as Element, { dataTransfer: transfer });
    expect(canDrop).toHaveBeenCalledTimes(2);

    fireEvent.drop(group('g3') as Element, { dataTransfer: transfer });
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]).toEqual([['a-1', 'b-1'], 'g3']);
    expect(view.container.querySelector('[data-drop]')).toBeNull();
    expect(view.container.querySelector('[data-dragged]')).toBeNull();
  });

  test('an unselected row drags alone; a refused drop does nothing', () => {
    const onDrop = mock((_ids: readonly string[], _groupId: string) => {});
    const view = render(
      <SelectHost
        initial={['a-1']}
        drag={{
          canDrop: () => 'Already there.',
          onDrop,
          label: (n) => `${n} issues`,
        }}
      />
    );
    const grip = view.container.querySelector(
      'li[data-row-id="c-1"] [draggable="true"]'
    );
    const transfer = fakeTransfer();
    fireEvent.dragStart(grip as Element, { dataTransfer: transfer });
    expect(transfer.data.get('text/plain')).toBe('c-1');
    const target = view.container.querySelector(
      '[data-group-id="g1"][data-collapsed]'
    ) as Element;
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(onDrop).not.toHaveBeenCalled();
  });

  test('a group marked droppable={false} is never asked', () => {
    const canDrop = mock(() => true as const);
    const sections: TaskSectionData[] = [
      {
        id: 's',
        label: 'All',
        groups: [
          { id: 'i1', title: 'Platform', droppable: false, rows: [row('i-1')] },
          { id: 'm1', title: 'Dual-write', rows: [row('m-1')] },
        ],
      },
    ];
    const view = renderTable({
      sections,
      drag: { canDrop, onDrop: () => undefined, label: (n) => `${n}` },
    });
    const grip = view.container.querySelector(
      'li[data-row-id="m-1"] [draggable="true"]'
    );
    const transfer = fakeTransfer();
    fireEvent.dragStart(grip as Element, { dataTransfer: transfer });
    const target = view.container.querySelector(
      '[data-group-id="i1"][data-collapsed]'
    ) as Element;
    expect(fireEvent.dragOver(target, { dataTransfer: transfer })).toBe(true);
    expect(canDrop).not.toHaveBeenCalled();
    expect(target.hasAttribute('data-drop')).toBe(false);
  });

  test('no draggable grip under a coarse pointer', () => {
    const original = window.matchMedia;
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
    try {
      const view = renderTable({
        drag: {
          canDrop: () => true,
          onDrop: () => undefined,
          label: (n) => `${n}`,
        },
      });
      expect(view.container.querySelector('[draggable]')).toBeNull();
      // The grip cell is still drawn (the column exists), just inert.
      expect(
        view.container.querySelectorAll('li[data-row-id] [aria-hidden="true"]')
          .length
      ).toBeGreaterThan(0);
    } finally {
      window.matchMedia = original;
    }
  });
});

// The issue list's status places in the status hues (architecture §8.2):
// the row's chips, note, assignee and due date carry their tone as
// data-tone, and the stylesheet draws each tone from the hook (--tone,
// --tone-ink) or the hue's TEXT token; selection and the drop frame stay
// the purple.
describe('TaskGroupTable status colours on the issue list', () => {
  const srcDir = path.join(import.meta.dir, '..', 'src', 'tasks');
  const tableCss = readFileSync(
    path.join(srcDir, 'task-group-table.module.css'),
    'utf8'
  );
  const chipsCss = readFileSync(
    path.join(srcDir, 'filter-chips.module.css'),
    'utf8'
  );
  /** The declarations of the first rule whose selector is exactly `selector`. */
  function body(css: string, selector: string): string {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = flat.indexOf(`\n${selector} {`);
    expect({ selector, found: at >= 0 }).toEqual({ selector, found: true });
    return flat.slice(at, flat.indexOf('}', at));
  }

  test('a row emits its chips, note, assignee and due date tones', () => {
    const view = renderTable({
      columns: ['assignee', 'due'],
      sections: [
        {
          id: 's',
          groups: [
            {
              id: 'g',
              title: 'Dual-write',
              rows: [
                row('r-1', {
                  chips: [
                    { label: 'Blocked', tone: 'warning', filled: true },
                    { label: 'Holds up Beta', tone: 'warning', filled: true },
                  ],
                  assignee: null,
                  assigneeTone: 'warning',
                  unassignedLabel: 'Needs assignee',
                  dueTone: 'danger',
                  dueNote: 'Overdue',
                  note: { text: 'Not moved · skipped', tone: 'danger' },
                }),
                row('r-2', { dueTone: 'warning', due: 'Oct 23' }),
              ],
            },
          ],
        },
      ],
    });
    const first = view.getByRole('link', { name: 'Issue r-1' }).closest('li');
    const blocked = within(first as HTMLElement)
      .getByText('Blocked')
      .closest('[data-tone]');
    expect(blocked?.getAttribute('data-tone')).toBe('warning');
    expect(blocked?.hasAttribute('data-filled')).toBe(true);
    const holds = within(first as HTMLElement)
      .getByText('Holds up Beta')
      .closest('[data-tone]');
    expect(holds?.hasAttribute('data-filled')).toBe(true);
    expect(
      within(first as HTMLElement)
        .getByText('Not moved · skipped')
        .getAttribute('data-tone')
    ).toBe('danger');
    const cell = (li: Element | null, column: string) =>
      li?.querySelector(`[data-column="${column}"] [data-tone]`);
    expect(cell(first, 'assignee')?.getAttribute('data-tone')).toBe('warning');
    expect(cell(first, 'due')?.getAttribute('data-tone')).toBe('danger');
    // The words repeat the hues: the amber placeholder has its own words
    // and the red date its state under it, in the same tone.
    const firstCell = (column: string) =>
      first?.querySelector(`[data-column="${column}"]`);
    expect(firstCell('assignee')?.textContent).toBe('Assignee: Needs assignee');
    expect(firstCell('due')?.textContent).toBe('Due: Oct 23Overdue');
    expect(
      within(first as HTMLElement)
        .getByText('Overdue')
        .getAttribute('data-tone')
    ).toBe('danger');
    const second = view.getByRole('link', { name: 'Issue r-2' }).closest('li');
    expect(cell(second, 'due')?.getAttribute('data-tone')).toBe('warning');
    // No note, no second line; no label, the plain "Unassigned".
    expect(second?.querySelector('[data-column="due"]')?.textContent).toBe(
      'Due: Oct 23'
    );
  });

  test('the stylesheet draws each status place in its hue, never the accent', () => {
    // A toned note and "Unassigned" take the tone's TEXT colour (any tone
    // but default and muted), only where a data-tone is set.
    expect(
      body(
        tableCss,
        ".note[data-tone]:not([data-tone='default'], [data-tone='muted'])"
      )
    ).toContain('color: var(--tone-ink);');
    expect(
      body(
        tableCss,
        ".person[data-tone]:not([data-tone='default'], [data-tone='muted'])"
      )
    ).toContain('color: var(--tone-ink);');
    // The group's "Missing: …" line is amber (a missing input).
    expect(body(tableCss, '.missing')).toContain('color: var(--amber);');
    // The plain Urgent label is red; a priority picker's face takes its
    // colour from the option it shows (PickerOption.tone), never from the
    // host row, so no cell rule keys on the row's priority.
    expect(body(tableCss, '.urgentText')).toContain('color: var(--red);');
    expect(tableCss).not.toContain('[data-priority');
    // A filter value the planner cannot find: Gr8r's warning tint (an
    // amber fill and edge) with its values in the amber text.
    const unknown = body(chipsCss, ".chip[data-unknown='true']");
    expect(unknown).toContain('border-color: var(--amber-line);');
    expect(unknown).toContain('background: var(--amber-soft);');
    expect(body(chipsCss, ".summary[data-unknown='true']")).toContain(
      'color: var(--amber);'
    );
    // No status place is left in the purple.
    for (const selector of [
      ".note[data-tone='accent']",
      ".person[data-tone='accent']",
    ]) {
      expect(tableCss).not.toContain(selector);
    }
  });

  test('selection, the drop target and the in-flight row keep their Gr8r look', () => {
    // A selected (or open) row: the accent tint plus a 2px accent bar at
    // its inner left edge, drawn as a border so forced colours keep it.
    expect(
      body(tableCss, ".row[aria-current='true'],\n.row[data-selected='true']")
    ).toContain('background: var(--accent-soft);');
    expect(
      body(
        tableCss,
        ".row[data-selected='true']::before,\n.row[aria-current='true']::before"
      )
    ).toContain('border-left: 2px solid var(--accent);');
    // A drop target: a faint accent wash framed by a 1px accent edge.
    expect(body(tableCss, ".group[data-drop='ok']")).toContain(
      'background: color-mix(in srgb, var(--accent) 6%, var(--sunken));'
    );
    expect(body(tableCss, ".group[data-drop='ok']::after")).toContain(
      'border: 1px solid var(--accent);'
    );
    // In flight: the hover fill, never a hatch, a hue or a fade.
    const pending = body(tableCss, ".row[data-pending='true']");
    expect(pending).toContain('background: var(--surface-2);');
    expect(pending).not.toMatch(
      /--(red|amber|green|blue|accent|hatch)|opacity/
    );
  });
});

/* ---- Dispatch's list: nesting, the group "+", row keys, live, rebuilds --- */

const TABLE_CSS = readFileSync(
  path.join(
    import.meta.dir,
    '..',
    'src',
    'tasks',
    'task-group-table.module.css'
  ),
  'utf8'
);

describe('TaskGroupTable nested rows (indent)', () => {
  test('a sub-issue row carries its level; its name, words and the grid are unchanged', () => {
    const view = renderTable({
      sections: [
        {
          id: 's',
          groups: [
            {
              id: 'g',
              title: 'Cutover',
              rows: [
                row('p-1'),
                row('c-1', { indent: 1 }),
                row('c-2', { indent: 2 }),
                row('z-1', { indent: 0 }),
              ],
            },
          ],
        },
      ],
    });
    const item = (name: string) =>
      view.getByRole('link', { name }).closest('li') as HTMLElement;
    expect(item('Issue p-1').hasAttribute('data-indent')).toBe(false);
    expect(item('Issue z-1').hasAttribute('data-indent')).toBe(false);
    expect(item('Issue c-1').getAttribute('data-indent')).toBe('1');
    expect(item('Issue c-2').getAttribute('data-indent')).toBe('2');
    // The nesting is layout: no words join the name, the row carries no
    // inline style and the table's grid is the one every row shares.
    expect(view.getByRole('link', { name: 'Issue c-1' }).textContent).toBe(
      'Issue c-1'
    );
    expect(item('Issue c-1').textContent).toBe(
      item('Issue p-1').textContent?.replace(/P-1|p-1/g, (m) =>
        m === 'P-1' ? 'C-1' : 'c-1'
      )
    );
    expect(item('Issue c-2').hasAttribute('style')).toBe(false);
    expect(
      view
        .getByRole('group', { name: 'My issues' })
        .style.getPropertyValue('--task-cols')
    ).toBe('minmax(0, 1fr) 156px 136px 128px 88px');
    // One 20px step per level, on the title cell's padding (desktop) and
    // the card's (stacked); the key moves in with the title.
    expect(TABLE_CSS).toMatch(
      /\.row\[data-indent='1'\] \{\s*--task-nest-pad: var\(--task-nest\);\s*\}/
    );
    expect(TABLE_CSS).toMatch(
      /\.row\[data-indent='2'\] \{\s*--task-nest-pad: calc\(2 \* var\(--task-nest\)\);\s*\}/
    );
    expect(TABLE_CSS).toContain('--task-nest: 20px;');
    expect(TABLE_CSS).toContain(
      'padding: 0 10px 0 calc(var(--task-indent) + var(--task-nest-pad));'
    );
    // Never colour: no hue, tone or fill keys on the level.
    expect(TABLE_CSS).not.toMatch(
      /data-indent[^{]*\{[^}]*(color|background|--tone|border)/
    );
  });
});

describe('TaskGroupTable group "+" (addLabel / onAdd)', () => {
  test('an icon button named by addLabel sits at the header’s end before the groupActions slot', () => {
    const onAdd = mock(() => {});
    const onToggleGroup = mock((_id: string, _c: boolean) => {});
    const view = renderTable({
      sections: [
        {
          id: 's',
          groups: [
            {
              id: 'g1',
              title: 'Cutover',
              addLabel: 'New issue in Cutover',
              onAdd,
              rows: [row('a-1')],
            },
            {
              id: 'g2',
              title: 'Public beta',
              // One without the other draws nothing.
              addLabel: 'New issue in Public beta',
              rows: [row('b-1')],
            },
          ],
        },
      ],
      groupActions: (g) => (
        <button type="button" aria-label={`Actions for ${g.title}`}>
          …
        </button>
      ),
      onToggleGroup,
    });
    const add = view.getByRole('button', { name: 'New issue in Cutover' });
    expect(add.getAttribute('title')).toBe('New issue in Cutover');
    expect(add.getAttribute('data-variant')).toBe('quiet');
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
    // A click adds; it never folds the group under it.
    expect(onToggleGroup).not.toHaveBeenCalled();
    const toggle = toggleOf('Cutover')(view);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const names = (groupId: string) =>
      within(
        view.container.querySelector(
          `[data-group-id="${groupId}"] [data-nav-item="group"]`
        ) as HTMLElement
      )
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'));
    expect(names('g1')).toEqual([
      'Cutover',
      'New issue in Cutover',
      'Actions for Cutover',
    ]);
    expect(names('g2')).toEqual(['Public beta', 'Actions for Public beta']);
    // Not a nav item: ↓ from the toggle lands on the first row.
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(
      view.getByRole('link', { name: 'Issue a-1' })
    );
    // It sits above the header's toggle target, as the "…" does.
    expect(TABLE_CSS).toMatch(/\.groupAdd \{[^}]*z-index: 1;/);
    expect(TABLE_CSS).toMatch(
      /\.groupActions,\s*\.groupAdd \{\s*align-self: flex-start;/
    );
    expect(TABLE_CSS).toMatch(/\.actionsCell button,\s*\.groupAdd button \{/);
  });
});

describe('TaskGroupTable row keys a host binds', () => {
  test('Enter, Space, o and → reach onRowKeyDown unconsumed; the host takes Enter over by preventing it', () => {
    const seen: string[] = [];
    let take = false;
    const view = renderTable({
      onOpenRow: () => undefined,
      onRowKeyDown: (event, r) => {
        seen.push(`${event.key}:${r.id}`);
        if (take) event.preventDefault();
      },
    });
    const link = view.getByRole('link', { name: 'Issue a-1' });
    link.focus();
    // true = not prevented: the key's default (Enter activating the link,
    // Space scrolling) still follows unless the host prevents it.
    expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(link, { key: ' ' })).toBe(true);
    expect(fireEvent.keyDown(link, { key: 'o' })).toBe(true);
    expect(fireEvent.keyDown(link, { key: 'ArrowRight' })).toBe(true);
    // Without `selection`, x is the host's too.
    expect(fireEvent.keyDown(link, { key: 'x' })).toBe(true);
    expect(seen).toEqual([
      'Enter:a-1',
      ' :a-1',
      'o:a-1',
      'ArrowRight:a-1',
      'x:a-1',
    ]);
    expect(document.activeElement).toBe(link);
    take = true;
    expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(link, { key: ' ' })).toBe(false);
    // ← stays the table's (it goes to the group) and never arrives.
    seen.length = 0;
    fireEvent.keyDown(link, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(toggleOf('Atlas, Cutover')(view));
    expect(seen).toEqual([]);
  });
});

describe('TaskGroupTable live rows', () => {
  test('a running agent is a chip in the info tone (the dot pill); the table animates nothing', () => {
    const view = renderTable({
      sections: [
        {
          id: 's',
          groups: [
            {
              id: 'g',
              title: 'Cutover',
              rows: [
                row('a-1', {
                  chips: [
                    { label: 'Agent working', tone: 'info' },
                    { label: 'Live', tone: 'info', filled: true },
                  ],
                }),
              ],
            },
          ],
        },
      ],
    });
    const item = view.getByRole('link', { name: 'Issue a-1' }).closest('li');
    const working = within(item as HTMLElement)
      .getByText('Agent working')
      .closest('[data-tone]');
    expect(working?.getAttribute('data-tone')).toBe('info');
    expect(working?.hasAttribute('data-filled')).toBe(false);
    // The pill's 6px dot (decorative: the words say the state).
    expect(working?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    const live = within(item as HTMLElement)
      .getByText('Live')
      .closest('[data-tone]');
    expect(live?.hasAttribute('data-filled')).toBe(true);
    // No pulse: motion is never a cue here, so reduced motion has nothing
    // to switch off beyond the transitions.
    expect(TABLE_CSS).not.toMatch(/@keyframes|animation/);
  });
});

// Dispatch patches one task on a WS event and its adapter maps the store
// to fresh sections, groups and rows each time: only the rows whose data
// changed may redraw. Counted through renderCell, as above.
describe('TaskGroupTable redraws on a rebuilt model', () => {
  const COLUMNS: TaskColumnId[] = ['state'];
  function RebuildHost({
    drawn,
    opened,
  }: {
    drawn: string[];
    opened: TaskGroupData[];
  }) {
    const [version, setVersion] = useState(0);
    const [renderCell] = useState(
      () =>
        (column: string, r: TaskRowData): undefined => {
          if (column === 'state') drawn.push(r.id);
          return undefined;
        }
    );
    // New arrays and objects every render; what they say changes one
    // thing per version: a-2's state (1), the group's count (2), a-1's
    // chip (3), the group's eyebrow (4).
    const sections: TaskSectionData[] = [
      {
        id: 'week',
        label: 'This week',
        groups: [
          {
            id: 'g1',
            eyebrow: version >= 4 ? 'Beacon' : 'Atlas',
            title: 'Cutover',
            count: version >= 2 ? 3 : 2,
            rows: [
              row('a-1', {
                chips: [
                  {
                    label: version >= 3 ? 'Blocked by 2' : 'Blocked',
                    tone: 'warning',
                    filled: true,
                  },
                ],
                note: { text: 'Moving…' },
              }),
              row('a-2', { state: version >= 1 ? 'Done' : 'Todo' }),
              row('a-3', { indent: 1 }),
            ],
          },
        ],
      },
    ];
    return (
      <UiLinkProvider link={HostLink}>
        <button type="button" onClick={() => setVersion(version + 1)}>
          {`Version ${version}`}
        </button>
        <TaskGroupTable
          sections={sections}
          label="Issues"
          columns={COLUMNS}
          renderCell={renderCell}
          onOpenRow={(_r, g) => {
            opened.push(g);
          }}
        />
      </UiLinkProvider>
    );
  }

  test('only the rows whose data changed redraw; a callback gets the group as it is now', () => {
    const drawn: string[] = [];
    const opened: TaskGroupData[] = [];
    const view = render(<RebuildHost drawn={drawn} opened={opened} />);
    expect(drawn.sort()).toEqual(['a-1', 'a-2', 'a-3']);
    const next = (version: number) =>
      fireEvent.click(view.getByRole('button', { name: `Version ${version}` }));

    drawn.length = 0;
    next(0); // a-2's state
    expect(drawn).toEqual(['a-2']);
    expect(
      view.getByRole('link', { name: 'Issue a-2' }).closest('li')?.textContent
    ).toContain('State: Done');

    drawn.length = 0;
    next(1); // the group's count only: its header redraws, no row does
    expect(drawn).toEqual([]);
    expect(
      view.container.querySelector('[data-group-id="g1"]')?.textContent
    ).toContain('3 issues');
    // a-1 kept its draw, yet a click on it reports the current group.
    fireEvent.click(view.getByRole('link', { name: 'Issue a-1' }));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.count).toBe(3);

    drawn.length = 0;
    next(2); // a-1's chip, rebuilt as a new array each time
    expect(drawn).toEqual(['a-1']);

    drawn.length = 0;
    next(3); // the eyebrow: the project cell is checked against it
    expect(drawn.sort()).toEqual(['a-1', 'a-2', 'a-3']);
  });
});
