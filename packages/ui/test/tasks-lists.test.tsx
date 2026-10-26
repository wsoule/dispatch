import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import {
  type DeadlineGroup,
  DeadlineList,
  Register,
  RegisterCell,
  RegisterRow,
  StatsStrip,
  type UiLinkProps,
  UiLinkProvider,
} from '../src/index';

afterEach(cleanup);

function HostLink({ children, ...rest }: UiLinkProps) {
  return (
    <a {...rest} data-host-link="">
      {children}
    </a>
  );
}

describe('StatsStrip', () => {
  test('renders label, mono value and note per cell with its tone', () => {
    const { getByRole, getAllByRole } = render(
      <StatsStrip
        label="This week"
        cells={[
          { id: 'open', label: 'Open issues', value: 7, note: 'of 12' },
          {
            id: 'over',
            label: 'Overdue milestones',
            value: 1,
            note: 'Atlas',
            tone: 'danger',
          },
          { id: 'quiet', label: 'Archived', value: 0, tone: 'muted' },
        ]}
      />
    );
    expect(getByRole('list', { name: 'This week' })).toBeTruthy();
    const cells = getAllByRole('listitem');
    expect(cells.map((c) => c.getAttribute('data-tone'))).toEqual([
      'default',
      'danger',
      'muted',
    ]);
    expect(cells[1].textContent).toBe('Overdue milestones1Atlas');
  });

  test('linked cells route through the host link', () => {
    const { getByRole } = render(
      <UiLinkProvider link={HostLink}>
        <StatsStrip
          cells={[{ id: 'o', label: 'Overdue', value: 2, href: '/timeline' }]}
        />
      </UiLinkProvider>
    );
    const link = getByRole('link');
    expect(link.getAttribute('href')).toBe('/timeline');
    expect(link.hasAttribute('data-host-link')).toBe(true);
    expect(link.textContent).toBe('Overdue2');
  });
});

function item(id: string): DeadlineGroup['items'][number] {
  return {
    id,
    label: `Milestone ${id}`,
    sublabel: 'Atlas · 3 open',
    href: `/timeline?milestone=${id}`,
    status: 'on_track',
    statusLabel: 'On track',
    dueLabel: 'Oct 23',
  };
}

