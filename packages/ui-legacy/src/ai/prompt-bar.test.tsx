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

  test('a caller-owned completion list is tied to the text box, with its active option', () => {
    const { rerender } = render(
      <PromptBar value="@t" onChange={() => {}} onSubmit={() => {}} />
    );
    const textarea = screen.getByRole('textbox');
    expect(textarea.getAttribute('aria-controls')).toBeNull();
    expect(textarea.getAttribute('aria-autocomplete')).toBeNull();
    rerender(
      <PromptBar
        value="@t"
        onChange={() => {}}
        onSubmit={() => {}}
        completion={{ listId: 'recipients', activeOptionId: 'recipients-1' }}
      />
    );
    expect(textarea.getAttribute('aria-controls')).toBe('recipients');
    expect(textarea.getAttribute('aria-autocomplete')).toBe('list');
    expect(textarea.getAttribute('aria-activedescendant')).toBe('recipients-1');
  });

  test('focusOnMount puts the caret in the text box when it mounts', () => {
    render(
      <PromptBar
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        focusOnMount
      />
    );
    expect(document.activeElement === screen.getByRole('textbox')).toBe(true);
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

  test('a locked reference chip offers no remove button', () => {
    render(
      <PromptBar
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        references={[
          { id: 'task', label: 'Checkout', locked: true },
          { id: 'ref-1', label: 'boot.rs' },
        ]}
        onRemoveReference={() => {}}
      />
    );

    expect(screen.getByText('Checkout')).toBeDefined();
    expect(
      screen.queryByRole('button', { name: 'Remove Checkout' })
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Remove boot.rs' })
    ).toBeDefined();
  });

  // The frame is the comment composer (quaternary card, half-pixel border), the
  // reference chips are `Pill`s, and send is an icon button that goes indigo only
  // once there is something to send.
  test('the composer, chips and send button carry the Linear treatment', () => {
    const { container, rerender } = render(
      <PromptBar
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        references={[{ id: 'ref-1', label: 'boot.rs' }]}
      />
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className).toContain('bg-surface-quaternary');
    expect(frame.className).toContain('border-[0.5px]');
    expect(
      container.querySelector('[data-slot="pill"]')?.textContent
    ).toContain('boot.rs');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.getAttribute('data-slot')).toBe('icon-button');
    expect(send.className).not.toContain('bg-primary');

    rerender(
      <PromptBar value="ship it" onChange={() => {}} onSubmit={() => {}} />
    );
    expect(screen.getByRole('button', { name: 'Send' }).className).toContain(
      'bg-primary'
    );
  });
});

describe('PromptBar dictation', () => {
  test('no mic without a handler, so there is no button that does nothing', () => {
    render(<PromptBar value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(
      screen.queryByRole('button', { name: 'Start dictation' })
    ).toBeNull();
  });

  test('the mic shows and calls its handler when one is passed', () => {
    let clicks = 0;
    render(
      <PromptBar
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onMicClick={() => clicks++}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }));
    expect(clicks).toBe(1);
  });
});

describe('PromptBar attachments', () => {
  // happy-dom's ClipboardEvent carries no DataTransfer, so the paste is built
  // from a plain event with the one field the handler reads.
  function pasteFiles(target: HTMLElement, files: File[]): void {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
        files,
      },
    });
    fireEvent(target, event);
  }

  test('a pasted image goes to onAttachFiles, not into the text', () => {
    const attached: File[][] = [];
    render(
      <PromptBar
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onAttachFiles={(files) => attached.push(files)}
      />
    );
    const shot = new File(['png'], 'image.png', { type: 'image/png' });
    pasteFiles(screen.getByLabelText('Prompt'), [shot]);
    expect(attached).toEqual([[shot]]);
  });

  test('without onAttachFiles there is no paperclip and a paste is left alone', () => {
    render(<PromptBar value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
  });

  test('an attachment alone can be sent, but not while an upload runs', () => {
    let sent = 0;
    const props = {
      value: '',
      onChange: () => {},
      onSubmit: () => {
        sent += 1;
      },
      onAttachFiles: () => {},
      attachments: [{ id: 'a', name: 'image.png', previewUrl: 'blob:x' }],
    };
    const { rerender } = render(<PromptBar {...props} attaching />);
    expect(
      screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')
    ).toBe(true);
    rerender(<PromptBar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toBe(1);
    expect(screen.getByRole('img', { name: 'image.png' })).not.toBeNull();
  });

  test('a pending attachment can be removed', () => {
    const removed: string[] = [];
    render(
      <PromptBar
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onAttachFiles={() => {}}
        attachments={[{ id: 'log', name: 'build.log' }]}
        onRemoveAttachment={(id) => removed.push(id)}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove build.log' }));
    expect(removed).toEqual(['log']);
  });
});
