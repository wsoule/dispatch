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

// config.verify is a separate field from verifyCommand (the merge-queue gate) — it's
// the run recipe a `verify` run uses to exercise the project. These three controls
// are its whole UI, so each field's label must never read like a duplicate of
// "Verify command" above it.
test('the run command saves on blur, under a label distinct from "Verify command"', async () => {
  const saved: unknown[] = [];
  render(
    <GeneralSection config={config} onSave={async (p) => void saved.push(p)} />
  );
  const input = screen.getByLabelText('Run command');
  expect(screen.getByLabelText('Verify command')).not.toBe(input);
  fireEvent.change(input, { target: { value: 'bun run dev' } });
  fireEvent.blur(input);
  expect(saved).toEqual([{ verify: { command: 'bun run dev' } }]);
});

test('the run URL saves on blur', async () => {
  const saved: unknown[] = [];
  render(
    <GeneralSection config={config} onSave={async (p) => void saved.push(p)} />
  );
  const input = screen.getByLabelText('URL');
  fireEvent.change(input, { target: { value: 'http://localhost:3000' } });
  fireEvent.blur(input);
  expect(saved).toEqual([{ verify: { url: 'http://localhost:3000' } }]);
});

// Notes is prose, so it's a <textarea> rather than an <input> — getByLabelText
// must resolve to the actual control, proving the label is wired to it.
test('the notes field is a textarea and saves on blur', async () => {
  const saved: unknown[] = [];
  render(
    <GeneralSection config={config} onSave={async (p) => void saved.push(p)} />
  );
  const field = screen.getByLabelText('Notes');
  expect(field.tagName).toBe('TEXTAREA');
  fireEvent.change(field, { target: { value: 'seed the db first' } });
  fireEvent.blur(field);
  expect(saved).toEqual([{ verify: { notes: 'seed the db first' } }]);
});

test('an unchanged run command saves nothing on blur', async () => {
  const saved: unknown[] = [];
  render(
    <GeneralSection
      config={{ ...config, verify: { command: 'bun run dev' } }}
      onSave={async (p) => void saved.push(p)}
    />
  );
  fireEvent.blur(screen.getByLabelText('Run command'));
  expect(saved).toEqual([]);
});

// Core rejects an empty string for verify.command/url/notes and offers no way to
// clear one from a patch (unlike verifyCommand's `null`), so clearing a field must
// not send anything — it must revert to what's saved instead of surfacing a 400.
test('emptying the run command reverts to the saved value instead of saving an empty string', async () => {
  const saved: unknown[] = [];
  render(
    <GeneralSection
      config={{ ...config, verify: { command: 'bun run dev' } }}
      onSave={async (p) => void saved.push(p)}
    />
  );
  const input = screen.getByLabelText('Run command');
  fireEvent.change(input, { target: { value: '  ' } });
  fireEvent.blur(input);
  expect(saved).toEqual([]);
  expect((input as HTMLInputElement).value).toBe('bun run dev');
});
