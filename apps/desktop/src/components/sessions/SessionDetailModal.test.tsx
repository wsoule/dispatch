import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { FileDiff, SessionDetail } from '../../lib/types';
import { SessionDetailModal } from './SessionDetailModal';

const SESSION_ID = 's1-abcdef12';
const FILE = 'apps/desktop/src/lib/parser.ts';

const DETAIL: SessionDetail = {
  session: {
    id: SESSION_ID,
    project_id: 'p1',
    agent: 'claude',
    model: null,
    started_at: 1_700_000_000,
    ended_at: 1_700_000_600,
    last_activity_at: 1_700_000_600,
    status: 'ended',
    duration_seconds: 600,
    summary: 'Split the tokenizer out of the parser.',
    title: 'Refactor the parser',
    prompt_tokens: 1200,
    completion_tokens: 300,
    cache_read_tokens: 800,
    cache_creation_tokens: 0,
    cost_usd: 0.42,
    lines_added: 12,
    lines_removed: 3,
    tags: '["refactor"]',
    raw_log_path: '/tmp/s1.jsonl',
  },
  // Two tool-call edits to one file: groupFilesChanged folds them into one row.
  files_changed: [
    {
      id: 1,
      session_id: SESSION_ID,
      file_path: FILE,
      change_type: 'write',
      lines_added: 10,
      lines_removed: 0,
      occurred_at: 1_700_000_100,
    },
    {
      id: 2,
      session_id: SESSION_ID,
      file_path: FILE,
      change_type: 'edit',
      lines_added: 2,
      lines_removed: 3,
      occurred_at: 1_700_000_200,
    },
  ],
};

const DIFF: FileDiff = {
  lines: [
    { tag: 'equal', content: 'export function parse() {' },
    { tag: 'delete', content: '  return tokenize(input);' },
    { tag: 'insert', content: '  return tokens(input);' },
  ],
  truncated: false,
  occurred_at: 1_700_000_200,
  edit_count: 2,
};

// Tauri's `invoke` calls `window.__TAURI_INTERNALS__.invoke`: defining it here plays the
// desktop backend for the two commands the detail and its diff read, without mock.module
// (which bun hoists across every file in the run).
type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args: unknown) => Promise<unknown>;
  };
};

beforeEach(() => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {
    invoke: (cmd: string) => {
      switch (cmd) {
        case 'get_session_detail':
          return Promise.resolve(DETAIL);
        case 'get_file_diff_for_session_file':
          return Promise.resolve(DIFF);
        default:
          return Promise.reject(new Error(`unexpected command ${cmd}`));
      }
    },
  };
});

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

// One client per render, no retries, as the app's root provider would hold it.
function withQueryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

async function renderDetail() {
  const onClose = mock(() => undefined);
  const view = render(
    <SessionDetailModal sessionId={SESSION_ID} onClose={onClose} />,
    { wrapper: withQueryClient() }
  );
  const panel = await screen.findByRole('dialog', {
    name: 'Refactor the parser',
  });
  return { onClose, panel, view };
}

/** Focus the button, then press it: a browser focuses on mousedown. */
function press(button: HTMLElement) {
  act(() => button.focus());
  fireEvent.click(button);
}

function escape() {
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: 'Escape',
  });
}

