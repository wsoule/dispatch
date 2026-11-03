import { expect, type Page, test, type TestInfo } from '@playwright/test';

import type {
  DashboardStats,
  FileDiff,
  ReportData,
  Session,
  SessionDetail,
} from '../src/lib/types';
import { APP_TOKEN, DAEMON_PORT, ROOT } from './paths';
import { waitForShell } from './shell';

// The views the design reviews flagged for WebKit, opened in the WebKit pass
// (DISPATCH_E2E_WEBKIT=1, see playwright.config.ts) and saved as full-page
// PNGs under test-results/webkit for a person to look at: Tauri draws the
// desktop app with WKWebView on macOS, and Chromium baselines cannot show what
// it does differently. Nothing here compares pixels, so a rendering
// difference never fails the run; each test only checks that its view
// opened on real data before the shot, so a blank page cannot pass as one.

const FIXED_NOW = new Date('2026-10-09T12:00:00Z');
const NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

// The app URL signed in as the owner, as the other specs build it: the
// daemon's request-tier token comes from global-setup.ts and the decide-tier
// app token is the harness's preset constant. A hash opens the app on a route.
function appUrl(baseURL: string | undefined, hash = ''): string {
  const token = process.env.DISPATCH_E2E_TOKEN;
  if (!baseURL) throw new Error('baseURL is not configured');
  if (!token) {
    throw new Error(
      'DISPATCH_E2E_TOKEN is unset: global-setup.ts resolves it before any ' +
        'test runs, and without it every view renders its empty state.'
    );
  }
  return `${baseURL}&token=${token}&appToken=${APP_TOKEN}${hash}`;
}

// Opens the app on `hash` with the clock pinned, so relative ages read the
// same on every run, and waits for the shell.
async function openOn(
  page: Page,
  baseURL: string | undefined,
  hash: string
): Promise<void> {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.goto(appUrl(baseURL, hash));
  await waitForShell(page);
}

// Saves a full-page shot as `<name>.png` in this test's output folder
// (test-results/webkit/<test>/), which the macOS workflow uploads. The pointer
// is parked first so no hover state is captured, and the wait lets the
// in-flight pulses settle, as views.spec.ts does.
async function saveShot(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: true,
  });
}

// ShimmerLabel paints its words with a gradient clipped to the glyphs over
// transparent text. An engine that drops `background-clip: text` shows an
// empty cell, so this reads the computed clip and fails on anything else,
// without comparing a single pixel.
async function expectShimmerClipsToText(page: Page): Promise<void> {
  const shimmer = page.locator('[data-shimmer]').first();
  await expect(shimmer).toBeVisible();
  const clip = await shimmer.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      clip: style.backgroundClip,
      prefixed: style.getPropertyValue('-webkit-background-clip'),
      color: style.color,
    };
  });
  if (clip.color === 'rgba(0, 0, 0, 0)') {
    expect(
      [clip.clip, clip.prefixed],
      'shimmering words are transparent but not clipped to text, so they ' +
        'would show as an empty cell'
    ).toContain('text');
  }
}

// The task title of the run on the Runs page's top row. The row's button is
// named by its facts, title first ("Cache the search index in redis, Sonnet 5,
// finished, …"). Read from the page rather than the daemon's list because the
// page hides some runs (an archived task's), and earlier specs in the pass
// add and archive runs on the shared daemon.
async function topRunTitle(page: Page): Promise<string> {
  const row = page
    .getByRole('list', { name: 'Agents' })
    .getByRole('listitem')
    .first()
    .getByRole('button')
    .first();
  await expect(row).toBeVisible();
  const name = (await row.getAttribute('aria-label')) ?? '';
  const title = name.split(', ')[0] ?? '';
  expect(title, 'the top run row has no title').not.toBe('');
  return title;
}

