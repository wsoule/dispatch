import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToString } from 'react-dom/server';

import {
  Checkbox,
  NavTabs,
  type UiLinkProps,
  UiLinkProvider,
} from '../src/index';

afterEach(cleanup);

// A host link that marks what it rendered, to prove routing goes through
// the provider rather than a bare <a>.
function HostLink({ children, ...rest }: UiLinkProps) {
  return (
    <a {...rest} data-host-link="">
      {children}
    </a>
  );
}

describe('NavTabs', () => {
  test('renders a named nav of host links with the current page marked', () => {
    const { getByRole, getAllByRole } = render(
      <UiLinkProvider link={HostLink}>
        <NavTabs
          label="Graph level"
          items={[
            { id: 'm', label: 'Milestones', href: '/graph', current: true },
            { id: 'i', label: 'Issues in Atlas', href: '/graph?project=p' },
          ]}
        />
      </UiLinkProvider>
    );
    expect(getByRole('navigation', { name: 'Graph level' })).toBeTruthy();
    const links = getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    expect(links[1]?.hasAttribute('aria-current')).toBe(false);
    expect(links[1]?.getAttribute('href')).toBe('/graph?project=p');
    expect(links.every((link) => link.hasAttribute('data-host-link'))).toBe(
      true
    );
  });

  test('a cell without href is not a link and says why', () => {
    const { getAllByRole, getByText } = render(
      <NavTabs
        label="Graph level"
        items={[
          { id: 'm', label: 'Milestones', href: '/graph', current: true },
          { id: 'i', label: 'Issues', note: 'select a milestone' },
        ]}
      />
    );
    expect(getAllByRole('link')).toHaveLength(1);
    const cell = getByText('Issues').parentElement;
    expect(cell?.getAttribute('aria-disabled')).toBe('true');
    expect(getByText('select a milestone')).toBeTruthy();
  });

  test('shows counts and keeps the vertical orientation as a class', () => {
    const { getByRole, getByText } = render(
      <NavTabs
        label="Settings sections"
        orientation="vertical"
        items={[
          {
            id: 'a',
            label: 'Audit',
            href: '/settings?section=audit',
            count: 7,
          },
        ]}
      />
    );
    expect(getByText('7')).toBeTruthy();
    // CSS modules resolve to {} under Bun, so only the role is asserted.
    expect(getByRole('navigation').querySelectorAll('li')).toHaveLength(1);
  });
});

describe('NavTabs onFollow', () => {
  test('a plain click goes to the host; a modified or middle click stays a link', () => {
    const follow = mock(() => undefined);
    const { getByRole } = render(
      <NavTabs
        label="Issue presets"
        items={[
          { id: 'all', label: 'All', href: '/issues', current: true },
          {
            id: 'blocked',
            label: 'Blocked',
            href: '/issues?quick=blocked',
            onFollow: follow,
          },
        ]}
      />
    );
    const link = getByRole('link', { name: 'Blocked' });
    expect(link.getAttribute('href')).toBe('/issues?quick=blocked');
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(follow).toHaveBeenCalledTimes(1);
    const modified = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    fireEvent.click(link, { button: 1 });
    expect(follow).toHaveBeenCalledTimes(1);
    // A cell without onFollow is left to the link.
    const all = new MouseEvent('click', { bubbles: true, cancelable: true });
    getByRole('link', { name: 'All' }).dispatchEvent(all);
    expect(all.defaultPrevented).toBe(false);
  });
});