describe('SessionDetailModal', () => {
  test('is a modal panel named by the session title', async () => {
    const { panel } = await renderDetail();
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(
      within(panel).getByRole('list', { name: 'Session totals' })
    ).toBeTruthy();
    expect(within(panel).getByText('Ended')).toBeTruthy();
    expect(within(panel).getByText('refactor')).toBeTruthy();
  });

  test('folds two edits to one file into one row', async () => {
    const { panel } = await renderDetail();
    const files = within(panel).getByRole('list', { name: 'Files changed' });
    const rows = within(files).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain(FILE);
    expect(rows[0]?.textContent).toContain('2 edits · +12 / -3');
  });

  test('View diff opens a dialog over the panel; Escape peels one layer at a time', async () => {
    const { onClose, panel } = await renderDetail();
    const viewDiff = within(panel).getByRole('button', { name: 'View diff' });
    press(viewDiff);
    const diff = await screen.findByRole('dialog', { name: FILE });
    expect(diff.getAttribute('aria-modal')).toBe('true');
    await within(diff).findByText('tokens(input);', { exact: false });
    const inserted = within(diff)
      .getByText('return tokens(input);', { exact: false })
      .closest('[data-tag]');
    expect(inserted?.getAttribute('data-tone')).toBe('success');
    expect(inserted?.textContent?.startsWith('+')).toBe(true);

    // The first Escape closes the diff Dialog only, and focus goes back to its opener.
    escape();
    expect(screen.queryByRole('dialog', { name: FILE })).toBeNull();
    expect(
      screen.getByRole('dialog', { name: 'Refactor the parser' })
    ).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(viewDiff);

    // The second closes the panel.
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The panel's header names the trail it sits in: the Usage page, then the session.
  test('the header crumb reads Usage › Session', async () => {
    const { panel } = await renderDetail();
    const crumb = within(panel).getByText('Usage').parentElement;
    expect(crumb?.textContent).toBe('Usage›Session');
    expect(within(panel).getByText('›').getAttribute('aria-hidden')).toBe(
      'true'
    );
  });

  // The diff names itself by its path (the title, in mono) and is described by the session
  // it belongs to, which the old dialog showed as the crumb before the path.
  test('the diff is named by its path and described by its session', async () => {
    const { panel } = await renderDetail();
    press(within(panel).getByRole('button', { name: 'View diff' }));
    const diff = await screen.findByRole('dialog', { name: FILE });
    const describedBy = diff.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Claude Code · s1-abcde'
    );
  });

  // The stack closes the diff on pointerdown and React unmounts it before the click, which
  // can then land on the panel's own scrim now under the pointer: one outside press must
  // close the diff only, never the session panel with it.
  test('a press outside the diff closes the diff only', async () => {
    const { onClose, panel } = await renderDetail();
    press(within(panel).getByRole('button', { name: 'View diff' }));
    const diff = await screen.findByRole('dialog', { name: FILE });
    const diffScrim = diff.parentElement?.firstElementChild;
    const panelScrim = panel.previousElementSibling;
    if (!(diffScrim instanceof HTMLElement)) throw new Error('no diff scrim');
    if (!(panelScrim instanceof HTMLElement)) throw new Error('no scrim');
    fireEvent.pointerDown(diffScrim);
    fireEvent.click(panelScrim);
    expect(screen.queryByRole('dialog', { name: FILE })).toBeNull();
    expect(
      screen.getByRole('dialog', { name: 'Refactor the parser' })
    ).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Closing keeps the last session on screen while the panel slides out, instead of the
  // closing panel flashing "This session no longer exists".
  test('the closing panel keeps showing the session it showed', async () => {
    const { view } = await renderDetail();
    view.rerender(<SessionDetailModal sessionId={null} onClose={() => {}} />);
    const closing = document.querySelector('[data-state="closing"] ~ *');
    expect(closing).not.toBeNull();
    expect(screen.queryByText('This session no longer exists')).toBeNull();
    expect(screen.getAllByText('Refactor the parser').length).toBeGreaterThan(
      0
    );
  });

  // Loading announces itself once, not once per skeleton shape.
  test('the loading state has one status for assistive tech', () => {
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: () => new Promise(() => undefined),
    };
    render(<SessionDetailModal sessionId={SESSION_ID} onClose={() => {}} />, {
      wrapper: withQueryClient(),
    });
    const panel = screen.getByRole('dialog', { name: 'Session detail' });
    const statuses = within(panel).getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.textContent).toBe('Loading session');
  });

  test('a failed load shows the error state', async () => {
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: () => Promise.reject(new Error('backend down')),
    };
    render(<SessionDetailModal sessionId={SESSION_ID} onClose={() => {}} />, {
      wrapper: withQueryClient(),
    });
    const panel = screen.getByRole('dialog', { name: 'Session detail' });
    await waitFor(() =>
      expect(within(panel).getByText('Couldn’t load this session')).toBeTruthy()
    );
  });
});
