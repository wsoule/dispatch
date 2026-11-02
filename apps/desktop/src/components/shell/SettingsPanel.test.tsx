import type { ApiClient } from '@dispatch/client';
import { SlideOver } from '@dispatch/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import { Coins } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';

import { useOnOpening } from '../../hooks/useOnOpening';
import { SessionDetailModal } from '../sessions/SessionDetailModal';
import {
  dataWith,
  selectTrigger,
  testProject,
} from '../settings/fixtures.test-helper';

// The Diffs page's preview imports a Vite-only worker specifier `bun test` cannot resolve:
// stubbed to a passthrough, as SettingsView.test.tsx does, before the panel is imported.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));
const { SettingsPanel } = await import('./SettingsPanel');

/** The panel beside a Gear button and, when asked, a stand-in for a legacy Base UI dialog a
    hosted page opens: portalled to <body>, outside the panel, marked aria-modal while open. */
function renderPanel({
  page,
  legacyDialog = false,
  data = dataWith(),
}: {
  page?: 'agents';
  legacyDialog?: boolean;
  data?: ReturnType<typeof dataWith>;
} = {}) {
  const onClose = mock(() => {});
  // A project's pages (Agents) read through react-query, as under main.tsx's provider.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <button type="button">Gear</button>
      <SettingsPanel
        activeProject={page === undefined ? null : testProject}
        data={data}
        initialPage={page}
        onClose={onClose}
      />
      {legacyDialog && (
        <div role="dialog" aria-modal="true" aria-label="Session">
          <button type="button">Inside the session</button>
        </div>
      )}
    </QueryClientProvider>
  );
  return { onClose, panel: screen.getByTestId('settings-panel') };
}

function scrimOf(panel: HTMLElement): HTMLElement {
  const scrim = panel.parentElement;
  if (scrim === null) throw new Error('no scrim');
  return scrim;
}

/** Records the Escapes that reach a page listener on document (bubble phase), where a legacy
    dialog's own dismiss handler and the page's shortcuts listen. */
function pageEscapes(): { count: () => number; stop: () => void } {
  let seen = 0;
  const listener = (event: KeyboardEvent) => {
    if (event.key === 'Escape') seen += 1;
  };
  document.addEventListener('keydown', listener);
  return {
    count: () => seen,
    stop: () => document.removeEventListener('keydown', listener),
  };
}