describe('DeadlineList', () => {
  const groups: DeadlineGroup[] = [
    { id: 'over', label: 'Overdue', tone: 'danger', items: [item('m0')] },
    { id: 'today', label: 'Today', items: [] },
    {
      id: 'week',
      label: 'This week',
      items: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(item),
    },
  ];

  test('groups are headed with counts; items link via the host', () => {
    const view = render(
      <UiLinkProvider link={HostLink}>
        <DeadlineList groups={groups} />
      </UiLinkProvider>
    );
    expect(view.getByRole('heading', { name: /Overdue.*1/ })).toBeTruthy();
    expect(view.getByRole('heading', { name: /This week.*6/ })).toBeTruthy();
    // An empty group keeps its heading and says so (Gr8r's panel prints a
    // faint "Nothing due" under it).
    expect(view.getByRole('heading', { name: /Today.*0/ })).toBeTruthy();
    expect(view.getByText('Nothing due')).toBeTruthy();
    // Each group's label carries its tone (danger Overdue), so the label
    // takes the colour; the dates stay quiet.
    const tones = [
      ...view.container.querySelectorAll('[data-deadline-group] [data-tone]'),
    ].map((label) => label.getAttribute('data-tone'));
    expect(tones).toEqual(['danger', 'default', 'default']);
    const link = view.getByRole('link', { name: /Milestone m0/ });
    expect(link.getAttribute('href')).toBe('/timeline?milestone=m0');
    expect(link.hasAttribute('data-host-link')).toBe(true);
    // The status mark is part of the link's name.
    expect(link.textContent).toContain('Oct 23');
    expect(
      view.getAllByRole('img', { name: 'On track' }).length
    ).toBeGreaterThan(0);
  });

  test('with every group empty, each group still stands and says so', () => {
    const view = render(
      <DeadlineList
        groups={[
          { id: 'over', label: 'Overdue', tone: 'danger', items: [] },
          { id: 'today', label: 'Today', items: [] },
        ]}
      />
    );
    expect(view.getAllByRole('heading')).toHaveLength(2);
    expect(view.getAllByRole('region')).toHaveLength(2);
    expect(view.getAllByText('Nothing due')).toHaveLength(2);
  });

  test('"+N more" reveals the rest and moves focus to the first new item', () => {
    const view = render(<DeadlineList groups={groups} limit={4} />);
    expect(view.queryByRole('link', { name: /Milestone m5/ })).toBeNull();
    const more = view.getByRole('button', { name: '+2 more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const revealed = view.getByRole('link', { name: /Milestone m5/ });
    expect(document.activeElement).toBe(revealed);
    fireEvent.click(view.getByRole('button', { name: 'Show fewer' }));
    expect(view.queryByRole('link', { name: /Milestone m5/ })).toBeNull();
  });
});

describe('Register', () => {
  test('header is decorative; the list and cell labels carry meaning', () => {
    const view = render(
      <Register
        label="Projects"
        columns="1fr 1fr"
        header={[
          { id: 'name', label: 'Project' },
          { id: 'lead', label: 'Lead' },
        ]}
      >
        <RegisterRow>
          <RegisterCell label="Project" variant="name" sub="Platform">
            Atlas
          </RegisterCell>
          <RegisterCell label="Lead" variant="mono" tone="warning">
            No lead
          </RegisterCell>
        </RegisterRow>
      </Register>
    );
    const header = view.container.querySelector('[aria-hidden="true"]');
    expect(header?.textContent).toBe('ProjectLead');
    const list = view.getByRole('list', { name: 'Projects' });
    expect(list.textContent).toContain('ProjectAtlasPlatform');
    expect(list.textContent).toContain('LeadNo lead');
    expect(
      view.container.querySelector('[data-tone="warning"]')
    ).not.toBeNull();
  });

  test('linked rows are one focusable target through the host link', () => {
    const view = render(
      <UiLinkProvider link={HostLink}>
        <Register label="Runs" columns="1fr">
          <RegisterRow href="/runs/1" rowLabel="Run 1">
            <RegisterCell variant="name">Run 1</RegisterCell>
          </RegisterRow>
          <RegisterRow
            href="https://linear.app/x"
            external
            rowLabel="Atlas in Linear"
          >
            <RegisterCell>Atlas</RegisterCell>
          </RegisterRow>
        </Register>
      </UiLinkProvider>
    );
    const run = view.getByRole('link', { name: 'Run 1' });
    expect(run.getAttribute('href')).toBe('/runs/1');
    expect(run.hasAttribute('data-host-link')).toBe(true);
    const ext = view.getByRole('link', {
      name: 'Atlas in Linear (opens in a new tab)',
    });
    expect(ext.getAttribute('target')).toBe('_blank');
  });

  test('stacks by viewport width, or by its own width with stackWithin', () => {
    const rows = (
      <RegisterRow>
        <RegisterCell>Atlas</RegisterCell>
      </RegisterRow>
    );
    const byViewport = render(
      <Register label="Viewport" columns="1fr" stackBelow={700}>
        {rows}
      </Register>
    );
    const viewportRoot = byViewport.container.firstElementChild;
    expect(viewportRoot?.getAttribute('data-stack')).toBe('viewport-700');
    cleanup();

    const byWidth = render(
      <Register
        label="Container"
        columns="1fr"
        stackBelow={700}
        stackWithin={1000}
        stackedColumns="repeat(auto-fill, minmax(150px, 1fr))"
      >
        {rows}
      </Register>
    );
    const root = byWidth.container.firstElementChild as HTMLElement | null;
    // stackWithin wins over stackBelow: the root is the query container
    // (CSS module class names are empty under Bun, so data-stack is read).
    expect(root?.getAttribute('data-stack')).toBe('container-1000');
    expect(root?.style.getPropertyValue('--register-stacked-cols')).toBe(
      'repeat(auto-fill, minmax(150px, 1fr))'
    );
  });

  test('callback rows are buttons; selected rows are marked current', () => {
    const onActivate = mock(() => {});
    const view = render(
      <Register label="Sections" columns="1fr">
        <RegisterRow onActivate={onActivate} rowLabel="People" selected>
          <RegisterCell>People</RegisterCell>
        </RegisterRow>
      </Register>
    );
    fireEvent.click(view.getByRole('button', { name: 'People' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(view.getByRole('listitem').getAttribute('aria-current')).toBe(
      'true'
    );
  });
});

describe('review additions', () => {
  test('StatsStrip: the last cell spans what its row leaves empty', () => {
    const cells = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        label: `Cell ${i}`,
        value: i,
      }));
    const spanOf = (n: number) => {
      const view = render(<StatsStrip cells={cells(n)} label={`n${n}`} />);
      const strip = view.getByRole('list', { name: `n${n}` });
      const items = strip.querySelectorAll('li');
      const result = {
        cols: strip.style.getPropertyValue('--stat-cols'),
        span: items[items.length - 1]?.style.getPropertyValue('--stat-span'),
      };
      view.unmount();
      return result;
    };
    expect(spanOf(4)).toEqual({ cols: '4', span: '' });
    expect(spanOf(3)).toEqual({ cols: '3', span: '' });
    expect(spanOf(5)).toEqual({ cols: '4', span: '4' });
    expect(spanOf(6)).toEqual({ cols: '4', span: '3' });
  });

  test('DeadlineList: "Show fewer" folds the overflow back; empty groups say so', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: `d${i}`,
      label: `Milestone ${i}`,
      href: `/m/${i}`,
      status: 'on_track' as const,
      statusLabel: 'On track',
      dueLabel: `Oct ${20 + i}`,
    }));
    const view = render(
      <DeadlineList
        limit={2}
        emptyLabel="Nothing due"
        groups={[
          { id: 'today', label: 'Today', items: [] },
          { id: 'week', label: 'This week', items },
        ]}
      />
    );
    expect(view.getByText('Nothing due')).toBeTruthy();
    const more = view.getByRole('button', { name: '+4 more' });
    fireEvent.click(more);
    expect(view.getAllByRole('link')).toHaveLength(6);
    const fewer = view.getByRole('button', { name: 'Show fewer' });
    expect(fewer.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fewer);
    expect(view.getAllByRole('link')).toHaveLength(2);
  });
});
