import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import {
  type TaskActivityItem,
  TaskActivityList,
  TaskDescription,
  TaskDetail,
  type TaskDetailProps,
  TaskDetailSection,
  TaskPropertyValue,
  type TaskRelation,
  TaskRelationList,
  TaskSlideOver,
  type UiLinkProps,
  UiLinkProvider,
} from '../src/index';
import { isCrumbList } from '../src/task/task-crumbs';
import { likelyOverflows } from '../src/task/task-description';

afterEach(cleanup);

function HostLink({ children, ...rest }: UiLinkProps) {
  return (
    <a {...rest} data-host-link="">
      {children}
    </a>
  );
}

function relation(
  key: string,
  extra: Partial<TaskRelation> = {}
): TaskRelation {
  return {
    id: key,
    taskKey: key,
    title: `Task ${key}`,
    state: { kind: 'started', label: 'In Progress' },
    ...extra,
  };
}

const LONG_TEXT = Array.from(
  { length: 20 },
  (_, i) => `Line ${i + 1} of the spec.`
).join('\n');

function baseProps(extra: Partial<TaskDetailProps> = {}): TaskDetailProps {
  return {
    taskKey: 'ENG-24',
    title: 'Search analytics events',
    href: 'https://linear.app/northwind/issue/ENG-24',
    breadcrumb: [
      { label: 'Beacon search', href: '/timeline?project=beacon' },
      { label: 'Search v2 beta', href: '/timeline?milestone=beta' },
      { label: 'ENG-24' },
    ],
    status: { kind: 'unstarted', label: 'Todo' },
    alerts: [
      {
        id: 'blocked',
        label: 'Blocked',
        tone: 'warning',
        message: 'Waiting on ENG-23 (in progress).',
        action: { label: 'Graph', href: '/graph?focus=ENG-24' },
      },
      {
        id: 'stalled',
        label: 'Stalled',
        tone: 'warning',
        message: 'In Todo for 9 days.',
      },
      {
        id: 'overdue',
        label: 'Overdue',
        tone: 'danger',
        message: 'Search v2 beta was due Oct 19.',
      },
    ],
    properties: [
      { id: 'assignee', label: 'Assignee', value: 'Ana Moreno' },
      { id: 'milestone', label: 'Milestone', value: 'Search v2 beta' },
    ],
    description: { text: 'Send search analytics events.' },
    relations: {
      blockedBy: [relation('ENG-23', { href: '/issues/ENG-23' })],
      blocks: [],
    },
    activity: [
      { id: 'a', at: 'Oct 21', label: 'Flagged as stalled', tone: 'warning' },
    ],
    ...extra,
  };
}

