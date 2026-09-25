import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { ChecksSection } from './ChecksSection';
import { OPERATOR_ONLY } from './fields';
import { testConfig as config } from './fixtures.test-helper';

function recorder() {
  const saved: unknown[] = [];
  return { saved, onSave: (p: unknown) => Promise.resolve(void saved.push(p)) };
}

test('an edited single check command saves on blur', () => {
  const r = recorder();
  render(<ChecksSection config={config} onSave={r.onSave} canOperate />);
  const input = screen.getByLabelText('Single check command');
  fireEvent.change(input, { target: { value: 'bun run verify' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([{ verifyCommand: 'bun run verify' }]);
});

// An empty command and a command that runs nothing are different things to the
// merge queue, so clearing must send null rather than an empty string.
test('clearing the single check command sends null', () => {
  const r = recorder();
  render(
    <ChecksSection
      config={{ ...config, verifyCommand: 'bun run verify' }}
      onSave={r.onSave}
      canOperate
    />
  );
  const input = screen.getByLabelText('Single check command');
  fireEvent.change(input, { target: { value: '  ' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([{ verifyCommand: null }]);
});

test('an unchanged field saves nothing on blur', () => {
  const r = recorder();
  render(
    <ChecksSection
      config={{ ...config, verifyCommand: 'bun run verify' }}
      onSave={r.onSave}
      canOperate
    />
  );
  fireEvent.blur(screen.getByLabelText('Single check command'));
  expect(r.saved).toEqual([]);
});

test('the time limit per check saves as a number', () => {
  const r = recorder();
  render(<ChecksSection config={config} onSave={r.onSave} canOperate />);
  const input = screen.getByLabelText('Time limit per check');
  fireEvent.change(input, { target: { value: '300' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([{ verifyTimeoutSec: 300 }]);
});

// Both commands run on the operator's machine, so below that tier they are
// disabled and marked with the lock.
test('below the operator tier the commands are locked and disabled', () => {
  render(
    <ChecksSection
      config={config}
      onSave={() => Promise.resolve()}
      canOperate={false}
    />
  );
  expect(
    screen.getByLabelText<HTMLInputElement>('Single check command').disabled
  ).toBe(true);
  expect(
    screen.getByLabelText<HTMLInputElement>('Start command').disabled
  ).toBe(true);
  expect(screen.getAllByLabelText(OPERATOR_ONLY).length).toBeGreaterThan(1);
  expect(screen.queryByText(OPERATOR_ONLY)).toBeNull();
});

// config.verify is a separate field from verifyCommand (the merge-queue gate) —
// it's the run recipe a `verify` run uses to exercise the project, so its
// command's label must never read like a duplicate of the check command.
test('the start command saves on blur, under a label distinct from the check command', () => {
  const r = recorder();
  render(<ChecksSection config={config} onSave={r.onSave} canOperate />);
  const input = screen.getByLabelText('Start command');
  expect(screen.getByLabelText('Single check command')).not.toBe(input);
  fireEvent.change(input, { target: { value: 'bun run dev' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([{ verify: { command: 'bun run dev' } }]);
});

test('the address saves on blur', () => {
  const r = recorder();
  render(<ChecksSection config={config} onSave={r.onSave} canOperate />);
  const input = screen.getByLabelText('Address');
  fireEvent.change(input, { target: { value: 'http://localhost:3000' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([{ verify: { url: 'http://localhost:3000' } }]);
});

// Notes is prose, so it's a <textarea> rather than an <input> — getByLabelText
// must resolve to the actual control, proving the label is wired to it.
test('the notes field is a textarea and saves on blur', () => {
  const r = recorder();
  render(<ChecksSection config={config} onSave={r.onSave} canOperate />);
  const field = screen.getByLabelText('Notes for the agent');
  expect(field.tagName).toBe('TEXTAREA');
  fireEvent.change(field, { target: { value: 'seed the db first' } });
  fireEvent.blur(field);
  expect(r.saved).toEqual([{ verify: { notes: 'seed the db first' } }]);
});

test('an unchanged start command saves nothing on blur', () => {
  const r = recorder();
  render(
    <ChecksSection
      config={{ ...config, verify: { command: 'bun run dev' } }}
      onSave={r.onSave}
      canOperate
    />
  );
  fireEvent.blur(screen.getByLabelText('Start command'));
  expect(r.saved).toEqual([]);
});

// Core rejects an empty string for verify.command/url/notes and offers no way to
// clear one from a patch (unlike verifyCommand's `null`), so clearing a field must
// not send anything — it must revert to what's saved instead of surfacing a 400.
test('emptying the start command reverts to the saved value instead of saving an empty string', () => {
  const r = recorder();
  render(
    <ChecksSection
      config={{ ...config, verify: { command: 'bun run dev' } }}
      onSave={r.onSave}
      canOperate
    />
  );
  const input = screen.getByLabelText('Start command');
  fireEvent.change(input, { target: { value: '  ' } });
  fireEvent.blur(input);
  expect(r.saved).toEqual([]);
  expect((input as HTMLInputElement).value).toBe('bun run dev');
});

test('verify steps: removing the last one clears the list', () => {
  const r = recorder();
  render(
    <ChecksSection
      config={{
        ...config,
        verifySteps: [{ name: 'types', command: 'pnpm typecheck' }],
      }}
      onSave={r.onSave}
      canOperate
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove types' }));
  expect(r.saved).toEqual([{ verifySteps: null }]);
});

test('the fix loop switch and round cap save', () => {
  const r = recorder();
  render(<ChecksSection config={config} onSave={r.onSave} canOperate />);
  const toggle = screen.getByRole('switch', {
    name: 'Start fixing automatically',
  });
  fireEvent.click(toggle);
  const cap = screen.getByLabelText('Rounds before asking you');
  fireEvent.change(cap, { target: { value: String(config.fixLoop.cap + 1) } });
  fireEvent.blur(cap);
  expect(r.saved).toEqual([
    { fixLoop: { auto: !config.fixLoop.auto } },
    { fixLoop: { cap: config.fixLoop.cap + 1 } },
  ]);
});

test('the groups are 13px semibold sentence-case headings', () => {
  render(
    <ChecksSection
      config={config}
      onSave={() => Promise.resolve()}
      canOperate
    />
  );
  const headings = screen.getAllByRole('heading', { level: 2 });
  expect(headings.map((h) => h.textContent)).toEqual([
    'Before merging',
    'Trying the change',
    'Fix loop',
    'Escalation',
  ]);
  for (const heading of headings) {
    expect(heading.className).toContain('text-[13px]');
  }
});
