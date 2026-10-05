import type { TaskDoc } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { TaskCardTile } from './TaskCardTile';

function task(overrides: Partial<TaskDoc['meta']> = {}): TaskDoc {
  return {
    meta: {
      id: 't-1',
      title: 'Cache the search index in redis',
      status: 'working',
      kind: 'task',
      priority: 'high',
      parent: 'e-1',
      milestone: null,
      labels: ['ui', 'api', 'infra'],
      assignee: 'agent',
      blockedBy: [],
      created: `${new Date().getFullYear()}-09-13T12:00:00.000Z`,
      updated: `${new Date().getFullYear()}-09-14T12:00:00.000Z`,
      ...overrides,
    },
    body: '',
  } as unknown as TaskDoc;
}

function renderCard(
  props: Partial<Parameters<typeof TaskCardTile>[0]> = {},
  doc = task()
) {
  return render(
    <TaskCardTile
      doc={doc}
      ready={false}
      blocked={false}
      liveRunState={undefined}
      epicTitle="Payments"
      statuses={['ready', 'working', 'landed']}
      onStatusChange={() => {}}
      onEditTask={() => {}}
      onClick={() => {}}
      {...props}
    />
  );
}

function card(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-slot=task-card]');
  if (el === null) throw new Error('no card');
  return el;
}

function slot(name: string): HTMLElement {
  const el = card().querySelector<HTMLElement>(`[data-slot=task-card-${name}]`);
  if (el === null) throw new Error(`no ${name} row`);
  return el;
}

test('renders the four rows: id › epic + avatar, glyph + title, priority + pills, Created', () => {
  renderCard();
  const rows = Array.from(card().children).map((el) =>
    el.getAttribute('data-slot')
  );
  expect(rows).toEqual([
    'task-card-meta',
    'task-card-title',
    'task-card-pills',
    'task-card-footer',
  ]);
  // Row 1: id, the ` › Payments` crumb as plain text, the 18px assignee pushed right.
  expect(slot('meta').textContent).toMatch(/^t-1›Payments/);
  expect(
    slot('meta').querySelector('[data-slot=initials-avatar]')
  ).not.toBeNull();
  expect(slot('meta').querySelector('svg.lucide-chevron-right')).toBeNull();
  // Row 2: 14px status picker + a two-line 13px/500 title.
  expect(screen.getByRole('button', { name: 'Change status' })).not.toBeNull();
  const title = screen.getByText('Cache the search index in redis');
  expect(title.className).toContain('line-clamp-2');
  expect(title.className).toContain('text-[13px]');
  expect(title.className).toContain('font-medium');
  // Row 3: priority picker + two label pills + a `+1` for the rest.
  expect(
    screen.getByRole('button', { name: 'Change priority' })
  ).not.toBeNull();
  const pills = Array.from(
    slot('pills').querySelectorAll('[data-slot=label-pill]')
  ).map((p) => p.textContent);
  expect(pills).toEqual(['ui', 'api']);
  expect(slot('pills').textContent).toContain('+1');
  // Row 4: the absolute created date.
  expect(slot('footer').textContent).toBe('Created Sep 13');
});

test('the card is a 322px quaternary tile with the half-pixel ring and no mono', () => {
  renderCard();
  const el = card();
  expect(el.className).toContain('w-[322px]');
  expect(el.className).toContain('bg-surface-quaternary');
  expect(el.className).toContain('rounded-card');
  expect(el.className).toContain('shadow-card');
  expect(el.className).toContain('p-3');
  expect(el.outerHTML).not.toContain('font-mono');
  expect(el.className).not.toContain('ring-state-waiting');
  expect(el.className).not.toContain('ring-ring');
});

test('the keyboard cursor is a neutral raised ring, never the accent', () => {
  renderCard({ focused: true });
  const el = card();
  expect(el.dataset['focused']).toBe('true');
  expect(el.className).toContain('data-[focused=true]:shadow-raised');
  expect(el.className).not.toContain('ring-ring');
  expect(document.activeElement).toBe(el);
});

test('attention and blocked read as pills on row 3', () => {
  renderCard({ needsAttention: true, blocked: true });
  const pills = Array.from(
    slot('pills').querySelectorAll('[data-slot=label-pill]')
  ).map((p) => p.textContent);
  expect(pills.slice(0, 2)).toEqual(['Blocked', 'Needs you']);
  expect(card().className).not.toContain('ring-state-waiting');
});

