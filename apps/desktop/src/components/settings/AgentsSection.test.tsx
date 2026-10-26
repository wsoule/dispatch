import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { accessFor, SettingsAccessProvider } from './access';
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

// Models first, then how their chats stream, the limits runs work under,
// what they may do, then which agent a dispatch uses.
test('the page is sentence-case groups in order', () => {
  renderAgents();
  expect(
    screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
  ).toEqual([
    'Models',
    'Judgments',
    'Streaming',
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

// The two streaming switches: every mode in view, the chosen one pressed,
// and the line under each saying what the chosen mode does.
function streamMode(row: string, mode: string): HTMLElement {
  return within(screen.getByRole('group', { name: row })).getByRole('button', {
    name: mode,
  });
}

test('both chats stream live when config.yml says nothing', () => {
  renderAgents();
  expect(streamMode('Assistant', 'Live').getAttribute('aria-pressed')).toBe(
    'true'
  );
  expect(streamMode('Runs', 'Live').getAttribute('aria-pressed')).toBe('true');
  expect(
    screen.getByText(
      'Its reply appears as it writes, and what it says between steps stays in the chat.'
    )
  ).toBeTruthy();
  // Narration is the Assistant's alone.
  expect(
    within(screen.getByRole('group', { name: 'Runs' }))
      .getAllByRole('button')
      .map((b) => b.textContent)
  ).toEqual(['Live', 'Off']);
});

test('pressing a mode saves it under its own block', () => {
  const r = recorder();
  renderAgents({ onSave: r.onSave });
  fireEvent.click(streamMode('Assistant', 'Narration'));
  fireEvent.click(streamMode('Runs', 'Off'));
  expect(r.saved).toEqual([
    { overseer: { stream: 'narration' } },
    { runs: { stream: 'off' } },
  ]);
});

test('the configured mode is pressed and described, and pressing it again saves nothing', () => {
  const r = recorder();
  renderAgents({
    config: { ...config, overseer: { stream: 'off' }, runs: { stream: 'off' } },
    onSave: r.onSave,
  });
  expect(streamMode('Assistant', 'Off').getAttribute('aria-pressed')).toBe(
    'true'
  );
  expect(
    screen.getByText('One reply per turn, shown when the turn is done.')
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Each part of the agent's text appears once it is finished."
    )
  ).toBeTruthy();
  fireEvent.click(streamMode('Assistant', 'Off'));
  expect(r.saved).toEqual([]);
});

test('a viewer who may not save config cannot press a mode', () => {
  const r = recorder();
  render(
    <SettingsAccessProvider access={accessFor('request', false)}>
      <AgentsSection
        config={config}
        executors={null}
        onSave={r.onSave}
        canOperate={false}
      />
    </SettingsAccessProvider>
  );
  const narration = streamMode('Assistant', 'Narration');
  expect(narration.hasAttribute('disabled')).toBe(true);
  fireEvent.click(narration);
  expect(r.saved).toEqual([]);
});