describe('NavTabs groups', () => {
  const groups = [
    {
      label: 'Project',
      items: [
        {
          id: 'general',
          label: 'General',
          href: '#/settings/general',
          current: true,
        },
        { id: 'agents', label: 'Agents', href: '#/settings/agents' },
      ],
    },
    {
      label: 'This machine',
      items: [
        { id: 'daemon', label: 'Daemon', href: '#/settings/daemon', count: 2 },
      ],
    },
  ];

  test('one nav, a named group per title, the current link marked', () => {
    const { getAllByRole, getByRole } = render(
      <UiLinkProvider link={HostLink}>
        <NavTabs label="Settings" groups={groups} />
      </UiLinkProvider>
    );
    expect(getAllByRole('navigation')).toHaveLength(1);
    const nav = getByRole('navigation', { name: 'Settings' });
    const project = getByRole('group', { name: 'Project' });
    const machine = getByRole('group', { name: 'This machine' });
    expect(nav.contains(project) && nav.contains(machine)).toBe(true);
    // Each group's cells are a list of host links inside it.
    expect(
      [...project.querySelectorAll('a')].map((a) => a.textContent)
    ).toEqual(['General', 'Agents']);
    expect(machine.querySelector('a')?.textContent).toBe('Daemon2');
    const links = getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links.every((link) => link.hasAttribute('data-host-link'))).toBe(
      true
    );
    expect(
      getByRole('link', { name: 'General' }).getAttribute('aria-current')
    ).toBe('page');
    expect(
      getByRole('link', { name: 'Agents' }).hasAttribute('aria-current')
    ).toBe(false);
  });

  test('the visible titles are eyebrows, not headings, and are not read twice', () => {
    const { container, queryAllByRole } = render(
      <NavTabs label="Settings" groups={groups} />
    );
    // No heading role: the page keeps its own h1 outline.
    expect(queryAllByRole('heading')).toHaveLength(0);
    const titles = [
      ...container.querySelectorAll('[data-nav-group-label]'),
    ] as HTMLElement[];
    expect(titles.map((t) => t.textContent)).toEqual([
      'Project',
      'This machine',
    ]);
    for (const title of titles) {
      expect(title.classList.contains('eyebrow')).toBe(true);
      expect(title.getAttribute('aria-hidden')).toBe('true');
    }
    expect(
      container.querySelector('nav')?.hasAttribute('data-nav-grouped')
    ).toBe(true);
  });

  test('onFollow takes a plain click on a grouped cell', () => {
    const follow = mock(() => undefined);
    const { getByRole } = render(
      <NavTabs
        label="Settings"
        groups={[
          {
            label: 'Team',
            items: [
              {
                id: 'team',
                label: 'Members',
                href: '#/settings/team',
                onFollow: follow,
              },
            ],
          },
        ]}
      />
    );
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true });
    getByRole('link', { name: 'Members' }).dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(follow).toHaveBeenCalledTimes(1);
  });

  // The titles hide at 900px and below, where every cell joins the one
  // strip: a CSS concern, checked in the sheet.
  test('at 900px and below the groups join one strip and the titles go', () => {
    const css = readFileSync(
      path.join(import.meta.dir, '../src/tasks/nav-tabs.module.css'),
      'utf8'
    ).replace(/\s+/g, ' ');
    const narrow = css.slice(css.indexOf('@media (width <= 900px)'));
    expect(narrow).toContain('.groupLabel { display: none; }');
    expect(narrow).toMatch(/\.grouped \{ flex-flow: row nowrap;/);
  });

  test('renders on the server', () => {
    const html = renderToString(<NavTabs label="Settings" groups={groups} />);
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="This machine"');
    expect(html).toContain('aria-current="page"');
  });
});