describe('TaskDetail', () => {
  test('renders the header, status line, alerts, properties and sections', () => {
    render(
      <UiLinkProvider link={HostLink}>
        <TaskDetail
          {...baseProps()}
          headerActions={<button type="button">Copy link</button>}
        />
      </UiLinkProvider>
    );
    const article = screen.getByRole('article', {
      name: 'Search analytics events',
    });
    expect(article.getAttribute('data-layout')).toBe('drawer');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Search analytics events' })
    ).toBeTruthy();

    // Crumbs: host links for the trail, the last one is the current page.
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const crumbLinks = within(nav).getAllByRole('link');
    expect(crumbLinks.map((a) => a.getAttribute('href'))).toEqual([
      '/timeline?project=beacon',
      '/timeline?milestone=beta',
    ]);
    expect(crumbLinks[0].hasAttribute('data-host-link')).toBe(true);
    expect(within(nav).getByText('ENG-24').getAttribute('aria-current')).toBe(
      'page'
    );
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();

    // The key links to the tracker in a new tab, as a plain anchor.
    const key = screen.getByRole('link', { name: /^ENG-24/ });
    expect(key.getAttribute('href')).toBe(
      'https://linear.app/northwind/issue/ENG-24'
    );
    expect(key.getAttribute('target')).toBe('_blank');
    expect(key.getAttribute('rel')).toBe('noreferrer');
    expect(key.hasAttribute('data-host-link')).toBe(false);
    expect(key.textContent).toContain('opens in a new tab');
    expect(screen.getByText('Todo')).toBeTruthy();

    // Alerts by tone (an alert without one is AlertStrip's default,
    // warning), with the follow-up as a link. Only the most severe one is
    // a tinted box; the rest are rows of one neutral list, in host order.
    const strip = (label: string) =>
      screen.getByText(label).closest('[data-tone]');
    const alertTone = (label: string) =>
      strip(label)?.getAttribute('data-tone');
    expect(alertTone('Blocked')).toBe('warning');
    expect(alertTone('Stalled')).toBe('warning');
    expect(alertTone('Overdue')).toBe('danger');
    const overdue = strip('Overdue');
    const blocked = strip('Blocked');
    const stalled = strip('Stalled');
    expect(overdue?.parentElement?.firstElementChild).toBe(overdue ?? null);
    expect(blocked?.parentElement).toBe(stalled?.parentElement ?? null);
    expect(blocked?.parentElement).not.toBe(overdue?.parentElement ?? null);
    expect(blocked?.nextElementSibling).toBe(stalled ?? null);
    expect(
      screen.getByRole('link', { name: 'Graph' }).getAttribute('href')
    ).toBe('/graph?focus=ENG-24');

    // Properties keep the host's order.
    const list = screen.getByLabelText('Task details');
    expect(
      Array.from(list.querySelectorAll('dt')).map((dt) => dt.textContent)
    ).toEqual(['Assignee', 'Milestone']);

    // One h3 per section, the counts spoken with the heading.
    const h3 = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(h3).toEqual([
      'Properties',
      'Description',
      'Blocked by, 1',
      'Blocks, 0',
      'Activity',
    ]);
    expect(screen.getByText('Nothing waits on this task.')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Blocked by' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Activity' })).toBeTruthy();
  });

  test('drawer layout hides the properties heading; page layout shows it', () => {
    const { rerender } = render(<TaskDetail {...baseProps()} />);
    const drawerHead = screen.getByRole('heading', { name: 'Properties' });
    expect(drawerHead.parentElement?.className).toContain('srOnly');
    rerender(<TaskDetail {...baseProps()} layout="page" />);
    const pageHead = screen.getByRole('heading', { name: 'Properties' });
    expect(pageHead.parentElement?.className ?? '').not.toContain('srOnly');
    expect(screen.getByRole('article').getAttribute('data-layout')).toBe(
      'page'
    );
  });

  test('headingLevel moves the title and every section', () => {
    render(<TaskDetail {...baseProps()} headingLevel={3} />);
    expect(
      screen.getByRole('heading', { level: 3, name: 'Search analytics events' })
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 4, name: 'Description' })
    ).toBeTruthy();
  });

  test('header={false} leaves the bar and title to the container', () => {
    render(<TaskDetail {...baseProps()} header={false} />);
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Search analytics events' })
    ).toBeNull();
    // The status line stays: key and state.
    expect(screen.getByRole('link', { name: /^ENG-24/ })).toBeTruthy();
    expect(screen.getByText('Todo')).toBeTruthy();
    // Sections still sit one below the (container's) h2.
    expect(
      screen.getByRole('heading', { level: 3, name: 'Description' })
    ).toBeTruthy();
  });

  test('leaves out the sections the host does not pass', () => {
    render(
      <TaskDetail
        {...baseProps({
          alerts: undefined,
          description: undefined,
          relations: undefined,
          activity: undefined,
        })}
      />
    );
    const h3 = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(h3).toEqual(['Properties']);
    expect(screen.queryByText('Blocked')).toBeNull();
  });

  test('a done task is marked closed; a host control replaces the state', () => {
    const { rerender } = render(
      <TaskDetail
        {...baseProps({
          alerts: [],
          status: { kind: 'completed', label: 'Done' },
        })}
      />
    );
    expect(screen.getByRole('article').getAttribute('data-closed')).toBe(
      'true'
    );
    rerender(
      <TaskDetail
        {...baseProps({
          status: {
            kind: 'started',
            label: 'Building',
            control: <button type="button">Change status</button>,
          },
          statusMeta: <span>Updated 2h ago</span>,
        })}
      />
    );
    expect(screen.getByRole('article').hasAttribute('data-closed')).toBe(false);
    expect(screen.getByRole('button', { name: 'Change status' })).toBeTruthy();
    expect(screen.queryByText('Building')).toBeNull();
    expect(screen.getByText('Updated 2h ago')).toBeTruthy();
  });

  test('a ready breadcrumb node renders as given; no breadcrumb shows the key', () => {
    const { rerender, container } = render(
      <TaskDetail
        {...baseProps({ breadcrumb: <strong>Beacon / ENG-24</strong> })}
      />
    );
    expect(container.querySelector('strong')?.textContent).toBe(
      'Beacon / ENG-24'
    );
    expect(screen.queryByRole('navigation')).toBeNull();
    rerender(<TaskDetail {...baseProps({ breadcrumb: undefined })} />);
    expect(screen.getAllByText('ENG-24').length).toBeGreaterThan(0);
    expect(isCrumbList([{ label: 'A' }])).toBe(true);
    expect(isCrumbList([<span key="a">A</span>])).toBe(false);
    expect(isCrumbList('A / B')).toBe(false);
  });

  test('labels override the built-in wording', () => {
    render(
      <TaskDetail
        {...baseProps()}
        labels={{ blockedBy: 'Bloqué par', blocksNothing: 'Rien.' }}
      />
    );
    expect(
      screen.getByRole('heading', { level: 3, name: /^Bloqué par/ }).textContent
    ).toBe('Bloqué par, 1');
    expect(screen.getByText('Rien.')).toBeTruthy();
  });

  test('onOpenRelation opens a relation row in place', () => {
    const opened = mock((_r: TaskRelation) => undefined);
    render(<TaskDetail {...baseProps()} onOpenRelation={opened} />);
    const row = screen.getByRole('link', { name: /ENG-23/ });
    fireEvent.click(row);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0][0].taskKey).toBe('ENG-23');
  });
});

