import { describe, expect, mock, test } from 'bun:test';

import { projectWorkspaceSwitcher, shortPath } from './projectWorkspaces';

test('the home folder reads as ~', () => {
  expect(shortPath('/Users/ada/Sites/storefront')).toBe('~/Sites/storefront');
  expect(shortPath('/home/ada/code/app')).toBe('~/code/app');
  expect(shortPath('/Users/ada')).toBe('~');
});

test('paths outside a home folder are left alone', () => {
  expect(shortPath('/srv/repo')).toBe('/srv/repo');
  expect(shortPath('/Users')).toBe('/Users');
});

const STOREFRONT = { name: 'storefront', path: '/Users/ada/storefront' };
const BILLING = { name: 'billing', path: '/Users/ada/code/billing' };

function build(
  over: Partial<Parameters<typeof projectWorkspaceSwitcher>[0]> = {}
) {
  const onSelectProject = mock((_path: string) => {});
  const onAddProject = mock(() => {});
  const onOpenChange = mock((_open: boolean) => {});
  const switcher = projectWorkspaceSwitcher({
    active: STOREFRONT,
    projects: [],
    onSelectProject,
    onAddProject,
    onOpenChange,
    ...over,
  });
  return { switcher, onSelectProject, onAddProject, onOpenChange };
}

describe('projectWorkspaceSwitcher', () => {
  test('no active project: no switcher, so the brand row stays a link', () => {
    expect(build({ active: null, projects: [BILLING] }).switcher).toBe(
      undefined
    );
  });

  test('the active project is listed and current before the list loads', () => {
    const { switcher } = build();
    expect(switcher?.workspaces).toEqual([
      {
        id: '/Users/ada/storefront',
        name: 'storefront',
        hint: '~/storefront',
        current: true,
      },
    ]);
  });

  test('projects are deduped by path, the active one first and current', () => {
    const { switcher } = build({
      projects: [BILLING, { ...STOREFRONT, name: 'storefront again' }, BILLING],
    });
    expect(
      switcher?.workspaces.map((w) => [w.id, w.name, w.hint, w.current])
    ).toEqual([
      ['/Users/ada/storefront', 'storefront', '~/storefront', true],
      ['/Users/ada/code/billing', 'billing', '~/code/billing', false],
    ]);
  });

  test('the words name a project, not a workspace', () => {
    const { switcher } = build();
    expect(switcher?.label).toBe('Switch project');
    expect(switcher?.menuLabel).toBe('Project');
    expect(switcher?.groupLabel).toBe('Projects');
    expect(switcher?.connect?.label).toBe('Add project…');
  });

  test('switching hands the path to onSelectProject; the connect row adds a project', () => {
    const { switcher, onSelectProject, onAddProject, onOpenChange } = build({
      projects: [BILLING],
    });
    expect(switcher?.onSwitch(BILLING.path)).toBe(undefined);
    expect(onSelectProject.mock.calls).toEqual([[BILLING.path]]);
    switcher?.connect?.onSelect?.();
    expect(onAddProject).toHaveBeenCalledTimes(1);
    expect(switcher?.connect?.href).toBe(undefined);
    switcher?.onOpenChange?.(true);
    expect(onOpenChange.mock.calls).toEqual([[true]]);
  });
});
