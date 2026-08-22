import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { useState } from 'react';

import { matchCommands, PromptBar, type PromptBarCommand } from './prompt-bar';

const COMMANDS: PromptBarCommand[] = [
  { id: 'retry', label: 'Retry', hint: 'Re-run the last agent turn' },
  { id: 'review', label: 'Review', hint: 'Ask for a code review' },
  { id: 'explain', label: 'Explain', hint: 'Explain the current diff' },
];

describe('matchCommands', () => {
  test('matches label prefixes case-insensitively', () => {
    expect(matchCommands(COMMANDS, '/re')).toEqual([COMMANDS[0], COMMANDS[1]]);
    expect(matchCommands(COMMANDS, '/RE')).toEqual([COMMANDS[0], COMMANDS[1]]);
  });

  test('a bare slash matches every command', () => {
    expect(matchCommands(COMMANDS, '/')).toEqual(COMMANDS);
  });

  test('non-slash input returns no matches', () => {
    expect(matchCommands(COMMANDS, 'retry')).toEqual([]);
    expect(matchCommands(COMMANDS, '')).toEqual([]);
  });

  test('no matching prefix returns an empty list', () => {
    expect(matchCommands(COMMANDS, '/zzz')).toEqual([]);
  });
});

// PromptBar is fully controlled, so the test wrapper owns `value` the same way a
// real caller would — typing has to flow through onChange back into the textarea.
function ControlledPromptBar(props: { onSubmit: () => void }) {
  const [value, setValue] = useState('');
  return (
    <PromptBar
      value={value}
      onChange={setValue}
      onSubmit={props.onSubmit}
      commands={COMMANDS}
    />
  );
}

describe('PromptBar', () => {
  test('typing a slash opens the command popover with matching commands', async () => {
    render(<ControlledPromptBar onSubmit={() => {}} />);
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: '/re' } });

    expect(await screen.findByText('Retry')).toBeDefined();
    expect(screen.getByText('Review')).toBeDefined();
    expect(screen.queryByText('Explain')).toBeNull();
  });

  test('pressing Enter submits, Shift+Enter does not', () => {
    let submitCount = 0;
    render(<ControlledPromptBar onSubmit={() => (submitCount += 1)} />);
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: 'ship it' } });
    fireEvent.keyDown(textarea, {
      key: 'Enter',
      shiftKey: true,
      code: 'Enter',
    });
    expect(submitCount).toBe(0);

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(submitCount).toBe(1);
  });

  test('the submit button is disabled while the value is empty', () => {
    render(<ControlledPromptBar onSubmit={() => {}} />);
    const send = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Send',
    });
    expect(send.disabled).toBe(true);
  });

  test('removing a reference chip calls onRemoveReference with its id', () => {
    let removedId: string | undefined;
    render(
      <PromptBar
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        references={[{ id: 'ref-1', label: 'boot.rs' }]}
        onRemoveReference={(id) => (removedId = id)}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove boot.rs' }));
    expect(removedId).toBe('ref-1');
  });
});