describe('TaskDescription', () => {
  test('renders plain text with its line breaks, never markup', () => {
    const text =
      'First line\n<img src=x onerror="alert(1)"><b>bold</b>\n**not markdown**';
    const { container } = render(<TaskDescription text={text} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    const body = screen.getByText(/First line/);
    expect(body.textContent).toBe(text);
    expect(body.innerHTML).toContain('&lt;img');
  });

  test('normalises line endings and trims blank edges', () => {
    render(<TaskDescription text={'\n\n  Indented\r\nNext\r\n\n'} />);
    expect(screen.getByText(/Indented/).textContent).toBe('  Indented\nNext');
  });

  test('says "No description" for null or blank text', () => {
    const { rerender } = render(<TaskDescription text={null} />);
    expect(screen.getByText('No description')).toBeTruthy();
    rerender(<TaskDescription text={'  \n '} emptyLabel="Nothing written" />);
    expect(screen.getByText('Nothing written')).toBeTruthy();
  });

  test('shows a labelled skeleton while loading', () => {
    render(<TaskDescription text="Ignored while loading" loading />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toContain('Loading description');
    expect(screen.queryByText('Ignored while loading')).toBeNull();
  });

  test('shows an error line with a retry button', () => {
    const retry = mock(() => undefined);
    const { rerender } = render(
      <TaskDescription
        text={null}
        error="Linear did not answer."
        onRetry={retry}
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Linear did not answer.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<TaskDescription text={null} error="Offline." />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('clamps long text behind a Show more toggle', () => {
    render(<TaskDescription text={LONG_TEXT} sourceLabel="From Linear" />);
    const toggle = screen.getByRole('button', { name: 'Show more' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const body = document.getElementById(
      toggle.getAttribute('aria-controls') ?? ''
    );
    expect(body?.textContent).toBe(LONG_TEXT);
    expect(body?.getAttribute('data-clamped')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Show less');
    expect(body?.hasAttribute('data-clamped')).toBe(false);
    expect(screen.getByText('From Linear')).toBeTruthy();
  });

  test('short text has no toggle; clampLines and defaultExpanded apply', () => {
    render(<TaskDescription text="Short." />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    render(
      <TaskDescription text={'a\nb\nc\nd'} clampLines={2} defaultExpanded />
    );
    const toggle = screen.getByRole('button', { name: 'Show less' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  test('likelyOverflows counts hard breaks and wrapped long lines', () => {
    expect(likelyOverflows('one line', 12)).toBe(false);
    expect(likelyOverflows(LONG_TEXT, 12)).toBe(true);
    expect(likelyOverflows('x'.repeat(72 * 13), 12)).toBe(true);
    expect(likelyOverflows('x'.repeat(72 * 12), 12)).toBe(false);
  });
});

describe('TaskRelationList', () => {
  test('routes host hrefs through the host link and tracker URLs to a new tab', () => {
    render(
      <UiLinkProvider link={HostLink}>
        <TaskRelationList
          label="Blocked by"
          items={[
            relation('ENG-23', {
              href: '/issues/ENG-23',
              assignee: 'Dev Patel',
            }),
            relation('ENG-12', {
              href: 'https://linear.app/northwind/issue/ENG-12',
              assignee: null,
              context: 'Atlas billing migration / Dual-write',
              external: true,
            }),
          ]}
        />
      </UiLinkProvider>
    );
    const list = screen.getByRole('list', { name: 'Blocked by' });
    const [local, external] = within(list).getAllByRole('link');
    expect(local.hasAttribute('data-host-link')).toBe(true);
    expect(local.getAttribute('target')).toBeNull();
    expect(local.textContent).toContain('Dev Patel');
    expect(external.hasAttribute('data-host-link')).toBe(false);
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noreferrer');
    expect(external.textContent).toContain('(opens in a new tab)');
    expect(external.textContent).toContain('Unassigned');
    expect(external.textContent).toContain('Outside view');
    expect(external.textContent).toContain(
      'Atlas billing migration / Dual-write'
    );
    expect(external.closest('li')?.getAttribute('data-external')).toBe('true');
  });

  test('an onOpen-only row is a button; a plain row is neither', () => {
    const open = mock(() => undefined);
    render(
      <TaskRelationList
        label="Blocks"
        items={[relation('ENG-25', { onOpen: open }), relation('ENG-26')]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /ENG-25/ }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('Task ENG-26')).toBeTruthy();
  });

  test('with href and onOpen, plain clicks open in place and modified clicks follow the link', () => {
    const open = mock((_r: TaskRelation) => undefined);
    render(
      <TaskRelationList
        label="Blocked by"
        onOpen={open}
        items={[relation('ENG-23', { href: '/issues/ENG-23' })]}
      />
    );
    const row = screen.getByRole('link', { name: /ENG-23/ });
    const plain = fireEvent.click(row);
    expect(plain).toBe(false); // default prevented
    expect(open).toHaveBeenCalledTimes(1);
    const modified = fireEvent.click(row, { ctrlKey: true });
    expect(modified).toBe(true);
    const meta = fireEvent.click(row, { metaKey: true });
    expect(meta).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  test('the row onOpen wins over the list onOpen', () => {
    const listOpen = mock((_r: TaskRelation) => undefined);
    const rowOpen = mock(() => undefined);
    render(
      <TaskRelationList
        label="Blocked by"
        onOpen={listOpen}
        items={[relation('ENG-23', { onOpen: rowOpen })]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /ENG-23/ }));
    expect(rowOpen).toHaveBeenCalledTimes(1);
    expect(listOpen).toHaveBeenCalledTimes(0);
  });

  test('resolved rows are marked and say so', () => {
    render(
      <TaskRelationList
        label="Blocked by"
        items={[
          relation('ENG-21', {
            state: { kind: 'completed', label: 'Done' },
            assignee: null,
            resolved: true,
          }),
        ]}
      />
    );
    const item = screen.getByRole('listitem');
    expect(item.getAttribute('data-resolved')).toBe('true');
    expect(item.textContent).toContain('Resolved');
    expect(item.textContent).toContain('Done');
  });

  test('says the empty label when there is nothing', () => {
    render(
      <TaskRelationList
        label="Blocks"
        items={[]}
        emptyLabel="Blocks nothing."
      />
    );
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText('Blocks nothing.')).toBeTruthy();
  });
});

describe('TaskActivityList', () => {
  const items: TaskActivityItem[] = [
    {
      id: '1',
      at: 'Oct 21',
      dateTime: '2026-10-21',
      label: 'Flagged as stalled',
      detail: 'In Todo for 9 days.',
      tone: 'warning',
    },
    { id: '2', at: 'Oct 14', label: 'Blocked by ENG-23', href: '/runs/1' },
    { id: '3', at: 'Oct 12', label: 'Assigned by the planner', tone: 'muted' },
    {
      id: '4',
      at: 'Oct 9',
      label: 'Created in Linear',
      href: 'https://linear.app/northwind/issue/ENG-24',
    },
  ];

  test('renders the items in the order given, with dates and tones', () => {
    render(
      <UiLinkProvider link={HostLink}>
        <TaskActivityList items={items} />
      </UiLinkProvider>
    );
    const rows = within(
      screen.getByRole('list', { name: 'Activity' })
    ).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-tone'))).toEqual([
      'warning',
      'default',
      'muted',
      'default',
    ]);
    expect(rows[0].querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-10-21'
    );
    expect(rows[0].textContent).toContain('In Todo for 9 days.');
    const local = screen.getByRole('link', { name: 'Blocked by ENG-23' });
    expect(local.hasAttribute('data-host-link')).toBe(true);
    const external = screen.getByRole('link', { name: /Created in Linear/ });
    expect(external.getAttribute('target')).toBe('_blank');
  });

  test('limit hides the rest behind Show all N', () => {
    render(<TaskActivityList items={items} limit={2} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const more = screen.getByRole('button', { name: 'Show all 4' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(more.textContent).toBe('Show fewer');
  });

  test('says the empty label when nothing happened', () => {
    render(<TaskActivityList items={[]} />);
    expect(screen.getByText('No activity yet.')).toBeTruthy();
  });
});

describe('TaskPropertyValue', () => {
  test('prints the value with a note under it, both toned', () => {
    render(
      <TaskPropertyValue
        tone="warning"
        note="Next milestone, due Oct 26"
        noteTone="danger"
      >
        Unassigned
      </TaskPropertyValue>
    );
    expect(screen.getByText('Unassigned').getAttribute('data-tone')).toBe(
      'warning'
    );
    expect(
      screen.getByText('Next milestone, due Oct 26').getAttribute('data-tone')
    ).toBe('danger');
    // The note is a sentence from the host: it reads in its own direction.
    expect(
      screen.getByText('Next milestone, due Oct 26').getAttribute('dir')
    ).toBe('auto');
  });
});

describe('TaskSlideOver', () => {
  function Harness({ onClose }: { onClose?: () => void }) {
    const [key, setKey] = useState('ENG-24');
    const props =
      key === 'ENG-24'
        ? baseProps({
            relations: {
              blockedBy: [
                relation('ENG-23', {
                  href: '/issues/ENG-23',
                  onOpen: () => setKey('ENG-23'),
                }),
              ],
              blocks: [],
            },
          })
        : baseProps({
            taskKey: 'ENG-23',
            title: 'Typo tolerance',
            breadcrumb: [{ label: 'Beacon search' }, { label: 'ENG-23' }],
            relations: { blockedBy: [], blocks: [] },
          });
    return (
      <TaskSlideOver
        {...props}
        open
        onClose={onClose ?? (() => undefined)}
        headerActions={<button type="button">Copy link</button>}
      />
    );
  }

  test('is a dialog named by the title, with the crumbs and actions in its bar', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', {
      name: 'Search analytics events',
    });
    expect(
      within(dialog).getByRole('navigation', { name: 'Breadcrumb' })
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Copy link' })
    ).toBeTruthy();
    // One title heading (the drawer's h2); the sections sit at h3.
    expect(within(dialog).getAllByRole('heading', { level: 2 })).toHaveLength(
      1
    );
    expect(
      within(dialog).getByRole('heading', { level: 3, name: 'Description' })
    ).toBeTruthy();
    expect(within(dialog).queryByRole('article')).toBeNull();
  });

  test('Esc closes through the SlideOver', () => {
    const onClose = mock(() => undefined);
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('swapping tasks in place moves focus to the panel and keeps it in the drawer', () => {
    render(<Harness />);
    const row = screen.getByRole('link', { name: /ENG-23/ });
    row.focus();
    act(() => {
      fireEvent.click(row);
    });
    const dialog = screen.getByRole('dialog', { name: 'Typo tolerance' });
    expect(document.activeElement).toBe(dialog);
  });
});

describe('TaskDetail state per task', () => {
  test('a new task starts with its description collapsed', () => {
    const { rerender } = render(
      <TaskDetail {...baseProps({ description: { text: LONG_TEXT } })} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
    rerender(
      <TaskDetail
        {...baseProps({
          taskKey: 'ENG-23',
          title: 'Typo tolerance',
          description: { text: LONG_TEXT },
        })}
      />
    );
    expect(
      screen
        .getByRole('button', { name: 'Show more' })
        .getAttribute('aria-expanded')
    ).toBe('false');
  });
});

describe('review fixes', () => {
  test('relation facts are separated for screen readers, not run together', () => {
    render(
      <TaskRelationList
        label="Blocked by"
        items={[
          relation('ENG-23', {
            href: '/issues/ENG-23',
            assignee: 'Dev Patel',
            context: 'Beacon search / Search v2 beta',
            external: true,
          }),
        ]}
      />
    );
    const row = screen.getByRole('link', { name: /ENG-23/ });
    // The drawn middot is hidden; a comma is spoken in its place, so the
    // name never reads "In ProgressDev Patel".
    const spoken = Array.from(
      row.querySelectorAll('[aria-hidden="true"]')
    ).reduce(
      (text, hidden) => text.replace(hidden.textContent ?? '', ''),
      row.textContent ?? ''
    );
    expect(spoken).toContain(
      'In Progress, Dev Patel, Beacon search / Search v2 beta, Outside view'
    );
    // The title reads in its own direction (an RTL title stays RTL).
    expect(screen.getByText('Task ENG-23').getAttribute('dir')).toBe('auto');
  });

  test('onRemove adds a sibling remove button named after the key', () => {
    const remove = mock(() => undefined);
    const open = mock(() => undefined);
    render(
      <TaskRelationList
        label="Blocked by"
        removeLabel="Unlink"
        items={[
          relation('ENG-23', { href: '/issues/ENG-23', onRemove: remove }),
          relation('ENG-26', { onOpen: open }),
        ]}
      />
    );
    const button = screen.getByRole('button', { name: 'Unlink ENG-23' });
    const link = screen.getByRole('link', { name: /ENG-23/ });
    // A sibling of the row's link, never nested inside it.
    expect(link.contains(button)).toBe(false);
    expect(button.closest('li')).toBe(link.closest('li'));
    fireEvent.click(button);
    expect(remove).toHaveBeenCalledTimes(1);
    // ENG-26 opens in place and has no remove button.
    expect(screen.queryByRole('button', { name: /Unlink ENG-26/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /ENG-26/ }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('list').getAttribute('data-removable')).toBe(
      'true'
    );
  });

  test('TaskDetail passes the remove wording through its labels', () => {
    render(
      <TaskDetail
        {...baseProps({
          relations: {
            blockedBy: [relation('ENG-23', { onRemove: () => undefined })],
            blocks: [],
          },
        })}
        labels={{ remove: 'Retirer' }}
      />
    );
    expect(screen.getByRole('button', { name: 'Retirer ENG-23' })).toBeTruthy();
  });

  test('titleControl replaces the printed title inside the heading', () => {
    const { rerender } = render(<TaskDetail {...baseProps()} />);
    const plain = screen.getByRole('heading', { level: 2 });
    expect(plain.getAttribute('dir')).toBe('auto');
    rerender(
      <TaskDetail
        {...baseProps()}
        titleControl={
          <textarea aria-label="Task title" defaultValue="Search analytics" />
        }
      />
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(
      within(heading).getByRole('textbox', { name: 'Task title' })
    ).toBeTruthy();
    expect(heading.hasAttribute('dir')).toBe(false);
    // The article is still named by its heading.
    expect(screen.getByRole('article').getAttribute('aria-labelledby')).toBe(
      heading.id
    );
  });

  test('the rail slot follows the properties in both layouts', () => {
    const railSection = (
      <TaskDetailSection title="Labels" headingLevel={3}>
        <p>search, analytics</p>
      </TaskDetailSection>
    );
    const { rerender } = render(
      <TaskDetail {...baseProps()} rail={railSection} />
    );
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    ).toEqual([
      'Properties',
      'Labels',
      'Description',
      'Blocked by, 1',
      'Blocks, 0',
      'Activity',
    ]);
    rerender(<TaskDetail {...baseProps()} layout="page" rail={railSection} />);
    const labels = screen
      .getByRole('heading', { name: 'Labels' })
      .closest('section');
    const properties = screen
      .getByRole('heading', { name: 'Properties' })
      .closest('section');
    // Same container: the rail, beside the main column.
    expect(labels?.parentElement).toBe(properties?.parentElement ?? null);
    const description = screen
      .getByRole('heading', { name: 'Description' })
      .closest('section');
    expect(description?.parentElement).not.toBe(labels?.parentElement ?? null);
  });

  test('description content stands in for the text; loading still wins', () => {
    const { rerender } = render(
      <TaskDescription
        text="Raw **markdown**"
        content={
          <ul>
            <li>Rendered by the host</li>
          </ul>
        }
        sourceLabel="From Dispatch"
      />
    );
    expect(screen.getByRole('listitem').textContent).toBe(
      'Rendered by the host'
    );
    expect(screen.queryByText(/Raw/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('From Dispatch')).toBeTruthy();
    rerender(<TaskDescription text={null} content={<p>Body</p>} loading />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText('Body')).toBeNull();
  });

  test('activity labels and details may be nodes and read in their own direction', () => {
    render(
      <TaskActivityList
        items={[
          {
            id: 'x',
            at: 'Oct 1',
            label: (
              <>
                <strong>Ana Moreno</strong> moved it to Done
              </>
            ),
            detail: <em>From the board</em>,
          },
        ]}
      />
    );
    expect(screen.getByText('Ana Moreno').tagName).toBe('STRONG');
    const label = screen.getByText('Ana Moreno').closest('p');
    expect(label?.getAttribute('dir')).toBe('auto');
    expect(screen.getByText('From the board').tagName).toBe('EM');
  });

  test('an empty crumb list falls back to the key', () => {
    render(<TaskDetail {...baseProps({ breadcrumb: [] })} />);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(isCrumbList([])).toBe(false);
    expect(screen.getAllByText('ENG-24').length).toBeGreaterThan(1);
  });

  test('TaskSlideOver: plain titles read in their own direction and go quiet when done; a title control sits in the drawer heading', () => {
    const { rerender } = render(
      <TaskSlideOver
        {...baseProps({ status: { kind: 'completed', label: 'Done' } })}
        open
        onClose={() => undefined}
      />
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Search analytics events',
    });
    const title = within(dialog).getByText('Search analytics events');
    expect(title.getAttribute('dir')).toBe('auto');
    expect(title.getAttribute('data-closed')).toBe('true');
    rerender(
      <TaskSlideOver
        {...baseProps()}
        open
        onClose={() => undefined}
        titleControl={
          <input aria-label="Task title" defaultValue="Search analytics" />
        }
      />
    );
    const heading = within(screen.getByRole('dialog')).getByRole('heading', {
      level: 2,
    });
    expect(
      within(heading).getByRole('textbox', { name: 'Task title' })
    ).toBeTruthy();
  });
});
