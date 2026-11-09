import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';

import { matchCommands, PromptBar, type PromptBarCommand } from './PromptBar';

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
  // The list is inline above the text box (no popover): the caret stays in the
  // text box, which names the list and its active option.
  test('typing a slash opens the inline command list; the arrows move it and focus stays in the text box', () => {
    render(<ControlledPromptBar onSubmit={() => {}} />);
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');
    act(() => textarea.focus());
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(textarea.hasAttribute('aria-controls')).toBe(false);

    fireEvent.change(textarea, { target: { value: '/re' } });

    const list = screen.getByRole('listbox', { name: 'Commands' });
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'RetryRe-run the last agent turn',
      'ReviewAsk for a code review',
    ]);
    expect(screen.getByText('Retry')).toBeDefined();
    expect(screen.queryByText('Explain')).toBeNull();
    // Inside the composer, before the text box: not portaled anywhere.
    expect(
      list.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(textarea.getAttribute('aria-autocomplete')).toBe('list');
    expect(textarea.getAttribute('aria-controls')).toBe(list.id);
    expect(textarea.getAttribute('aria-activedescendant')).toBe(options[0].id);
    expect(options[0].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea.getAttribute('aria-activedescendant')).toBe(options[1].id);
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    // It wraps both ways.
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea.getAttribute('aria-activedescendant')).toBe(options[0].id);
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.getAttribute('aria-activedescendant')).toBe(options[1].id);
    expect(document.activeElement).toBe(textarea);

    // A press on an option keeps focus in the text box and picks it.
    expect(fireEvent.mouseDown(options[0])).toBe(false);
    fireEvent.click(options[0]);
    expect(textarea.value).toBe('/Retry ');
    expect(document.activeElement).toBe(textarea);
    // As the legacy popover did, the list stays up for the arguments, with
    // nothing left to match.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('No matching commands')).toBeDefined();
    expect(textarea.hasAttribute('aria-activedescendant')).toBe(false);
  });

  test('Enter or Tab picks the active command instead of submitting', () => {
    const onSubmit = mock(() => {});
    render(<ControlledPromptBar onSubmit={onSubmit} />);
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');

    fireEvent.change(textarea, { target: { value: '/re' } });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(false);
    expect(textarea.value).toBe('/Review ');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('No matching commands')).toBeDefined();

    fireEvent.change(textarea, { target: { value: '/ex' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('/Explain ');
    expect(onSubmit).not.toHaveBeenCalled();
    // With nothing left to match, Enter sends.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  // A command typed out in full has nothing to complete: Enter sends it on
  // the first press, as the legacy composer did, while Tab still picks it.
  test('Enter sends a command typed out in full; Tab still picks it', () => {
    const onSubmit = mock(() => {});
    render(<ControlledPromptBar onSubmit={onSubmit} />);
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');

    fireEvent.change(textarea, { target: { value: '/Retry' } });
    expect(screen.getByRole('listbox')).toBeDefined();
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(textarea.value).toBe('/Retry ');
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: '/Retry' } });
    expect(fireEvent.keyDown(textarea, { key: 'Enter' })).toBe(false);
    expect(textarea.value).toBe('/Retry');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('Escape closes the list alone; it opens again as the value changes', () => {
    const outer = mock(() => {});
    render(
      <div onKeyDown={outer}>
        <ControlledPromptBar onSubmit={() => {}} />
      </div>
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '/' } });
    expect(screen.getByRole('listbox')).toBeDefined();
    expect(fireEvent.keyDown(textarea, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    // Closed, Escape is left to the page (a sheet around the composer).
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
    fireEvent.change(textarea, { target: { value: '/r' } });
    expect(screen.getByRole('listbox')).toBeDefined();
  });

  test('a slash with no matching command says so, with no listbox', () => {
    render(<ControlledPromptBar onSubmit={() => {}} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '/zzz' } });
    expect(screen.getByText('No matching commands')).toBeDefined();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(textarea.hasAttribute('aria-activedescendant')).toBe(false);
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

  test('Shift+Enter on a list item starts the next item', () => {
    render(<ControlledPromptBar onSubmit={() => {}} />);
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');

    fireEvent.change(textarea, { target: { value: '- one' } });
    textarea.setSelectionRange(5, 5);
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(textarea.value).toBe('- one\n- ');
  });

  // An IME's Enter confirms the character being composed; it must neither send
  // the message nor pick a command.
  test('an IME composing Enter is left alone', () => {
    const onSubmit = mock(() => {});
    render(<ControlledPromptBar onSubmit={onSubmit} />);
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');

    fireEvent.change(textarea, { target: { value: 'にほん' } });
    expect(
      fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
    ).toBe(true);
    // Safari reports the composing key as keyCode 229 only.
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: '/re' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(textarea.value).toBe('/re');
    expect(screen.getByRole('listbox')).toBeDefined();
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

  // Native selects: role combobox with every option's text in textContent, which
  // OverseerChat.test and the e2e specs read.
  test('the model and effort pickers are native selects named for what they choose', () => {
    const models: string[] = [];
    const efforts: string[] = [];
    render(
      <PromptBar
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        models={[
          { id: 'opus', label: 'Opus 5.5' },
          { id: 'fable', label: 'Fable 5.1' },
        ]}
        modelId="opus"
        onModelChange={(id) => models.push(id)}
        efforts={[
          { id: 'default', label: 'Default' },
          { id: 'high', label: 'High' },
        ]}
        effortId="default"
        onEffortChange={(id) => efforts.push(id)}
      />
    );
    const model = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Choose model',
    });
    expect(model.tagName).toBe('SELECT');
    expect(model.textContent).toContain('Opus 5.5');
    expect(model.value).toBe('opus');
    fireEvent.change(model, { target: { value: 'fable' } });
    const effort = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Choose effort',
    });
    expect(effort.textContent).toContain('High');
    fireEvent.change(effort, { target: { value: 'high' } });
    expect(models).toEqual(['fable']);
    expect(efforts).toEqual(['high']);
  });

  // A conversation on a model or effort the lists do not know shows that id,
  // not the first option, as the legacy select showed its raw value.
  test('a model or effort missing from the lists shows as itself', () => {
    render(
      <PromptBar
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        models={[
          { id: 'opus', label: 'Opus 5.5' },
          { id: 'fable', label: 'Fable 5.1' },
        ]}
        modelId="claude-retired-4"
        efforts={[{ id: 'default', label: 'Default' }]}
        effortId="max"
      />
    );
    const model = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Choose model',
    });
    expect(model.value).toBe('claude-retired-4');
    expect(model.selectedOptions[0]?.textContent).toBe('claude-retired-4');
    const effort = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Choose effort',
    });
    expect(effort.value).toBe('max');
    expect(effort.selectedOptions[0]?.textContent).toBe('max');
  });

  test('the module is tokens only: the box, the ring and the active option', () => {
    const css = readFileSync(
      join(import.meta.dir, 'PromptBar.module.css'),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/outline:\s*none/);
    expect(css).toContain('background: var(--surface);');
    expect(css).toContain('border: 1px solid var(--border);');
    expect(css).toContain('border-radius: var(--r-lg);');
    expect(css).toContain(
      '.box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px var(--accent-soft); }'
    );
    expect(css).toContain(
      ".option[aria-selected='true'] { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent); }"
    );
    // Motion only under no-preference.
    const outside = css.replace(
      /@media \(prefers-reduced-motion: no-preference\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g,
      ''
    );
    expect(outside).not.toMatch(/(?:transition|animation):/);
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
  function pasteFiles(target: HTMLElement, files: File[]): boolean {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
        files,
      },
    });
    return fireEvent(target, event);
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
    expect(pasteFiles(screen.getByLabelText('Prompt'), [shot])).toBe(false);
    expect(attached).toEqual([[shot]]);
  });

  test('a dropped file goes to onAttachFiles', () => {
    const attached: File[][] = [];
    const { container } = render(
      <PromptBar
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onAttachFiles={(files) => attached.push(files)}
      />
    );
    const log = new File(['log'], 'build.log', { type: 'text/plain' });
    const box = container.querySelector('[data-slot="prompt-bar"]');
    if (box === null) throw new Error('no composer');
    fireEvent.drop(box, {
      dataTransfer: { items: [], files: [log], types: ['Files'] },
    });
    expect(attached).toEqual([[log]]);
  });

  test('without onAttachFiles there is no paperclip and a paste is left alone', () => {
    render(<PromptBar value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    const shot = new File(['png'], 'image.png', { type: 'image/png' });
    expect(pasteFiles(screen.getByLabelText('Prompt'), [shot])).toBe(true);
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
    // The paperclip shows the library spinner while the upload runs.
    const attach = screen.getByRole('button', { name: 'Attach files' });
    expect(attach.getAttribute('aria-busy')).toBe('true');
    expect(attach.querySelector('svg circle')).not.toBeNull();
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