// The storefront fixture's runs have all finished, and a live outcome is the
// only one that shimmers, so this answers the app's run list with the newest
// run of `taskTitle` still `running`: the daemon's own list, one field
// changed, which is exactly what it sends while an agent works.
async function showRunLive(page: Page, taskTitle: string): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/runs',
    async (route) => {
      const response = await route.fetch();
      const runs = (await response.json()) as {
        taskTitle?: string;
        updatedAt: string;
        state: string;
      }[];
      const newest = runs
        .filter((run) => run.taskTitle === taskTitle)
        .reduce<(typeof runs)[number] | undefined>(
          (best, run) =>
            best === undefined || run.updatedAt > best.updatedAt ? run : best,
          undefined
        );
      await route.fulfill({
        response,
        json: runs.map((run) =>
          run === newest ? { ...run, state: 'running' } : run
        ),
      });
    }
  );
}

test('Runs: the live outcome cell shimmers', async ({
  page,
  baseURL,
}, testInfo) => {
  await openOn(page, baseURL, '#/runs');
  await showRunLive(page, await topRunTitle(page));
  await page.reload();
  await waitForShell(page);
  await expect(
    page.getByRole('radio', { name: /^Live, [1-9]\d*$/ }),
    'the run list did not pick up the live run'
  ).toBeVisible();
  await expectShimmerClipsToText(page);
  await saveShot(page, testInfo, 'runs');
});

test('Live: the bands and their layers', async ({
  page,
  baseURL,
}, testInfo) => {
  await openOn(page, baseURL, '#/live');
  await expect(page.getByRole('group', { name: 'Live work' })).toBeVisible();
  await saveShot(page, testInfo, 'live');
});

test('Issues: the board', async ({ page, baseURL }, testInfo) => {
  await openOn(page, baseURL, '#/issues?mode=board');
  await expect(page.getByTestId('board-pane')).toBeVisible();
  await saveShot(page, testInfo, 'board');
});

// ---- Usage -----------------------------------------------------------------
//
// Usage reads agent session logs through the desktop app's native side, so a
// browser shows only "Usage lives in the desktop app". This test stands in
// for that side: an init script installs the `window.__TAURI_INTERNALS__`
// that @tauri-apps/api calls (the same shape its own `mocks.mockIPC` sets) and
// answers each command from the fixtures below, with the e2e daemon as the
// project's dispatchd. The fixtures are typed with the app's own interfaces,
// so a changed IPC shape fails tsc here, not silently at run time.

const PROJECT_ID = 'p-storefront';

const SESSION: Session = {
  id: 'c0ffee00-5e55-4d1e-9a7b-000000000001',
  project_id: PROJECT_ID,
  agent: 'claude-code',
  model: 'claude-opus-5',
  started_at: NOW_SECONDS - 3600,
  ended_at: null,
  last_activity_at: NOW_SECONDS - 120,
  status: 'active',
  duration_seconds: null,
  summary: 'Rate limit the search endpoint',
  title: 'Rate limit the search endpoint',
  prompt_tokens: 48_210,
  completion_tokens: 9_840,
  cache_read_tokens: 120_400,
  cache_creation_tokens: 8_100,
  cost_usd: 3.42,
  lines_added: 64,
  lines_removed: 12,
  tags: 'backend,search',
  raw_log_path: '/tmp/session.jsonl',
};

const DETAIL: SessionDetail = {
  session: SESSION,
  files_changed: [
    {
      id: 1,
      session_id: SESSION.id,
      file_path: 'src/server/rate_limit.ts',
      change_type: 'write',
      lines_added: 52,
      lines_removed: 0,
      occurred_at: NOW_SECONDS - 3000,
    },
    {
      id: 2,
      session_id: SESSION.id,
      file_path: 'src/server/routes/search.ts',
      change_type: 'edit',
      lines_added: 12,
      lines_removed: 12,
      occurred_at: NOW_SECONDS - 2400,
    },
  ],
};

const PROJECT = {
  id: PROJECT_ID,
  name: 'storefront',
  path: ROOT,
  lang: 'TypeScript',
  stack: null,
  created_at: NOW_SECONDS - 86_400 * 30,
  last_active: SESSION.last_activity_at,
  session_count: 1,
  total_cost_usd: SESSION.cost_usd,
  agents: ['claude-code'],
};