describe('Checkbox', () => {
  test('is a native checkbox named by its label, toggled by the label', () => {
    const onChange = mock((_: boolean) => {});
    const { getByRole, getByText } = render(
      <Checkbox label="Watcher" onChange={onChange} />
    );
    const box = getByRole('checkbox', { name: 'Watcher' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(getByText('Watcher'));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(box.checked).toBe(true);
  });

  test('controlled: follows `checked` and reports the requested state', () => {
    const onChange = mock((_: boolean) => {});
    const { getByRole, rerender } = render(
      <Checkbox label="Watcher" checked onChange={onChange} />
    );
    const box = getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(false);
    rerender(<Checkbox label="Watcher" checked={false} onChange={onChange} />);
    expect(box.checked).toBe(false);
  });

  test('disabled boxes do not change; aria-label overrides the name', () => {
    const onChange = mock((_: boolean) => {});
    const { getByRole } = render(
      <Checkbox
        label="Watcher"
        aria-label="Ana Moreno: Watcher"
        checked
        disabled
        hideLabel
        onChange={onChange}
      />
    );
    const box = getByRole('checkbox', { name: 'Ana Moreno: Watcher' });
    expect((box as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Checkbox passthrough', () => {
  test('onClick reaches the input first, so a header click can be stopped', () => {
    const onHeader = mock(() => undefined);
    const onChange = mock((_: boolean) => {});
    const { getByRole } = render(
      // A stand-in for a collapsible diff header that a click toggles.
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
      <div onClick={onHeader}>
        <Checkbox
          label="Viewed"
          hideLabel
          onChange={onChange}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    );
    fireEvent.click(getByRole('checkbox', { name: 'Viewed' }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onHeader).not.toHaveBeenCalled();
  });

  test('host hooks land on the label, which holds the box', () => {
    const { getByTestId, getByRole } = render(
      <Checkbox
        label="Watcher"
        data-testid="watcher-box"
        data-slot="checkbox"
        disabled
      />
    );
    const root = getByTestId('watcher-box');
    expect(root.tagName).toBe('LABEL');
    expect(root.getAttribute('data-slot')).toBe('checkbox');
    // The component's own hook stays.
    expect(root.getAttribute('data-disabled')).toBe('true');
    expect(root.contains(getByRole('checkbox', { name: 'Watcher' }))).toBe(
      true
    );
  });

  test('renders on the server with the hooks', () => {
    const html = renderToString(
      <Checkbox label="Watcher" id="w" data-testid="watcher-box" />
    );
    expect(html).toContain('data-testid="watcher-box"');
    expect(html).toContain('id="w"');
  });
});

describe('Checkbox indeterminate', () => {
  test('mixed: aria-checked="mixed", the native flag, and a click asks for on', () => {
    const onChange = mock((_: boolean) => {});
    const { getByRole, rerender } = render(
      <Checkbox
        label="Select the 3 shown issues in Dual-write"
        hideLabel
        checked={false}
        indeterminate
        onChange={onChange}
      />
    );
    const box = getByRole('checkbox', {
      name: 'Select the 3 shown issues in Dual-write',
    }) as HTMLInputElement;
    expect(box.getAttribute('aria-checked')).toBe('mixed');
    expect(box.indeterminate).toBe(true);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
    // The host refused: still mixed, and the native flag is put back.
    rerender(
      <Checkbox
        label="Select the 3 shown issues in Dual-write"
        hideLabel
        checked={false}
        indeterminate
        onChange={onChange}
      />
    );
    expect(box.indeterminate).toBe(true);
    // Checked wins over mixed; neither leaves aria-checked behind.
    rerender(
      <Checkbox
        label="Select the 3 shown issues in Dual-write"
        hideLabel
        checked
        indeterminate
        onChange={onChange}
      />
    );
    expect(box.hasAttribute('aria-checked')).toBe(false);
    expect(box.indeterminate).toBe(false);
    expect(box.checked).toBe(true);
  });

  test('without indeterminate there is no aria-checked at all', () => {
    const { getByRole } = render(<Checkbox label="Watcher" />);
    expect(getByRole('checkbox').hasAttribute('aria-checked')).toBe(false);
  });
});

describe('Checkbox in forced colours', () => {
  // Forced colours paint the accent fill as the canvas but not the SVG
  // check's on-accent stroke: the check must take a system colour there,
  // or a ticked or mixed box reads as empty.
  test('the check and the dash are drawn in CanvasText (GrayText disabled)', () => {
    const css = readFileSync(
      path.join(import.meta.dir, '../src/tasks/checkbox.module.css'),
      'utf8'
    );
    const block = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/\.check\s*\{\s*stroke: CanvasText;/);
    expect(block).toMatch(
      /\[data-disabled='true'\] \.check\s*\{\s*stroke: GrayText;/
    );
  });
});
