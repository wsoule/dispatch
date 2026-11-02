import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, mock, test } from 'bun:test';

import type { ChatTarget } from './SnippetComposer';
import { SnippetComposer } from './SnippetComposer';

const TARGETS: ChatTarget[] = [
  { id: 'run-agent', label: "This run's agent", canAct: true },
  { id: 'side', label: 'Side conversation', canAct: false },
];

const SNIPPET = {
  file: 'src/a.ts',
  startLine: 2,
  endLine: 4,
  text: 'const a = 1;',
};

describe('SnippetComposer', () => {
  it('renders a chip per attachment', () => {
    render(
      <SnippetComposer
        targets={TARGETS}
        attachments={[SNIPPET]}
        onRemoveAttachment={() => {}}
        onSend={async () => {}}
      />
    );
    expect(screen.getByText('src/a.ts (2-4)')).toBeTruthy();
  });

  it('removes the chip the reviewer dismissed, by index', () => {
    const onRemove = mock(() => {});
    render(
      <SnippetComposer
        targets={TARGETS}
        attachments={[SNIPPET, { ...SNIPPET, file: 'src/b.ts' }]}
        onRemoveAttachment={onRemove}
        onSend={async () => {}}
      />
    );
    fireEvent.click(screen.getByLabelText('Remove src/b.ts (2-4)'));
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it('sends the body, the attachments and the chosen target', () => {
    const onSend = mock(async () => {});
    render(
      <SnippetComposer
        targets={TARGETS}
        attachments={[SNIPPET]}
        onRemoveAttachment={() => {}}
        onSend={onSend}
      />
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'why?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('why?', [SNIPPET], 'run-agent');
  });

  it('withholds send on an empty body, so an accidental click cannot post nothing', () => {
    render(
      <SnippetComposer
        targets={TARGETS}
        attachments={[]}
        onRemoveAttachment={() => {}}
        onSend={async () => {}}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')
    ).toBe(true);
  });

  // The only difference that matters when choosing a target is whether it can change the branch,
  // so it is stated rather than left for the reviewer to infer.
  it('says which target can act', () => {
    render(
      <SnippetComposer
        targets={TARGETS}
        attachments={[]}
        onRemoveAttachment={() => {}}
        onSend={async () => {}}
      />
    );
    expect(screen.getByText(/can edit this branch/i)).toBeTruthy();
  });
});

// The attachments are the library's removable Chips: the label is the chip's
// words and the × is its only button, named for the snippet it takes back.
test('attachments render as removable chips', () => {
  render(
    <SnippetComposer
      targets={[{ id: 'a', label: 'Agent', canAct: true }]}
      attachments={[{ file: 'src/a.ts', startLine: 2, endLine: 4, text: 'x' }]}
      onRemoveAttachment={() => {}}
      onSend={() => Promise.resolve()}
    />
  );
  const remove = screen.getByRole('button', { name: 'Remove src/a.ts (2-4)' });
  const chip = remove.closest('[data-tone]');
  expect(chip?.textContent).toBe('src/a.ts (2-4)');
  expect(chip?.querySelectorAll('button')).toHaveLength(1);
});

// A native select, so every offered target is an option from the first
// render, without opening anything.
test('the targets are options of the "Send to" select on mount', () => {
  render(
    <SnippetComposer
      targets={TARGETS}
      attachments={[]}
      onRemoveAttachment={() => {}}
      onSend={() => Promise.resolve()}
    />
  );
  const select = screen.getByRole('combobox', { name: 'Send to' });
  expect(select.tagName).toBe('SELECT');
  expect(
    screen.getAllByRole('option').map((option) => option.textContent)
  ).toEqual(["This run's agent", 'Side conversation']);
});
