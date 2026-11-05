import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import { SessionsHubView } from './SessionsHubView';

afterEach(cleanup);

test('outside the desktop app, Usage says where to find it instead of loading forever', () => {
  render(<SessionsHubView />);
  expect(screen.getByText('Usage lives in the desktop app')).toBeDefined();
});

// The browser build is one @dispatch/ui EmptyState: its title and sentence sit in the same
// empty box, and none of the Tauri body (the window toolbar, the lists) renders.
test('the browser build reads as an empty state with its explanation', () => {
  render(<SessionsHubView />);
  const title = screen.getByText('Usage lives in the desktop app');
  const box = title.closest('.empty');
  expect(box).not.toBeNull();
  expect(box?.textContent).toContain(
    'It reads the agent session logs on the machine running Dispatch'
  );
  expect(screen.queryByRole('group', { name: 'Usage options' })).toBeNull();
  expect(screen.queryByRole('radiogroup', { name: 'Spend window' })).toBeNull();
  expect(screen.queryByRole('list')).toBeNull();
});

// ---- The desktop body -------------------------------------------------------------------
// Tauri's `invoke` calls `window.__TAURI_INTERNALS__.invoke`: defining it plays the desktop
// backend for the four reads the page makes (and the detail a row opens), without
// mock.module (which bun hoists across every file in the run).

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
};

function project(id: string, name: string, cost: number, count: number) {
  return {
    id,
    name,
    path: `/code/${id}`,
    lang: null,
    stack: null,
    created_at: 0,
    last_active: 0,
    session_count: count,
    total_cost_usd: cost,
    agents: ['claude'],
  };
}

function usageSession(id: string, projectId: string, summary: string) {
  return {
    id,
    project_id: projectId,
    agent: 'claude',
    model: null,
    started_at: null,
    ended_at: null,
    last_activity_at: Math.floor(Date.now() / 1000),
    status: 'ended',
    duration_seconds: null,
    summary,
    title: null,
    prompt_tokens: 100,
    completion_tokens: 20,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0.1,
    lines_added: 0,
    lines_removed: 0,
    tags: null,
    raw_log_path: `/tmp/${id}.jsonl`,
  };
}

/** Installs the fake backend and returns the generate_report windows it was asked for. */
function fakeDesktop(): number[] {
  const reportWindows: number[] = [];
  (window as TauriWindow).__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      switch (cmd) {
        case 'dashboard_stats':
          return Promise.resolve({
            total_cost_usd: 12.5,
            total_sessions: 3,
            total_projects: 2,
            daily_activity: [],
            top_projects: [],
            agent_usage: [],
            model_usage: [
              { model: null, session_count: 3, total_cost_usd: 12.5 },
            ],
            active_session: null,
          });
        case 'generate_report': {
          const days = Number(args?.rangeDays);
          reportWindows.push(days);
          return Promise.resolve({
            range_days: days,
            since_epoch: 0,
            totals: { total_cost_usd: days / 10 },
            by_project: [],
            by_tag: [],
            by_agent: [],
          });
        }
        case 'list_projects':
          return Promise.resolve([
            project('p-a', 'atlas', 10, 2),
            project('p-b', 'borealis', 2.5, 1),
          ]);
        case 'list_sessions':
          return Promise.resolve([
            usageSession('s-1', 'p-a', 'Atlas one'),
            usageSession('s-2', 'p-a', 'Atlas two'),
            usageSession('s-3', 'p-b', 'Borealis one'),
          ]);
        default:
          return Promise.reject(new Error(`unexpected command ${cmd}`));
      }
    },
  };
  return reportWindows;
}

function renderDesktop() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionsHubView />
    </QueryClientProvider>
  );
}

describe('the desktop body', () => {
  afterEach(() => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  });

  // The toolbar's window control drives the windowed headline: picking 7 days asks the
  // backend for a 7-day report and relabels the figure.
  test('switching the spend window refetches the report and relabels the headline', async () => {
    const windows = fakeDesktop();
    renderDesktop();
    const summary = await screen.findByRole('list', { name: 'Spend summary' });
    expect(within(summary).getByText('Spend (30d)')).toBeDefined();
    expect(within(summary).getByText('$12.50')).toBeDefined();
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(windows).toContain(7));
    expect(within(summary).getByText('Spend (7d)')).toBeDefined();
    await waitFor(() =>
      expect(within(summary).getByText('$0.70')).toBeDefined()
    );
  });

  // A project row is a pressed toggle that filters the session list below; the chip's clear
  // button (or a second press on the row) drops the filter.
  test('a project row filters the sessions, and Clear project filter restores them', async () => {
    fakeDesktop();
    renderDesktop();
    const sessions = await screen.findByRole('list', { name: 'Sessions' });
    expect(within(sessions).getAllByRole('listitem')).toHaveLength(3);

    const projects = screen.getByRole('list', { name: 'Project spend' });
    const borealis = within(projects).getByRole('button', { name: 'borealis' });
    expect(borealis.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(borealis);
    expect(borealis.getAttribute('aria-pressed')).toBe('true');
    expect(within(sessions).getAllByRole('listitem')).toHaveLength(1);
    expect(within(sessions).getByText('Borealis one')).toBeDefined();

    fireEvent.click(
      screen.getByRole('button', { name: 'Clear project filter' })
    );
    expect(borealis.getAttribute('aria-pressed')).toBe('false');
    expect(within(sessions).getAllByRole('listitem')).toHaveLength(3);
  });

  // The model table is plain rows (no filter): no buttons in it.
  test('the model table is read-only and the session list leads with the project', async () => {
    fakeDesktop();
    renderDesktop();
    const models = await screen.findByRole('list', { name: 'Model spend' });
    expect(within(models).queryAllByRole('button')).toHaveLength(0);
    const sessions = await screen.findByRole('list', { name: 'Sessions' });
    expect(
      within(sessions).getByRole('button', { name: /^atlas: Atlas one, Ended/ })
    ).toBeDefined();
  });
});
