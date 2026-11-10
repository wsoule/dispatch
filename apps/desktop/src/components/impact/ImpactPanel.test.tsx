import type { ApiClient, ImpactReach, ImpactResponse } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { impactErrorMessage, ImpactPanel } from './ImpactPanel';

test('a run with nothing to diff reads as plain words, not the daemon error', () => {
  const msg = impactErrorMessage(
    new ApiError('run has no worktree to diff: r-1e6a4f', 409)
  );
  expect(msg).not.toContain('r-1e6a4f');
  expect(msg).toContain('Nothing to measure');
});

test('other daemon errors still say what went wrong', () => {
  expect(impactErrorMessage(new ApiError('carto timed out', 504))).toBe(
    'carto timed out'
  );
  expect(impactErrorMessage(new Error('boom'))).toBe(
    "Couldn't load the blast radius."
  );
});

const reach = (over: Partial<ImpactReach> = {}): ImpactReach => ({
  entries: [
    { path: 'a.ts', hops: 1 },
    { path: 'b.ts', hops: 1 },
    { path: 'c.ts', hops: 2 },
    { path: 'd.ts', hops: 3 },
    { path: 'e.ts', hops: 3 },
  ],
  count: 5,
  maxHops: 3,
  sources: ['carto'],
  degraded: false,
  truncated: false,
  unanalyzedSeeds: [],
  ...over,
});

// Only getImpact: a panel that started fetching anything else would fail
// here rather than pass quietly.
function renderPanel(answer: () => Promise<ImpactResponse>) {
  const client = {
    baseUrl: 'http://127.0.0.1:4321',
    getImpact: answer,
  } as unknown as ApiClient;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImpactPanel client={client} subject="run" id="r-1" />
    </QueryClientProvider>
  );
}

const answered =
  (r: ImpactReach, reason?: string) => (): Promise<ImpactResponse> =>
    Promise.resolve({
      subject: { kind: 'run', runId: 'r-1' },
      seeds: ['src/a.ts'],
      reach: r,
      ...(reason === undefined ? {} : { reason }),
    });

test('while the reach loads it says so to assistive tech', () => {
  renderPanel(() => new Promise<ImpactResponse>(() => {}));
  const status = screen.getByRole('status');
  expect(status.textContent).toContain('Loading the blast radius');
});

test('a reach shows Direct, Downstream and Total as three stat cells', async () => {
  renderPanel(answered(reach()));
  const strip = await screen.findByRole('list', { name: 'Blast radius' });
  const cells = within(strip).getAllByRole('listitem');
  expect(cells.map((cell) => cell.textContent)).toEqual([
    'Direct2',
    'Downstream3',
    'Total5',
  ]);
  // A bigger reach is no status: the counts take no status hue (the old
  // direction chip painted "more downstream" green and "less" red).
  for (const cell of cells) {
    expect(cell.getAttribute('data-tone')).toBe('default');
  }
  expect(screen.getByText('5 files · 3 hops')).toBeDefined();
  expect(screen.getByRole('heading', { name: 'Impact' })).toBeDefined();
});

test('a capped reach marks its total as a lower bound', async () => {
  renderPanel(answered(reach({ truncated: true })));
  const strip = await screen.findByRole('list', { name: 'Blast radius' });
  expect(within(strip).getAllByRole('listitem')[2]?.textContent).toBe(
    'Total5+'
  );
  expect(screen.getByText('Capped')).toBeDefined();
  // The header's count is an exact number, so a lower bound shows none.
  expect(document.querySelector('[data-part="count"]')).toBeNull();
});

test('an uncapped reach counts its total in the header', async () => {
  renderPanel(answered(reach()));
  await screen.findByRole('list', { name: 'Blast radius' });
  expect(document.querySelector('[data-part="count"]')?.textContent).toBe('5');
});

// The scanner only reads .ts/.tsx imports, so its count needs a caveat a
// keyboard can reach as well as a pointer.
test('a scanner-only reach explains its caveat on keyboard focus', async () => {
  renderPanel(answered(reach({ sources: ['scanner'] })));
  const label = await screen.findByText('scanner only (.ts/.tsx)');
  const trigger = label.closest('[tabindex="0"]');
  expect(trigger).not.toBeNull();
  // The tip is aria-hidden (its words reach the trigger as a description),
  // so it is found with `hidden`.
  const tip = () => screen.queryByRole('tooltip', { hidden: true });
  expect(tip()).toBeNull();
  act(() => {
    if (trigger instanceof HTMLElement) trigger.focus();
  });
  expect(tip()?.textContent).toBe(
    'Only .ts/.tsx imports are tracked. Other languages may be missing.'
  );
  expect(trigger?.getAttribute('aria-describedby')).toBe(tip()?.id ?? 'none');
  act(() => {
    if (trigger instanceof HTMLElement) trigger.blur();
  });
  expect(tip()).toBeNull();
});

test('a carto reach has no caveat to explain', async () => {
  renderPanel(answered(reach()));
  const label = await screen.findByText('carto only');
  expect(label.closest('[tabindex="0"]')).toBeNull();
});

test('a run with nothing to measure shows the 409 in plain words', async () => {
  renderPanel(() =>
    Promise.reject(new ApiError('run has no worktree to diff: r-1', 409))
  );
  expect(
    await screen.findByText(
      'Nothing to measure: this run has no checkout or saved changes.'
    )
  ).toBeDefined();
  expect(screen.queryByText(/r-1$/)).toBeNull();
});

test('an empty task reach names its reason instead of a bare zero', async () => {
  renderPanel(
    answered(reach({ entries: [], count: 0, maxHops: 0 }), 'no-declared-writes')
  );
  expect(
    await screen.findByText(
      'This task declares no writes, so it has no blast radius to show.'
    )
  ).toBeDefined();
  expect(screen.queryByRole('list', { name: 'Blast radius' })).toBeNull();
});

test('a genuine zero reads as no files affected', async () => {
  renderPanel(answered(reach({ entries: [], count: 0, maxHops: 0 })));
  expect(await screen.findByText('No files affected.')).toBeDefined();
});
