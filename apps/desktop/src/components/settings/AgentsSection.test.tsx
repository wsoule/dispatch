import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { AgentsSection } from './AgentsSection';
import { testConfig as config } from './fixtures.test-helper';

// The default config says 'auto'; before this was offered, a stock project
// showed no radio selected and blamed the yml for a value nobody set.
test('the default permission mode has a selected radio', () => {
  render(<AgentsSection config={config} onSave={async () => {}} />);
  const radio: HTMLInputElement = screen.getByLabelText(
    'Let the classifier decide (default)'
  );
  expect(radio.checked).toBe(true);
  expect(screen.queryByText(/set in/)).toBeNull();
});

// getByLabelText resolves straight to the <input>, so clicking that result
// never exercises the browser's label-to-control forwarding. These click the
// visible label TEXT instead, which only works if it's still inside a
// wrapping <label> — the exact thing the previous task's port lost.
test('clicking the "never ask" label text selects that radio', () => {
  const saved: unknown[] = [];
  render(
    <AgentsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  fireEvent.click(screen.getByText('Never ask, let it run'));
  expect(saved).toEqual([{ permissionMode: 'dontAsk' }]);
});

test('clicking the "always ask" label text selects that radio', () => {
  const saved: unknown[] = [];
  render(
    <AgentsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  fireEvent.click(screen.getByText('Always ask me first'));
  expect(saved).toEqual([{ permissionMode: 'default' }]);
});

// A config naming one of the two modes with no radio (plan, bypassPermissions)
// must still say so, rather than silently showing nothing selected.
test('an unoffered permission mode shows the escape hatch', () => {
  render(
    <AgentsSection
      config={{
        ...config,
        orchestrator: { ...config.orchestrator, permissionMode: 'plan' },
      }}
      onSave={async () => {}}
    />
  );
  expect(screen.getByText(/set in/)).toBeTruthy();
});

test('an edited concurrency value saves on blur', () => {
  const saved: unknown[] = [];
  render(
    <AgentsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  const input = screen.getByLabelText(
    'How many run at once when you dispatch an epic'
  );
  fireEvent.change(input, { target: { value: '5' } });
  fireEvent.blur(input);
  expect(saved).toEqual([{ epicConcurrency: 5 }]);
});

test('an emptied turn cap clears it rather than sending zero', () => {
  const saved: unknown[] = [];
  render(
    <AgentsSection
      config={{
        ...config,
        orchestrator: { ...config.orchestrator, maxTurns: 40 },
      }}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  const input = screen.getByLabelText('Turn cap');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  expect(saved).toEqual([{ maxTurns: null }]);
});

test('a budget cap keeps its fractional part', () => {
  const saved: unknown[] = [];
  render(
    <AgentsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  const input = screen.getByLabelText('Budget cap per run');
  fireEvent.change(input, { target: { value: '2.50' } });
  fireEvent.blur(input);
  expect(saved).toEqual([{ maxBudgetUsd: 2.5 }]);
});

// Snapping back is what tells the user the value was refused; leaving the bad
// text in the box reads as saved.
test('a negative budget cap snaps back and saves nothing', () => {
  const saved: unknown[] = [];
  render(
    <AgentsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  const input: HTMLInputElement = screen.getByLabelText('Budget cap per run');
  fireEvent.change(input, { target: { value: '-5' } });
  fireEvent.blur(input);
  expect(saved).toEqual([]);
  expect(input.value).toBe('');
});

test('clearing an already-absent budget cap saves nothing', () => {
  const saved: unknown[] = [];
  render(
    <AgentsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  const input = screen.getByLabelText('Budget cap per run');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  expect(saved).toEqual([]);
});

test('a model role select carries its accessible name', () => {
  render(<AgentsSection config={config} onSave={async () => {}} />);
  expect(screen.getByLabelText('Coding runs model')).toBeTruthy();
});
