import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { AgentsSection } from './AgentsSection';
import { testConfig as config } from './fixtures.test-helper';

type Props = Parameters<typeof AgentsSection>[0];

function renderAgents(overrides: Partial<Props> = {}) {
  return render(
    <AgentsSection
      config={config}
      executors={null}
      onSave={async () => {}}
      canOperate
      {...overrides}
    />
  );
}

function recorder() {
  const saved: unknown[] = [];
  return {
    saved,
    onSave: (p: unknown) => Promise.resolve(void saved.push(p)),
  };
}

// Base UI commits a select item on a click that began on it (a bare click is
// treated as one that opened the list under the pointer), so press first.
function chooseOption(name: string) {
  const option = screen.getByRole('option', { name });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

// The default config says 'auto'; before this was offered, a stock project
// showed no radio selected and blamed the yml for a value nobody set.
test('the default permission mode has a selected radio', () => {
  renderAgents();
  const radio: HTMLInputElement = screen.getByLabelText(
    "Let Dispatch's safety check decide (recommended)"
  );
  expect(radio.checked).toBe(true);
  expect(screen.queryByText(/set by hand in/)).toBeNull();
});

// getByLabelText resolves straight to the <input>, so clicking that result
// never exercises the browser's label-to-control forwarding. These click the
// visible label TEXT instead, which only works if it's still inside a
// wrapping <label> — the exact thing the previous task's port lost.
test('clicking the "never ask" label text selects that radio', () => {
  const r = recorder();
  renderAgents({ onSave: r.onSave });
  fireEvent.click(screen.getByText('Never ask'));
  expect(r.saved).toEqual([{ permissionMode: 'dontAsk' }]);
});

test('clicking the "ask every time" label text selects that radio', () => {
  const r = recorder();
  renderAgents({ onSave: r.onSave });
  fireEvent.click(screen.getByText('Ask me every time'));
  expect(r.saved).toEqual([{ permissionMode: 'default' }]);
});

// A config naming one of the two modes with no radio (plan, bypassPermissions)
// must still say so, rather than silently showing nothing selected.
test('an unoffered permission mode shows the escape hatch', () => {
  renderAgents({
    config: {
      ...config,
      orchestrator: { ...config.orchestrator, permissionMode: 'plan' },
    },
  });
  expect(screen.getByText(/set by hand in/)).toBeTruthy();
});

test('an edited concurrency value saves on blur', () => {
  const r = recorder();
  renderAgents({ onSave: r.onSave });
  const input = screen.getByLabelText('Runs at once per epic');
  fireEvent.change(input, { target: { value: '5' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([{ epicConcurrency: 5 }]);
});

test('the run limits save as the numbers they are', () => {
  const r = recorder();
  renderAgents({ onSave: r.onSave });
  const type = (label: string, value: string) => {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  };
  type('Runs at once', '6');
  type('Expected cost per run', '0.75');
  type('Runs at once', 'lots');
  expect(r.saved).toEqual([
    { maxConcurrency: 6 },
    { runCostEstimateUsd: 0.75 },
  ]);
});

test('an emptied turn cap clears it rather than sending zero', () => {
  const r = recorder();
  renderAgents({
    config: {
      ...config,
      orchestrator: { ...config.orchestrator, maxTurns: 40 },
    },
    onSave: r.onSave,
  });
  const input = screen.getByLabelText('Turns per run');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([{ maxTurns: null }]);
});

test('a budget cap keeps its fractional part', () => {
  const r = recorder();
  renderAgents({ onSave: r.onSave });
  const input = screen.getByLabelText('Spend per run');
  fireEvent.change(input, { target: { value: '2.50' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([{ maxBudgetUsd: 2.5 }]);
});

// Snapping back is what tells the user the value was refused; leaving the bad
// text in the box reads as saved.
test('a negative budget cap snaps back and saves nothing', () => {
  const r = recorder();
  renderAgents({ onSave: r.onSave });
  const input: HTMLInputElement = screen.getByLabelText('Spend per run');
  fireEvent.change(input, { target: { value: '-5' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([]);
  expect(input.value).toBe('');
});

test('clearing an already-absent budget cap saves nothing', () => {
  const r = recorder();
  renderAgents({ onSave: r.onSave });
  const input = screen.getByLabelText('Spend per run');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([]);
});

test('a model role select carries its accessible name', () => {
  renderAgents();
  expect(screen.getByLabelText('Coding runs model')).toBeTruthy();
  expect(screen.getByLabelText('Coding runs effort')).toBeTruthy();
});

test('choosing an effort level saves it for that role', () => {
  const r = recorder();
  renderAgents({ onSave: r.onSave });
  fireEvent.click(screen.getByRole('combobox', { name: 'Coding runs effort' }));
  chooseOption('Max');
  expect(r.saved).toEqual([{ effort: { execute: 'max' } }]);
});

// Default is not an effort level: choosing it clears the key so the model
// decides, rather than saving the word "default".
test('choosing Default effort clears the role', () => {
  const r = recorder();
  renderAgents({
    config: { ...config, effort: { execute: 'high' } },
    onSave: r.onSave,
  });
  fireEvent.click(screen.getByRole('combobox', { name: 'Coding runs effort' }));
  chooseOption('Default');
  expect(r.saved).toEqual([{ effort: { execute: null } }]);
});

// Models first, then the limits runs work under, then what they may do, then
// which agent a dispatch uses.
test('the page is sentence-case groups in order', () => {
  renderAgents();
  expect(
    screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
  ).toEqual([
    'Models',
    'Limits',
    'Permissions',
    'Defaults',
    'Command-line agents',
  ]);
});

// Numeric inputs are sans with tabular digits — no code face on a number.
test('numeric inputs are not monospaced', () => {
  renderAgents();
  const input = screen.getByLabelText('Turns per run');
  expect(input.className).not.toContain('font-mono');
  expect(input.className).toContain('tabular-nums');
});

// The permission radios paint on Linear's indigo (`--color-primary` → `--accent`), not the
// `accent-accent` alias that resolves to the near-transparent hover wash.
test('the permission radios paint with the primary accent', () => {
  renderAgents();
  const radios = screen.getAllByRole('radio');
  expect(radios.length).toBeGreaterThan(0);
  for (const radio of radios) {
    expect(radio.className).toContain('accent-primary');
    expect(radio.className).not.toContain('accent-accent');
  }
});