const STATS: DashboardStats = {
  total_cost_usd: SESSION.cost_usd,
  total_sessions: 1,
  total_projects: 1,
  daily_activity: [],
  top_projects: [PROJECT],
  agent_usage: [
    {
      agent: 'claude-code',
      session_count: 1,
      total_cost_usd: SESSION.cost_usd,
    },
  ],
  model_usage: [
    {
      model: SESSION.model,
      session_count: 1,
      total_cost_usd: SESSION.cost_usd,
    },
  ],
  active_session: null,
};

const REPORT: ReportData = {
  range_days: 30,
  since_epoch: NOW_SECONDS - 86_400 * 30,
  totals: {
    total_cost_usd: SESSION.cost_usd,
    session_count: 1,
    prompt_tokens: SESSION.prompt_tokens,
    completion_tokens: SESSION.completion_tokens,
    cache_read_tokens: SESSION.cache_read_tokens,
    cache_creation_tokens: SESSION.cache_creation_tokens,
  },
  by_project: [
    {
      project_id: PROJECT_ID,
      project_name: 'storefront',
      session_count: 1,
      total_cost_usd: SESSION.cost_usd,
    },
  ],
  by_tag: [],
  by_agent: STATS.agent_usage,
};

const DIFF: FileDiff = {
  lines: [
    { tag: 'equal', content: "import { Router } from './router';" },
    { tag: 'insert', content: 'const WINDOW_MS = 60_000;' },
    { tag: 'insert', content: 'const LIMIT = 30;' },
  ],
  truncated: false,
  occurred_at: NOW_SECONDS - 3000,
  edit_count: 1,
};

// Each IPC command the Usage page and the app's boot call, with its answer.
// Anything else (plugins, notifications, the updater) answers null, which
// every caller in src/ treats as "nothing there".
function ipcAnswers(agentToken: string): Record<string, unknown> {
  return {
    current_project_root: ROOT,
    has_dispatch: true,
    ensure_dispatchd: { port: DAEMON_PORT, appToken: APP_TOKEN, agentToken },
    list_registered_projects: [{ path: ROOT, name: 'storefront' }],
    list_projects: [PROJECT],
    list_sessions: [SESSION],
    get_session_detail: DETAIL,
    dashboard_stats: STATS,
    generate_report: REPORT,
    get_file_diff_for_session_file: DIFF,
  };
}

// Installs a stand-in for Tauri's native bridge before any app script runs.
// Runs in the page, so it takes its answers as an argument.
function installTauriBridge(answers: Record<string, unknown>): void {
  const callbacks = new Map<number, (data: unknown) => void>();
  let nextId = 1;
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
      invoke: (cmd: string) =>
        Promise.resolve(cmd in answers ? answers[cmd] : null),
      transformCallback: (callback?: (data: unknown) => void) => {
        const id = nextId++;
        if (callback) callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (path: string) => path,
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
  });
}

test('Usage: the session detail and its diff stack', async ({
  page,
  baseURL,
}, testInfo) => {
  const token = process.env.DISPATCH_E2E_TOKEN;
  if (!token) throw new Error('DISPATCH_E2E_TOKEN is unset');
  await page.addInitScript(installTauriBridge, ipcAnswers(token));
  await openOn(page, baseURL, '#/settings/usage');

  const row = page.getByRole('button', { name: /^storefront: Rate limit/ });
  await expect(row).toBeVisible();
  await expectShimmerClipsToText(page);
  await saveShot(page, testInfo, 'usage');

  await row.click();
  const detail = page.getByRole('dialog', {
    name: 'Rate limit the search endpoint',
  });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('src/server/rate_limit.ts')).toBeVisible();
  await saveShot(page, testInfo, 'usage-session');

  await detail.getByRole('button', { name: 'View diff' }).first().click();
  await expect(page.getByText('const LIMIT = 30;')).toBeVisible();
  await saveShot(page, testInfo, 'usage-session-diff');
});
