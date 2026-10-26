import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import {
  CommandPalette,
  CommandPaletteProvider,
  useCommandPalette,
} from '../src/shell/command-palette';
import { fuzzyMatch } from '../src/shell/fuzzy';
import SlideOver from '../src/shell/slide-over';
import type { PaletteItem } from '../src/shell/types';

afterEach(cleanup);

const ITEMS: PaletteItem[] = [
  { id: 'dry', label: 'Preview allocation (dry run)', section: 'Suggestions' },
  { id: 'theme', label: 'Switch theme', section: 'Suggestions' },
  {
    id: 'atlas',
    label: 'Atlas migration',
    hint: 'Project',
    section: 'Jump to',
    href: '/timeline?project=atlas',
  },
  {
    id: 'atl-142',
    label: 'Cut over the billing writes',
    hint: 'ATL-142',
    section: 'Jump to',
    href: '/issues/atl-142',
  },
  {
    id: 'week',
    label: 'Go to My week',
    section: 'Navigation',
    href: '/week',
    shortcut: ['G', 'W'],
  },
  {
    id: 'timeline',
    label: 'Go to Timeline',
    section: 'Navigation',
    href: '/timeline',
    shortcut: ['G', 'T'],
  },
];

function Trigger() {
  const palette = useCommandPalette();
  return (
    <button type="button" onClick={palette.open}>
      Open palette
    </button>
  );
}

function setup(
  extra: Partial<Parameters<typeof CommandPaletteProvider>[0]> = {}
) {
  const navigate = mock((_href: string) => undefined);
  const utils = render(
    <CommandPaletteProvider
      items={ITEMS}
      navigate={navigate}
      sectionOrder={['Suggestions', 'Jump to', 'Navigation']}
      {...extra}
    >
      <Trigger />
    </CommandPaletteProvider>
  );
  return { ...utils, navigate };
}

function input(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('combobox');
}

function selectedLabel(): string | null {
  return (
    screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true')?.textContent ??
    null
  );
}

describe('fuzzyMatch', () => {
  test('matches tokens as subsequences of the label or hint', () => {
    expect(fuzzyMatch('atl mig', 'Atlas migration')).not.toBeNull();
    expect(
      fuzzyMatch('atl-142', 'Cut over the billing writes', 'ATL-142')
    ).not.toBeNull();
    expect(fuzzyMatch('zzz', 'Atlas migration')).toBeNull();
  });

  test('accepts acronyms and abbreviations, rejects accidental scatter', () => {
    expect(fuzzyMatch('gtw', 'Go to My week')?.labelHits).toEqual([0, 3, 9]);
    expect(fuzzyMatch('tml', 'Go to Timeline')?.labelHits).toEqual([6, 8, 10]);
    expect(fuzzyMatch('atl', 'Prorate mid-cycle plan changes')).toBeNull();
  });

  test('hints match as identifiers, not by scattered letters', () => {
    // A context hint (a project lead) must not pull in unrelated entries.
    expect(
      fuzzyMatch('atl', 'Beacon search', 'Project · Dev Patel')
    ).toBeNull();
    expect(fuzzyMatch('eng24', 'Search analytics events', 'ENG-24')).toEqual({
      score: expect.any(Number),
      labelHits: [],
      hintHits: [0, 1, 2, 4, 5],
    });
    expect(
      fuzzyMatch('patel', 'Beacon search', 'Project · Dev Patel')?.hintHits
    ).toEqual([14, 15, 16, 17, 18]);
  });

  test('ranks a prefix above a scattered match', () => {
    const prefix = fuzzyMatch('time', 'Timeline');
    const scattered = fuzzyMatch('time', 'Toggle items menu everywhere');
    expect(prefix).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(prefix?.score ?? 0).toBeGreaterThan(scattered?.score ?? 0);
  });
});

