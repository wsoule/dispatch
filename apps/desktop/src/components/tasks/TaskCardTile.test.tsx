import type { TaskDoc } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyLabelColors } from '../../lib/labelColor';
import { TaskCardTile } from './TaskCardTile';

const css = readFileSync(
  join(import.meta.dir, 'TaskCardTile.module.css'),
  'utf8'
);

/** The body of one top-level rule of the card's module, for a property check. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
}

// Unmount before clearing the registry, so the clear does not re-render a card outside act.
afterEach(() => {
  cleanup();
  applyLabelColors(null);
});

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
      milestoneTitle="Payments"
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

function openButton(): HTMLElement {
  const el = card().querySelector<HTMLElement>('[data-task-card-open]');
  if (el === null) throw new Error('no open button');
  return el;
}

function slot(name: string): HTMLElement {
  const el = card().querySelector<HTMLElement>(`[data-slot=task-card-${name}]`);
  if (el === null) throw new Error(`no ${name} row`);
  return el;
}

test('renders the four rows: id › milestone + avatar, glyph + title, priority + pills, Created', () => {
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
  // Row 1: id, the ` › Payments` crumb as plain text, the assignee picker pushed right.
  expect(slot('meta').textContent).toMatch(/^t-1›Payments/);
  const assignee = screen.getByRole('button', { name: 'Change assignee' });
  expect(slot('meta').contains(assignee)).toBe(true);
  expect(
    assignee
      .querySelector('[data-slot=assignee-avatar]')
      ?.getAttribute('data-size')
  ).toBe('16');
  expect(slot('meta').querySelector('svg.lucide-chevron-right')).toBeNull();
  // Row 2: the status picker with the status glyph as its face + a two-line title.
  const status = screen.getByRole('button', { name: 'Change status' });
  expect(status.dataset['appearance']).toBe('mark');
  expect(
    status.querySelector('[data-status-shape]')?.getAttribute('aria-label')
  ).toBe('Status: working');
  expect(screen.getByText('Cache the search index in redis')).not.toBeNull();
  expect(rule('.title')).toContain('-webkit-line-clamp: 2');
  expect(rule('.title')).toContain('font-weight: var(--fw-medium)');
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

test('the card is a 322px tile on the surface with a soft border and no shadow', () => {
  renderCard();
  const el = card();
  expect(el.getAttribute('style')).toBeNull();
  const tile = rule('.card');
  expect(tile).toContain('width: 322px');
  expect(tile).toContain('background: var(--surface)');
  expect(tile).toContain('border: 1px solid var(--border)');
  expect(tile).toContain('border-radius: var(--r-lg)');
  expect(tile).toContain('padding: var(--s-3)');
  expect(css).not.toContain('box-shadow');
  expect(css).not.toMatch(/outline:\s*none/);
  // Only the id is mono (a machine-read string); the title and crumb are sans.
  expect(rule('.id')).toContain('font-family: var(--font-mono)');
  expect(css.match(/font-mono/g)).toHaveLength(1);
});

test('the keyboard cursor is a neutral edge; keyboard focus rings the card', () => {
  renderCard({ focused: true });
  const el = card();
  expect(el.dataset['focused']).toBe('true');
  expect(rule(".card[data-focused='true']")).toContain(
    'border-color: var(--border-strong)'
  );
  expect(rule('.card:has([data-task-card-open]:focus-visible)')).toContain(
    'outline: 2px solid var(--focus-ring)'
  );
  expect(document.activeElement).toBe(openButton());
});

test('attention and blocked read as pills on row 3', () => {
  renderCard({ needsAttention: true, blocked: true });
  const pills = Array.from(
    slot('pills').querySelectorAll('[data-slot=label-pill]')
  ).map((p) => p.textContent);
  expect(pills.slice(0, 2)).toEqual(['Blocked', 'Needs you']);
  // Blocked and Needs you are amber (warning) badges; the card itself is never tinted.
  const [blockedPill, attentionPill] = Array.from(
    slot('pills').querySelectorAll<HTMLElement>('[data-slot=label-pill]')
  );
  expect(blockedPill?.dataset['tone']).toBe('warning');
  expect(attentionPill?.dataset['tone']).toBe('warning');
  expect(card().dataset['tone']).toBeUndefined();
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

test('the Dispatch action is a quiet button on row 4 for a ready card', async () => {
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
  expect(button.dataset['variant']).toBe('quiet');
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

test('an archived card dims, says so and shows plain label pills', () => {
  renderCard({ archived: true });
  expect(card().dataset['archived']).toBe('true');
  expect(rule('.card[data-archived]')).toContain('opacity: 0.55');
  expect(slot('pills').textContent).toContain('Archived');
  expect(screen.queryByRole('button', { name: 'Change labels' })).toBeNull();
  expect(
    Array.from(slot('pills').querySelectorAll('[data-slot=label-pill]')).map(
      (p) => p.textContent
    )
  ).toEqual(['ui', 'api']);
});

test('the title is the real button that opens the card; a nested control keeps its own keys', () => {
  let opened = 0;
  renderCard({ onClick: () => (opened += 1) });
  const open = openButton();
  expect(open.tagName).toBe('BUTTON');
  expect(open.textContent).toBe('Cache the search index in redis');
  // No control nests inside it: the pickers sit beside it, above its stretched hit area.
  expect(open.querySelector('button')).toBeNull();
  fireEvent.click(open);
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
    checked: o.getAttribute('aria-selected') === 'true',
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

// Ported from PropertyControls.test's LabelsControl cases: the card's labels picker
// creates a new label from the search box, but never a case-variant of one it lists.
test('typing an unknown name in the labels picker offers Create and appends it', async () => {
  const patches: unknown[] = [];
  renderCard({
    onEditTask: (id, patch) => patches.push([id, patch]),
    labelCatalogue: ['docs'],
  });
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Change labels' }));
  });
  await settle(() => {
    fireEvent.change(screen.getByPlaceholderText('Add labels…'), {
      target: { value: '  perf ' },
    });
  });
  await settle(() => {
    const create = screen.getByRole('option', { name: /Create.*perf/ });
    fireEvent.pointerDown(create);
    fireEvent.click(create);
  });
  expect(patches).toEqual([
    ['t-1', { labels: ['ui', 'api', 'infra', 'perf'] }],
  ]);
});

test('a case-variant of a listed label is not offered for creation', async () => {
  renderCard({ labelCatalogue: ['docs'] });
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Change labels' }));
  });
  for (const typed of ['UI', 'Docs']) {
    await settle(() => {
      fireEvent.change(screen.getByPlaceholderText('Add labels…'), {
        target: { value: typed },
      });
    });
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
  }
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

test('a label pill draws the registry swatch, else a decorative hue', () => {
  applyLabelColors([{ name: 'ui', color: '#5e6ad2' }]);
  renderCard();
  const [ui, api] = Array.from(
    slot('pills').querySelectorAll<HTMLElement>('[data-slot=label-pill]')
  );
  expect(ui?.querySelector('[data-chip-mark]')).not.toBeNull();
  expect(ui?.querySelector('[data-hue]')).toBeNull();
  expect(api?.querySelector('[data-chip-mark]')).toBeNull();
  expect(['violet', 'teal', 'rose', 'orange']).toContain(
    api?.querySelector('[data-hue]')?.getAttribute('data-hue') ?? ''
  );
});

test('a memoized card repaints its swatches when the label registry loads', () => {
  renderCard();
  const ui = () =>
    slot('pills').querySelector<HTMLElement>('[data-slot=label-pill]');
  expect(ui()?.querySelector('[data-chip-mark]')).toBeNull();
  act(() => applyLabelColors([{ name: 'UI', color: '#5e6ad2' }]));
  expect(ui()?.querySelector('[data-chip-mark]')).not.toBeNull();
});

test('a picker keeps Space and pointer presses from the card and the board', () => {
  let opened = 0;
  let boardKeys = 0;
  let boardPresses = 0;
  render(
    <div
      onKeyDown={() => (boardKeys += 1)}
      onPointerDown={() => (boardPresses += 1)}
    >
      <TaskCardTile
        doc={task()}
        ready={false}
        blocked={false}
        liveRunState={undefined}
        statuses={['ready', 'working', 'landed']}
        onStatusChange={() => {}}
        onEditTask={() => {}}
        onClick={() => (opened += 1)}
      />
    </div>
  );
  for (const name of ['Change status', 'Change priority', 'Change assignee']) {
    const trigger = screen.getByRole('button', { name });
    fireEvent.pointerDown(trigger);
    fireEvent.keyDown(trigger, { key: ' ', code: 'Space' });
  }
  expect(boardPresses).toBe(0);
  expect(boardKeys).toBe(0);
  expect(opened).toBe(0);
  // The open button's own keys still reach the board (j/k, Enter).
  fireEvent.keyDown(openButton(), { key: 'j' });
  expect(boardKeys).toBe(1);
});

test("the status menu draws the card's own status glyphs, matching the face", async () => {
  renderCard();
  const trigger = screen.getByRole('button', { name: 'Change status' });
  expect(
    trigger.querySelector('svg[data-status-shape]')?.getAttribute('data-tone')
  ).toBe('info');
  await settle(() => {
    fireEvent.click(trigger);
  });
  // Landed is the neutral done disk (no tone), never the library's green.
  const landed = screen.getByRole('option', { name: /Landed/ });
  const glyph = landed.querySelector('svg[data-status-shape]');
  expect(glyph?.getAttribute('data-status-shape')).toBe('done');
  expect(glyph?.getAttribute('data-tone')).toBeNull();
  expect(landed.querySelector('[data-kind]')).toBeNull();
  // Working is the same blue half pie as the face.
  const working = screen.getByRole('option', { name: /Working/ });
  expect(
    working.querySelector('svg[data-status-shape]')?.getAttribute('data-tone')
  ).toBe('info');
});

test('the pickers write through the card callbacks', async () => {
  const patches: unknown[] = [];
  const moves: unknown[] = [];
  renderCard({
    onEditTask: (id, patch) => patches.push([id, patch]),
    onStatusChange: (id, status) => moves.push([id, status]),
  });
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }));
  });
  await settle(() => {
    const option = screen.getByRole('option', { name: /Landed/ });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  });
  expect(moves).toEqual([['t-1', 'landed']]);
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Change priority' }));
  });
  await settle(() => {
    const option = screen.getByRole('option', { name: /Urgent/ });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  });
  expect(patches).toEqual([['t-1', { priority: 'urgent' }]]);
});
