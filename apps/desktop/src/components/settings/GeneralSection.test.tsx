import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { testConfig as config } from './fixtures.test-helper';
import { GeneralSection } from './GeneralSection';

test('an edited verify command saves on blur', async () => {
  const saved: unknown[] = [];
  render(
    <GeneralSection config={config} onSave={async (p) => void saved.push(p)} />
  );
  const input = screen.getByLabelText('Verify command');
  fireEvent.change(input, { target: { value: 'bun run verify' } });
  fireEvent.blur(input);
  expect(saved).toEqual([{ verifyCommand: 'bun run verify' }]);
});

// An empty command and a command that runs nothing are different things to the
// merge queue, so clearing must send null rather than an empty string.
test('clearing the verify command sends null', async () => {
  const saved: unknown[] = [];
  render(
    <GeneralSection
      config={{ ...config, verifyCommand: 'bun run verify' }}
      onSave={async (p) => void saved.push(p)}
    />
  );
  const input = screen.getByLabelText('Verify command');
  fireEvent.change(input, { target: { value: '  ' } });
  fireEvent.blur(input);
  expect(saved).toEqual([{ verifyCommand: null }]);
});

test('an unchanged field saves nothing on blur', async () => {
  const saved: unknown[] = [];
  render(
    <GeneralSection
      config={{ ...config, verifyCommand: 'bun run verify' }}
      onSave={async (p) => void saved.push(p)}
    />
  );
  fireEvent.blur(screen.getByLabelText('Verify command'));
  expect(saved).toEqual([]);
});

// Clicking the sentence, not just the checkbox square, is the hit target people
// actually use — that only works if the text stays wrapped in a real <label>.
test('clicking the auto-commit label text toggles and saves', async () => {
  const saved: unknown[] = [];
  render(
    <GeneralSection config={config} onSave={async (p) => void saved.push(p)} />
  );
  fireEvent.click(
    screen.getByText('Let an agent commit its own work as it goes')
  );
  expect(saved).toEqual([{ autoCommit: true }]);
});