describe('CommandPalette', () => {
  test('Ctrl+K opens a modal dialog with the input focused', () => {
    setup();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(screen.getAllByRole('option')).toHaveLength(ITEMS.length);
  });

  test('filters on label and hint, keeping sections', () => {
    setup();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    fireEvent.change(input(), { target: { value: 'atl' } });
    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('Atlas migration'))).toBe(true);
    expect(labels.some((l) => l?.includes('ATL-142'))).toBe(true);
    expect(labels.some((l) => l?.includes('Switch theme'))).toBe(false);
    expect(screen.getByRole('group', { name: 'Jump to' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Suggestions' })).toBeNull();
  });

  test('arrow keys move the active option and Enter follows its href', () => {
    const { navigate } = setup();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.change(input(), { target: { value: 'atlas' } });
    expect(selectedLabel()).toContain('Atlas migration');
    expect(input().getAttribute('aria-activedescendant')).toBe(
      screen.getAllByRole('option')[0].id
    );
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(selectedLabel()).toContain('Atlas migration');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/timeline?project=atlas');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('Enter runs onSelect for command items', () => {
    const onSelect = mock(() => undefined);
    setup({
      items: [
        {
          id: 'x',
          label: 'Resync from Linear',
          section: 'Suggestions',
          onSelect,
        },
      ],
    });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  // The planner's Workspaces section (multi-workspace spec §3.4): plain
  // items whose onSelect switches and whose href connects, placed right
  // after Suggestions by the host's sectionOrder; Tab reaches it.
  test('a Workspaces section sits where sectionOrder puts it, after Suggestions', () => {
    const onSwitch = mock(() => undefined);
    const { navigate } = setup({
      items: [
        ...ITEMS,
        {
          id: 'workspace-org-globex',
          label: 'Switch to Globex',
          hint: 'linear.app/globex',
          section: 'Workspaces',
          onSelect: onSwitch,
        },
        {
          id: 'workspace-connect',
          label: 'Connect another workspace',
          hint: 'Sign in with Linear',
          section: 'Workspaces',
          href: '/setup/connect',
        },
      ],
      sectionOrder: ['Suggestions', 'Workspaces', 'Jump to', 'Navigation'],
    });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const groups = screen
      .getAllByRole('group')
      .map((group) =>
        document.getElementById(group.getAttribute('aria-labelledby') ?? '')
      )
      .map((title) => title?.textContent);
    expect(groups).toEqual([
      'Suggestions',
      'Workspaces',
      'Jump to',
      'Navigation',
    ]);
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(selectedLabel()).toContain('Switch to Globex');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.change(input(), { target: { value: 'connect' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/setup/connect');
  });

  test('Tab cycles to the first option of the next section and wraps', () => {
    setup();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(selectedLabel()).toContain('Preview allocation');
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(selectedLabel()).toContain('Atlas migration');
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(selectedLabel()).toContain('Go to My week');
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(selectedLabel()).toContain('Preview allocation');
    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true });
    expect(selectedLabel()).toContain('Go to My week');
    // Focus never leaves the input: Tab is the section key here.
    expect(document.activeElement).toBe(input());
  });

  test('Esc closes and returns focus to the opener', () => {
    setup();
    const opener = screen.getByRole('button', { name: 'Open palette' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test('loads items once, on first open, with a skeleton meanwhile', async () => {
    let resolve: (items: PaletteItem[]) => void = () => undefined;
    const loadItems = mock(
      () =>
        new Promise<PaletteItem[]>((r) => {
          resolve = r;
        })
    );
    setup({ loadItems });
    expect(loadItems).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(loadItems).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    // The skeleton block's heading (hidden from assistive tech).
    expect(screen.getByText('Loading')).toBeTruthy();
    await act(async () => {
      resolve([
        {
          id: 'atl-7',
          label: 'Backfill invoices',
          hint: 'ATL-7',
          section: 'Jump to',
        },
      ]);
      await Promise.resolve();
    });
    expect(screen.getByText('Backfill invoices')).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(loadItems).toHaveBeenCalledTimes(1);
  });

  test('a failed load shows inline with a keyboard-reachable retry', async () => {
    let attempts = 0;
    const loadItems = mock(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('Linear did not answer.'))
        : Promise.resolve([
            { id: 'late', label: 'Late arrival', section: 'Jump to' },
          ]);
    });
    setup({ items: [], loadItems });
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
      await Promise.resolve();
    });
    expect(screen.getByText('Linear did not answer.')).toBeTruthy();
    expect(selectedLabel()).toContain('Retry loading');
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(loadItems).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Late arrival')).toBeTruthy();
  });
});

/** happy-dom's viewport control, for the phone breakpoint. */
function setViewport(width: number, height: number): void {
  (
    window as unknown as {
      happyDOM: { setViewport: (v: { width: number; height: number }) => void };
    }
  ).happyDOM.setViewport({ width, height });
}

/* A slide-over that is already open, with a button to start from. */
function OpenDrawer() {
  const [open, setOpen] = useState(true);
  return (
    <SlideOver open={open} onClose={() => setOpen(false)} title="M3 Cutover">
      <button type="button">Copy link</button>
    </SlideOver>
  );
}

describe('CommandPalette over other overlays', () => {
  test('Esc closes only the palette; focus returns into the slide-over', () => {
    render(
      <CommandPaletteProvider items={ITEMS}>
        <OpenDrawer />
      </CommandPaletteProvider>
    );
    const copy = screen.getByRole('button', { name: 'Copy link' });
    copy.focus();
    fireEvent.keyDown(copy, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(input());
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'Command palette' })
    ).toBeNull();
    expect(screen.getByRole('dialog', { name: 'M3 Cutover' })).toBeTruthy();
    expect(document.activeElement).toBe(copy);
  });

  test('palette → shortcuts sheet → Esc returns focus to the opener', () => {
    setup();
    const opener = screen.getByRole('button', { name: 'Open palette' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: /Shortcuts/ }));
    const sheet = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test('Esc in the palette or the sheet never reaches a dismiss listener on the document', () => {
    // A host dialog library (Base UI's useDismiss, say) closes its dialog on any
    // Escape that bubbles to the document; the palette opened over such a
    // dialog must close alone.
    const seen = mock(() => undefined);
    const listen = (event: KeyboardEvent) => {
      if (event.key === 'Escape') seen();
    };
    document.addEventListener('keydown', listen);
    try {
      setup();
      const opener = screen.getByRole('button', { name: 'Open palette' });
      fireEvent.click(opener);
      fireEvent.click(screen.getByRole('button', { name: /Shortcuts/ }));
      const sheet = screen.getByRole('dialog', {
        name: 'Keyboard shortcuts',
      });
      // The provider shows the sheet in the palette's place; Esc there closes
      // it without the keystroke leaving the sheet.
      fireEvent.keyDown(sheet, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(seen).not.toHaveBeenCalled();
      // Esc in the input, and Esc anywhere else in the panel, both stay inside.
      fireEvent.click(opener);
      fireEvent.keyDown(input(), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(opener);
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(seen).not.toHaveBeenCalled();
      // With nothing open the key reaches the document as usual.
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', listen);
    }
  });

  test("statusMuted draws a row's status mark in greys, still named", () => {
    setup({
      items: [
        {
          id: 'loud',
          label: 'Dual-write',
          section: 'Jump to',
          href: '/timeline?milestone=dual',
          status: 'overdue',
          statusLabel: 'Overdue',
        },
        {
          id: 'quiet',
          label: 'Dashboards',
          section: 'Jump to',
          href: '/timeline?milestone=dash',
          status: 'overdue',
          statusLabel: 'Overdue · inactive project',
          statusMuted: true,
        },
      ],
    });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const loud = screen.getByRole('img', { name: 'Overdue' });
    const quiet = screen.getByRole('img', {
      name: 'Overdue · inactive project',
    });
    expect(loud.hasAttribute('data-muted')).toBe(false);
    expect(quiet.hasAttribute('data-muted')).toBe(true);
  });

  test('a section cap below 1 still shows one row per section', () => {
    setup({ maxPerSection: 0 });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(screen.getAllByRole('group')).toHaveLength(3);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(selectedLabel()).toContain('Atlas migration');
  });

  test('a cap per section heading leaves the others at the default, with "+N more" per section', () => {
    setup({ maxPerSection: { Suggestions: 1, 'Jump to': 1 } });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const groups = screen.getAllByRole('group');
    expect(groups).toHaveLength(3);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Preview allocation (dry run)',
      'Atlas migrationProject',
      'Go to My weekGW',
      'Go to TimelineGT',
    ]);
    expect(groups[0]?.textContent).toContain('+1 more · keep typing');
    expect(groups[1]?.textContent).toContain('+1 more · keep typing');
    expect(groups[2]?.textContent).not.toContain('keep typing');
  });

  test('emptyHint is a second line under "No matches", never while the query is empty', () => {
    render(
      <CommandPalette
        items={[]}
        onClose={() => undefined}
        onRun={() => undefined}
        emptyHint="Try another task id, or press Tab to ask your agent"
      />
    );
    expect(screen.getByText('Nothing to jump to yet')).toBeTruthy();
    expect(screen.queryByText(/Try another task id/)).toBeNull();
    fireEvent.change(input(), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches for “zzz”')).toBeTruthy();
    expect(
      screen.getByText('Try another task id, or press Tab to ask your agent')
    ).toBeTruthy();
  });

  test('locks the page scroll on a phone only', () => {
    setup();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(document.documentElement.style.overflow).toBe('');
    fireEvent.keyDown(input(), { key: 'Escape' });
    setViewport(390, 844);
    try {
      fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
      expect(document.documentElement.style.overflow).toBe('hidden');
      fireEvent.keyDown(input(), { key: 'Escape' });
      expect(document.documentElement.style.overflow).toBe('');
    } finally {
      setViewport(1024, 768);
    }
  });
});

describe('CommandPalette: free text', () => {
  test('Tab submits the trimmed query and closes; Shift+Tab and an empty query keep the section walk', () => {
    const onSubmitFreeText = mock((_query: string) => undefined);
    setup({ onSubmitFreeText, freeTextLabel: 'Ask' });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    // Without text, Tab still walks the sections and the hint stays.
    expect(screen.queryByRole('button', { name: /Ask/ })).toBeNull();
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(selectedLabel()).toContain('Atlas migration');
    expect(onSubmitFreeText).not.toHaveBeenCalled();

    fireEvent.change(input(), { target: { value: '  atlas  ' } });
    // The footer names the action in the "Tab Sections" hint's place.
    expect(screen.getByRole('button', { name: /Tab.*Ask/ })).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true });
    expect(onSubmitFreeText).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(onSubmitFreeText).toHaveBeenCalledWith('atlas');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('the footer action submits with a pointer, and without a handler Tab only cycles', () => {
    const onSubmitFreeText = mock((_query: string) => undefined);
    const view = setup({ onSubmitFreeText });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.change(input(), { target: { value: 'write the notes' } });
    fireEvent.click(screen.getByRole('button', { name: /Use text/ }));
    expect(onSubmitFreeText).toHaveBeenCalledWith('write the notes');
    expect(screen.queryByRole('dialog')).toBeNull();
    view.unmount();

    setup();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.change(input(), { target: { value: 'atl' } });
    expect(screen.queryByRole('button', { name: /Use text/ })).toBeNull();
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(
      screen.getByRole('dialog', { name: 'Command palette' })
    ).toBeTruthy();
  });

  test('refused text is never submitted', () => {
    const onSubmitFreeText = mock((_query: string) => undefined);
    setup({
      onSubmitFreeText,
      refuseQuery: (query) => (query.includes('lin_api_') ? 'Not sent.' : null),
    });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.change(input(), { target: { value: 'lin_api_secret' } });
    expect(screen.queryByRole('button', { name: /Use text/ })).toBeNull();
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(onSubmitFreeText).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Not sent.');
  });
});

describe('CommandPalette: refused text', () => {
  test('text the host refuses matches nothing, shows the sentence and runs nothing', () => {
    const refuse = (query: string): string | null =>
      query.includes('lin_api_')
        ? 'That looks like a Linear API key; it was not sent.'
        : null;
    const { navigate } = setup({ refuseQuery: refuse });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.change(input(), {
      target: { value: 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc' },
    });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toBe(
      'That looks like a Linear API key; it was not sent.'
    );
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
    // An ordinary query still matches.
    fireEvent.change(input(), { target: { value: 'atlas' } });
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });
});

describe('CommandPalette (controlled): a host search beside the fuzzy match', () => {
  const HOST_ITEMS: PaletteItem[] = [
    { id: 'atlas', label: 'Atlas migration', section: 'Jump to' },
    { id: 'theme', label: 'Switch theme', section: 'Suggestions' },
  ];

  test('onQueryChange hears every edit, untrimmed, and the query starts empty on each mount', () => {
    const onQueryChange = mock((_query: string) => undefined);
    const view = render(
      <CommandPalette
        items={HOST_ITEMS}
        onClose={() => undefined}
        onRun={() => undefined}
        onQueryChange={onQueryChange}
      />
    );
    fireEvent.change(input(), { target: { value: 'kan' } });
    fireEvent.change(input(), { target: { value: 'kanban ' } });
    expect(onQueryChange.mock.calls).toEqual([['kan'], ['kanban ']]);
    view.unmount();
    render(
      <CommandPalette
        items={HOST_ITEMS}
        onClose={() => undefined}
        onRun={() => undefined}
      />
    );
    expect(input().value).toBe('');
  });

  test('a matched item stays listed, not highlighted, after the ranked rows of its section', () => {
    const onRun = mock((_item: PaletteItem) => undefined);
    const view = render(
      <CommandPalette
        items={HOST_ITEMS}
        onClose={() => undefined}
        onRun={onRun}
        sectionOrder={['Suggestions', 'Jump to', 'Docs']}
      />
    );
    fireEvent.change(input(), { target: { value: 'kanban' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    // The host's hits for that query arrive: they show without matching it.
    const hits: PaletteItem[] = [
      {
        id: 'doc-1',
        label: 'Board spec › Columns',
        hint: 'board',
        section: 'Docs',
        matched: true,
      },
      {
        id: 'kanban-task',
        label: 'Rework the kanban columns',
        section: 'Docs',
      },
    ];
    view.rerender(
      <CommandPalette
        items={[...HOST_ITEMS, ...hits]}
        onClose={() => undefined}
        onRun={onRun}
        sectionOrder={['Suggestions', 'Jump to', 'Docs']}
      />
    );
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toBe('Rework the kanban columns');
    expect(options[1].textContent).toContain('Board spec › Columns');
    expect(options[1].querySelector('mark')).toBeNull();
    expect(options[0].querySelector('mark')).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Docs' })).toBeTruthy();
    // Enter runs the active (ranked) row; the matched row runs from a click.
    fireEvent.click(options[1]);
    expect(onRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-1' })
    );
  });

  test('without a query, items keep their given order within a section', () => {
    render(
      <CommandPalette
        items={[
          { id: 'b', label: 'Beta', section: 'Jump to' },
          { id: 'z', label: 'Zeta', section: 'Suggestions' },
          { id: 'a', label: 'Alpha', section: 'Jump to' },
        ]}
        onClose={() => undefined}
        onRun={() => undefined}
        sectionOrder={['Suggestions', 'Jump to']}
      />
    );
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Zeta',
      'Beta',
      'Alpha',
    ]);
  });
});
