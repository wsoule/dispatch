import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { PaletteEntry } from '../../lib/paletteEntries';
import { CommandPalette } from './CommandPalette';
import type { ShellActions } from './ShellActionsContext';
import { ShellActionsProvider } from './ShellActionsContext';

function shellActions(overrides: Partial<ShellActions> = {}): ShellActions {
  return {
    openTask: () => {},
    openThread: () => {},
    peekTask: () => {},
    openCreateTask: () => {},
    createPreset: null,
    closeCreateTask: () => {},
    openPalette: () => {},
    toggleSidebar: () => {},
    sidebarHidden: false,
    openOverseer: () => {},
    setProjectView: () => {},
    setGlobalView: () => {},
    openShortcuts: () => {},
    copyTaskId: () => {},
    ...overrides,
  };
}

function entries(ran: string[] = []): PaletteEntry[] {
  const run = (id: string) => () => ran.push(id);
  return [
    {
      id: 'action-new-task',
      label: 'New task',
      kind: 'action',
      section: 'actions',
      shortcut: 'C',
      run: run('action-new-task'),
    },
    {
      id: 'go-board',
      label: 'Go to Board',
      kind: 'go to',
      section: 'navigation',
      shortcut: '⌘1',
      run: run('go-board'),
    },
    {
      id: 'go-settings',
      label: 'Go to Settings',
      kind: 'go to',
      section: 'navigation',
      shortcut: 'G S',
      run: run('go-settings'),
    },
    {
      id: 'task-t-716d89',
      label: 'Rework the kanban columns',
      sublabel: 't-716d89',
      kind: 'task',
      section: 'tasks',
      run: run('task-t-716d89'),
    },
    {
      id: 'dispatch-t-716d89',
      label: 'Dispatch Rework the kanban columns',
      sublabel: 't-716d89',
      kind: 'action',
      section: 'tasks',
      run: run('dispatch-t-716d89'),
    },
  ];
}

function mount({
  actions = shellActions(),
  ran = [],
  onClose = () => {},
  searchDocs,
}: {
  actions?: ShellActions;
  ran?: string[];
  onClose?: () => void;
  searchDocs?: (query: string) => Promise<PaletteEntry[]>;
} = {}) {
  return render(
    <ShellActionsProvider value={actions}>
      <CommandPalette
        isOpen
        entries={entries(ran)}
        onClose={onClose}
        searchDocs={searchDocs}
      />
    </ShellActionsProvider>
  );
}

function input() {
  return screen.getByPlaceholderText<HTMLInputElement>(
    'Type a command or search…'
  );
}

function headings(): string[] {
  return Array.from(document.querySelectorAll('[cmdk-group-heading]')).map(
    (node) => node.textContent ?? ''
  );
}

test('renders the sections in Linear order with 12px sentence-case headings', () => {
  mount();
  expect(headings()).toEqual(['Tasks', 'Navigation', 'Actions']);
  const heading = document.querySelector('[cmdk-group-heading]');
  expect(heading?.textContent).toBe('Tasks');
  const rows = document.querySelectorAll('[data-slot="command-item"]');
  expect(rows).toHaveLength(5);
  // The first row belongs to the first section, so cmdk's initial selection is a task.
  expect(rows[0]?.textContent).toContain('Rework the kanban columns');
});

test('rows carry an icon, a sans task id, and keycaps — never the kind text', () => {
  mount();
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')
  );
  for (const row of rows) {
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row.textContent).not.toContain('go to');
    expect(row.textContent).not.toMatch(/\baction\b/);
  }
  const taskRow = rows.find((row) => row.textContent?.includes('Rework'));
  const id = Array.from(taskRow?.querySelectorAll('span') ?? []).find(
    (span) => span.textContent === 't-716d89'
  );
  expect(id).toBeDefined();
  expect(id?.className).not.toContain('font-mono');

  const keycaps = Array.from(
    document.querySelectorAll(
      '[data-slot="command-shortcut"] [data-slot="kbd"]'
    )
  ).map((kbd) => kbd.textContent);
  expect(keycaps).toEqual(['⌘1', 'G', 'S', 'C']);
});

test('the input shows the Ask Overseer Tab hint and is described by it', () => {
  mount();
  const hint = document.querySelector('[data-slot="command-input-hint"]');
  expect(hint?.textContent).toContain('Ask the Assistant');
  expect(hint?.querySelector('[data-slot="kbd"]')?.textContent).toBe('Tab');
  expect(hint?.id).not.toBe('');
  expect(input().getAttribute('aria-describedby')).toBe(hint?.id);
});

test('the first row is the 40px active row', () => {
  mount();
  const first = document.querySelector<HTMLElement>(
    '[data-slot="command-item"]'
  );
  expect(first?.dataset.selected).toBe('true');
  expect(first?.className).toContain('h-10');
  expect(first?.className).toContain('data-[selected=true]:bg-surface-active');
});