test('the panel is a modal dialog named Settings that takes focus', () => {
  const { panel } = renderPanel();
  const dialog = screen.getByRole('dialog', { name: 'Settings' });
  expect(dialog.getAttribute('data-testid')).toBe('settings-panel');
  expect(panel.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(panel);
});

test('closing gives focus back to the opener and lets the page scroll again', () => {
  const onClose = mock(() => {});
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Gear
        </button>
        {open && (
          <SettingsPanel
            activeProject={null}
            data={dataWith()}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  const gear = screen.getByRole('button', { name: 'Gear' });
  gear.focus();
  fireEvent.click(gear);
  const panel = screen.getByTestId('settings-panel');
  expect(document.activeElement).toBe(panel);
  expect(document.documentElement.style.overflow).toBe('hidden');
  fireEvent.keyDown(panel, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('settings-panel')).toBeNull();
  expect(document.activeElement).toBe(gear);
  expect(document.documentElement.style.overflow).toBe('');
});

test('Escape inside the panel closes it, and the page never sees the key', () => {
  const { onClose, panel } = renderPanel();
  const page = pageEscapes();
  fireEvent.keyDown(panel, { key: 'Escape' });
  page.stop();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(page.count()).toBe(0);
});

// A popup inside that takes Escape first marks it handled.
test('an Escape a popup already handled leaves the panel open', () => {
  const { onClose, panel } = renderPanel();
  panel.addEventListener('keydown', (event) => event.preventDefault());
  fireEvent.keyDown(panel, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
});

// The stack takes an Escape whose focus is outside every layer, before any page listener.
test('Escape with focus fallen to the page closes it through the overlay stack', () => {
  const { onClose } = renderPanel();
  const page = pageEscapes();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  page.stop();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(page.count()).toBe(0);
});

// The Usage page's session detail (a legacy dialog) is portalled outside the panel and is
// aria-modal while open: a modal surface outside the stack, so its Escape stays its own and
// reaches its own document listener.
test('a legacy dialog over the panel keeps its Escape and its presses', () => {
  const { onClose } = renderPanel({ legacyDialog: true });
  const inside = screen.getByRole('button', { name: 'Inside the session' });
  const page = pageEscapes();
  fireEvent.keyDown(inside, { key: 'Escape' });
  page.stop();
  expect(onClose).not.toHaveBeenCalled();
  expect(page.count()).toBe(1);
  fireEvent.pointerDown(inside);
  fireEvent.click(inside);
  expect(onClose).not.toHaveBeenCalled();
});

// The same, with the real legacy dialog: the Usage page's session detail, a Base UI dialog
// portalled to <body> over the panel. Its Escape closes it and leaves Settings open.
test('the Usage page’s session detail takes its own Escape over the panel', async () => {
  const onClose = mock(() => {});
  function Usage() {
    const [sessionId, setSessionId] = useState<string | null>('s1');
    return (
      <SessionDetailModal
        sessionId={sessionId}
        onClose={() => setSessionId(null)}
      />
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SettingsPanel
        activeProject={testProject}
        data={dataWith()}
        initialPage="usage"
        hostedPages={[
          {
            id: 'usage',
            label: 'Usage',
            icon: Coins,
            intro: 'Every agent session and what it cost.',
            render: () => <Usage />,
          },
        ]}
        onClose={onClose}
      />
    </QueryClientProvider>
  );
  const panel = screen.getByTestId('settings-panel');
  const detail = await screen.findByRole('dialog', { name: /session/i });
  expect(panel.contains(detail)).toBe(false);
  expect(detail.getAttribute('aria-modal')).toBe('true');
  fireEvent.keyDown(detail, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: /session/i })).toBeNull()
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(panel.isConnected).toBe(true);
});

test('the close button and a click on the scrim close it; a click inside does not', () => {
  const { onClose, panel } = renderPanel();
  fireEvent.click(panel);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(scrimOf(panel));
  expect(onClose).toHaveBeenCalledTimes(2);
});

// The panel is a modal layer under the pickers it holds: one layer per press.
test('a press on the scrim with a picker open closes only the picker', () => {
  const { onClose, panel } = renderPanel({ page: 'agents' });
  fireEvent.click(selectTrigger('Coding runs effort'));
  expect(screen.queryByRole('listbox')).not.toBeNull();
  const scrim = scrimOf(panel);
  act(() => {
    fireEvent.pointerDown(scrim);
  });
  fireEvent.click(scrim);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.pointerDown(scrim);
  fireEvent.click(scrim);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape in an open picker closes the picker, not the panel', () => {
  const { onClose } = renderPanel({ page: 'agents' });
  const trigger = selectTrigger('Coding runs effort');
  fireEvent.click(trigger);
  const list = screen.getByRole('listbox');
  fireEvent.keyDown(document.activeElement ?? list, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

test('Tab and Shift+Tab stay inside the panel', () => {
  const { panel } = renderPanel();
  fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
  const active = document.activeElement;
  expect(active).not.toBe(panel);
  expect(active instanceof HTMLElement && panel.contains(active)).toBe(true);
});

// A focused control removed or disabled drops focus to <body>; the panel takes it back, and a
// Tab pressed from <body> walks into the panel, never the sidebar behind the scrim.
test('focus fallen to <body> comes back to the panel, and Tab from <body> moves into it', async () => {
  const { panel } = renderPanel();
  function blurActive(): void {
    act(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
  }
  blurActive();
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body, { key: 'Tab' });
  const tabbed = document.activeElement;
  expect(tabbed instanceof HTMLElement && panel.contains(tabbed)).toBe(true);
  blurActive();
  expect(document.activeElement).toBe(document.body);
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.activeElement).toBe(panel);
});

// Escape in the rail's search clears it first; only an Escape from an empty search closes.
test('Escape with text in the search clears it and keeps the panel; the next one closes it', () => {
  // Search renders every page, so the client needs what the Autonomy page reads.
  const { onClose } = renderPanel({
    page: 'agents',
    data: dataWith({
      client: {
        fetchLedger: () => Promise.resolve([]),
      } as unknown as ApiClient,
    }),
  });
  const search = screen.getByLabelText<HTMLInputElement>('Search settings');
  fireEvent.change(search, { target: { value: 'no such setting' } });
  expect(screen.queryByText('No settings match')).not.toBeNull();
  const page = pageEscapes();
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(search.value).toBe('');
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(search, { key: 'Escape' });
  page.stop();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(page.count()).toBe(0);
});

// App closes the task composer (a modal SlideOver) as Settings opens, in the same render
// (useOnOpening), so the composer hands focus back to its opener before the panel takes it.
test('Settings opened over the task composer ends with focus in the panel', async () => {
  let openSettings: () => void = () => undefined;
  function Harness() {
    const [composer, setComposer] = useState(false);
    const [settings, setSettings] = useState(false);
    const box = useRef<HTMLTextAreaElement>(null);
    openSettings = () => setSettings(true);
    useOnOpening(
      settings,
      useCallback(() => setComposer(false), [])
    );
    return (
      <>
        <button type="button" onClick={() => setComposer(true)}>
          New task
        </button>
        <SlideOver
          open={composer}
          onClose={() => setComposer(false)}
          modal
          title="New task"
          initialFocusRef={box}
        >
          <textarea ref={box} aria-label="Describe the task" />
        </SlideOver>
        {settings && (
          <SettingsPanel
            activeProject={null}
            data={dataWith()}
            onClose={() => setSettings(false)}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'New task' });
  act(() => opener.focus());
  fireEvent.click(opener);
  expect(document.activeElement).toBe(
    screen.getByRole('textbox', { name: 'Describe the task' })
  );
  await act(async () => {
    openSettings();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const panel = screen.getByTestId('settings-panel');
  expect(document.activeElement).toBe(panel);
  // Closing Settings gives focus back to where it was before: the composer's opener.
  fireEvent.keyDown(panel, { key: 'Escape' });
  expect(screen.queryByTestId('settings-panel')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