test('a live run shows the compact mark and the merge ladder a pill', () => {
  const run = {
    id: 'r-1',
    taskId: 't-1',
    state: 'running',
    branch: 'dispatch/t-1',
  } as unknown as RunMeta;
  renderCard({ liveRunState: 'running', run });
  expect(
    slot('pills').querySelector('[data-slot=run-state-mark]')
  ).not.toBeNull();
});

test('the Dispatch action is a ghost button on row 4 for a ready card', async () => {
  let dispatched = 0;
  renderCard({
    ready: true,
    onDispatch: () => {
      dispatched += 1;
      return Promise.resolve();
    },
  });
  const button = screen.getByRole('button', { name: 'Dispatch' });
  expect(slot('footer').contains(button)).toBe(true);
  expect(button.dataset['variant']).toBe('ghost');
  expect(button.className).not.toContain('opacity-0');
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
  expect(dispatched).toBe(1);
});

test('display properties hide the id, crumb, assignee, labels and priority', () => {
  renderCard({ properties: new Set(['status']) });
  expect(slot('meta').textContent).toBe('');
  expect(screen.queryByRole('button', { name: 'Change priority' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Change assignee' })).toBeNull();
  expect(slot('pills').querySelector('[data-slot=label-pill]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Change status' })).not.toBeNull();
});

test('an archived card dims and says so', () => {
  renderCard({ archived: true });
  expect(card().className).toContain('opacity-55');
  expect(slot('pills').textContent).toContain('Archived');
});

test('Enter opens the card; a nested control keeps its own keys', () => {
  let opened = 0;
  renderCard({ onClick: () => (opened += 1) });
  fireEvent.keyDown(card(), { key: 'Enter' });
  expect(opened).toBe(1);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Change status' }), {
    key: 'Enter',
  });
  expect(opened).toBe(1);
});

// A popover positions itself a microtask after mount (floating-ui), so a click that opens
// one runs inside an async `act` that lets that settle.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

test('clicking a label pill opens the labels picker over the catalogue, not the task', async () => {
  let opened = 0;
  const patches: unknown[] = [];
  renderCard({
    onClick: () => (opened += 1),
    onEditTask: (id, patch) => patches.push([id, patch]),
    labelCatalogue: ['docs', 'ui'],
  });
  const trigger = screen.getByRole('button', { name: 'Change labels' });
  expect(slot('pills').contains(trigger)).toBe(true);
  // The pills are the trigger's face; the `+1` overflow stays outside it.
  expect(
    Array.from(trigger.querySelectorAll('[data-slot=label-pill]')).map(
      (p) => p.textContent
    )
  ).toEqual(['ui', 'api']);
  expect(trigger.textContent).not.toContain('+1');
  await settle(() => {
    fireEvent.click(trigger);
  });
  expect(opened).toBe(0);
  const options = screen.getAllByRole('option').map((o) => ({
    label: o.textContent,
    checked: o.querySelector('svg.lucide-check') !== null,
  }));
  expect(options).toEqual([
    { label: 'api', checked: true },
    { label: 'docs', checked: false },
    { label: 'infra', checked: true },
    { label: 'ui', checked: true },
  ]);
  await settle(() => {
    const option = screen.getByRole('option', { name: /^docs$/ });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  });
  expect(patches).toEqual([
    ['t-1', { labels: ['ui', 'api', 'infra', 'docs'] }],
  ]);
  expect(opened).toBe(0);
});

test('a card without labels grows no picker', () => {
  renderCard({ labelCatalogue: ['ui'] }, task({ labels: [] }));
  expect(screen.queryByRole('button', { name: 'Change labels' })).toBeNull();
  expect(slot('pills').querySelector('[data-slot=label-pill]')).toBeNull();
});

test('a card whose run is in the merge queue shows a Landing pill on row 3', () => {
  renderCard({ landing: 'rebasing' });
  const badge = slot('pills').querySelector('[data-slot=landing-badge]');
  expect(badge?.textContent).toBe('Landing');
  expect(badge?.getAttribute('title')).toBe('Landing · rebasing');
});