test('a long title truncates while the task id and keycaps keep their width', () => {
  const ran: string[] = [];
  render(
    <ShellActionsProvider value={shellActions()}>
      <CommandPalette
        isOpen
        entries={[
          ...entries(ran),
          {
            id: 'task-t-long',
            label:
              'A title so long it would push the id clean off the row '.repeat(
                4
              ),
            sublabel: 't-long',
            kind: 'task',
            section: 'tasks',
            shortcut: 'G L',
            run: () => {},
          },
        ]}
        onClose={() => {}}
      />
    </ShellActionsProvider>
  );
  const row = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')
  ).find((r) => r.textContent?.includes('t-long'));
  const spans = Array.from(row?.querySelectorAll('span') ?? []);
  const label = spans.find((span) => span.textContent?.startsWith('A title'));
  const id = spans.find((span) => span.textContent === 't-long');
  expect(label?.className).toContain('min-w-0');
  expect(label?.className).toContain('truncate');
  expect(id?.className).toContain('shrink-0');
  expect(id?.className).not.toContain('flex-1');
  expect(
    row?.querySelector('[data-slot="command-shortcut"]')?.className
  ).toContain('shrink-0');
});

test('the dialog is the 720×450 menu pinned 121px from the top', () => {
  mount();
  const dialog = screen.getByRole('dialog');
  expect(dialog.className).toContain('w-[720px]');
  expect(dialog.className).toContain('h-[450px]');
  expect(dialog.className).toContain('top-[121px]');
  expect(dialog.className).toContain('rounded-popover');
  expect(dialog.className).not.toContain('rounded-card');
});

test('Tab with a query hands it to the Overseer and closes; an empty query lets Tab through', () => {
  const prompts: string[] = [];
  let closed = 0;
  mount({
    actions: shellActions({ openOverseer: (p) => prompts.push(p ?? '') }),
    onClose: () => closed++,
  });
  fireEvent.keyDown(input(), { key: 'Tab' });
  expect(prompts).toEqual([]);
  expect(closed).toBe(0);

  fireEvent.change(input(), { target: { value: 'why is the build red ' } });
  fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true });
  expect(prompts).toEqual([]);
  expect(closed).toBe(0);

  fireEvent.keyDown(input(), { key: 'Tab' });
  expect(prompts).toEqual(['why is the build red']);
  expect(closed).toBe(1);
});

test('typing narrows the rows and reorders sections by the best match', () => {
  mount();
  fireEvent.change(input(), { target: { value: 'go to sett' } });
  expect(headings()).toEqual(['Navigation']);
  const rows = document.querySelectorAll('[data-slot="command-item"]');
  expect(rows[0]?.textContent).toContain('Go to Settings');
});

test('selecting a row closes the menu, runs the entry, and floats it to the top next time', () => {
  const ran: string[] = [];
  let closed = 0;
  const view = mount({ ran, onClose: () => closed++ });
  const row = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')
  ).find((r) => r.textContent?.includes('Go to Settings'));
  if (row === undefined) throw new Error('Go to Settings row not rendered');
  fireEvent.click(row);
  expect(ran).toEqual(['go-settings']);
  expect(closed).toBe(1);

  // The shell keeps the same palette mounted; on the next open the navigation section
  // leads with the row that was just run.
  view.rerender(
    <ShellActionsProvider value={shellActions()}>
      <CommandPalette isOpen entries={entries(ran)} onClose={() => {}} />
    </ShellActionsProvider>
  );
  const nav = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="command-group"]')
  ).find((g) => g.textContent?.startsWith('Navigation'));
  const navRows = Array.from(
    nav?.querySelectorAll('[data-slot="command-item"]') ?? []
  ).map((r) => r.textContent);
  expect(navRows[0]).toContain('Go to Settings');
});

test('shows the empty state when nothing matches', () => {
  mount();
  fireEvent.change(input(), { target: { value: 'zzz-no-match' } });
  expect(document.querySelectorAll('[data-slot="command-item"]')).toHaveLength(
    0
  );
  const empty = document.querySelector('[data-slot="empty-state"]');
  expect(empty?.textContent).toContain('No results');
  // The EmptyState brings its own padding; the cmdk empty slot adds none on top.
  const slot = document.querySelector('[data-slot="command-empty"]');
  expect(slot?.className).toContain('p-0');
  expect(slot?.className).not.toContain('py-8');
});

test('a query also searches docs, listing the hits under Docs after the local rows', async () => {
  const asked: string[] = [];
  const ran: string[] = [];
  mount({
    ran,
    searchDocs: (query) => {
      asked.push(query);
      return Promise.resolve([
        {
          id: 'doc:doc-1#columns',
          label: 'Board spec › Columns',
          sublabel: 'board',
          kind: 'doc',
          section: 'docs',
          run: () => ran.push('doc-1#columns'),
        },
      ]);
    },
  });
  expect(headings()).toEqual(['Tasks', 'Navigation', 'Actions']);
  fireEvent.change(input(), { target: { value: 'kanban' } });
  await waitFor(() => expect(headings()).toEqual(['Tasks', 'Docs']));
  expect(asked).toEqual(['kanban']);
  const row = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')
  ).find((r) => r.textContent?.includes('Board spec › Columns'));
  if (row === undefined) throw new Error('doc row not rendered');
  fireEvent.click(row);
  expect(ran).toEqual(['doc-1#columns']);
});
