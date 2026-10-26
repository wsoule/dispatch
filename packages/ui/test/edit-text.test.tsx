import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import {
  DateField,
  InlineTextField,
  type SaveResult,
  TextAreaEditor,
} from '../src/index';

afterEach(cleanup);

// The text controls: InlineTextField (the title), TextAreaEditor (the
// description and a new comment) and DateField, all on the family's save
// contract.

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function TitleHost({ save }: { save: (next: string) => SaveResult }) {
  const [value, setValue] = useState('Search analytics events');
  return (
    <h2>
      <InlineTextField
        label="Title"
        value={value}
        maxLength={255}
        onSave={async (next) => {
          await save(next);
          setValue(next);
        }}
      />
    </h2>
  );
}

function titleButton(): HTMLElement {
  return screen.getByRole('button', { name: /Search analytics events|Typo/ });
}

function editor(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Title' });
}

describe('InlineTextField', () => {
  test('reads as the text, is a button described as editable, keeps the heading clean', () => {
    render(<TitleHost save={() => undefined} />);
    const button = titleButton();
    const hint = document.getElementById(
      button.getAttribute('aria-describedby') ?? ''
    );
    expect(hint?.textContent).toBe('Edit Title');
    expect(hint?.hidden).toBe(true);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain(
      'Search analytics events'
    );
  });

  test('click opens the editor with focus; Enter saves once and returns focus', async () => {
    const save = mock((_next: string) => undefined);
    render(<TitleHost save={save} />);
    fireEvent.click(titleButton());
    expect(document.activeElement).toBe(editor());
    fireEvent.change(editor(), { target: { value: 'Typo tolerance' } });
    await act(async () => {
      fireEvent.keyDown(editor(), { key: 'Enter' });
      await Promise.resolve();
    });
    // A blur from the editor going away must not save it again.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('Typo tolerance');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(titleButton());
    expect(titleButton().textContent).toBe('Typo tolerance');
  });

  test('Esc cancels, restores the text and does not reach the page', () => {
    const save = mock((_next: string) => undefined);
    const pageEsc = mock(() => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') pageEsc();
    };
    document.addEventListener('keydown', onKey);
    try {
      render(<TitleHost save={save} />);
      fireEvent.click(titleButton());
      fireEvent.change(editor(), { target: { value: 'Discarded' } });
      fireEvent.keyDown(editor(), { key: 'Escape' });
      expect(save).not.toHaveBeenCalled();
      expect(pageEsc).not.toHaveBeenCalled();
      expect(titleButton().textContent).toBe('Search analytics events');
      expect(document.activeElement).toBe(titleButton());
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  test('leaving the field saves a change; an unchanged one saves nothing', async () => {
    const save = mock((_next: string) => undefined);
    render(<TitleHost save={save} />);
    fireEvent.click(titleButton());
    fireEvent.blur(editor());
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(titleButton());
    fireEvent.change(editor(), { target: { value: '  Typo tolerance  ' } });
    await act(async () => {
      fireEvent.blur(editor());
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith('Typo tolerance');
  });

  test('the editor is as tall as its text plus padding and borders', () => {
    // happy-dom has no layout: give the textarea a 30px line, 2px + 2px
    // padding and 1px + 1px borders.
    const proto = HTMLTextAreaElement.prototype;
    const props = ['scrollHeight', 'offsetHeight', 'clientHeight'] as const;
    const values = { scrollHeight: 34, offsetHeight: 36, clientHeight: 34 };
    for (const name of props) {
      Object.defineProperty(proto, name, {
        configurable: true,
        get: () => values[name],
      });
    }
    try {
      render(<TitleHost save={() => undefined} />);
      fireEvent.click(titleButton());
      // border-box: 30 + 4 + 2, so the -3px margins leave the text's line.
      expect(editor().style.height).toBe('36px');
    } finally {
      for (const name of props) {
        delete (proto as unknown as Record<string, unknown>)[name];
      }
    }
  });

  test('pasted line breaks become spaces', () => {
    render(<TitleHost save={() => undefined} />);
    fireEvent.click(titleButton());
    fireEvent.change(editor(), { target: { value: 'One\nTwo\r\n three' } });
    expect(editor().value).toBe('One Two three');
  });

  test('empty is refused on Enter and put back on blur', () => {
    const save = mock((_next: string) => undefined);
    render(<TitleHost save={save} />);
    fireEvent.click(titleButton());
    fireEvent.change(editor(), { target: { value: '   ' } });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(save).not.toHaveBeenCalled();
    expect(editor().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('Cannot be empty.');
    fireEvent.blur(editor());
    expect(titleButton().textContent).toBe('Search analytics events');
  });

  test('pending shows the new text; a rejection reopens the editor with it and the error', async () => {
    const pending = deferred();
    render(<TitleHost save={() => pending.promise} />);
    fireEvent.click(titleButton());
    fireEvent.change(editor(), { target: { value: 'Typo tolerance' } });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(titleButton().textContent).toContain('Typo tolerance');
    expect(titleButton().getAttribute('data-pending')).toBe('true');
    await act(async () => {
      pending.reject(new Error('Linear refused the title.'));
      await pending.promise.catch(() => undefined);
    });
    await settle();
    expect(editor().value).toBe('Typo tolerance');
    expect(screen.getByRole('alert').textContent).toContain(
      'Linear refused the title.'
    );
    expect(document.activeElement).toBe(editor());
    // Esc now shows the saved (old) title: the rollback.
    fireEvent.keyDown(editor(), { key: 'Escape' });
    expect(titleButton().textContent).toBe('Search analytics events');
  });
});

describe('TextAreaEditor: edit mode', () => {
  function DescriptionHost({
    save,
    maxLength,
  }: {
    save: (next: string) => SaveResult;
    maxLength?: number;
  }) {
    const [value, setValue] = useState('First line\nSecond line <b>x</b>');
    return (
      <TextAreaEditor
        label="Description"
        value={value}
        maxLength={maxLength}
        emptyLabel="No description"
        onSave={async (next) => {
          await save(next);
          setValue(next);
        }}
      />
    );
  }

  function area(): HTMLTextAreaElement {
    return screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Description',
    });
  }

  test('the text as typed, never parsed, with an Edit button', () => {
    render(<DescriptionHost save={() => undefined} />);
    expect(document.body.innerHTML).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(document.querySelector('b')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Edit Description' })
    ).toBeTruthy();
  });

  test('Edit opens the editor; Ctrl+Enter saves and focus returns to Edit', async () => {
    const save = mock((_next: string) => undefined);
    render(<DescriptionHost save={save} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    expect(document.activeElement).toBe(area());
    expect(area().value).toBe('First line\nSecond line <b>x</b>');
    fireEvent.change(area(), { target: { value: 'New text' } });
    await act(async () => {
      fireEvent.keyDown(area(), { key: 'Enter', ctrlKey: true });
      await Promise.resolve();
    });
    await settle();
    expect(save).toHaveBeenCalledWith('New text');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('New text')).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Edit Description' })
    );
  });

  test('⌘+Enter saves too, and Save with nothing changed just closes', async () => {
    const save = mock((_next: string) => undefined);
    render(<DescriptionHost save={save} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.change(area(), { target: { value: 'Mac' } });
    await act(async () => {
      fireEvent.keyDown(area(), { key: 'Enter', metaKey: true });
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith('Mac');
  });

  test('Esc on an unchanged edit closes it; on a changed one it warns, then discards', () => {
    const save = mock((_next: string) => undefined);
    const pageEsc = mock(() => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) pageEsc();
    };
    document.addEventListener('keydown', onKey);
    try {
      render(<DescriptionHost save={save} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
      fireEvent.keyDown(area(), { key: 'Escape' });
      expect(screen.queryByRole('textbox')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
      fireEvent.change(area(), { target: { value: 'Draft' } });
      fireEvent.keyDown(area(), { key: 'Escape' });
      expect(area().value).toBe('Draft');
      expect(screen.getByText(/Esc again discards/)).toBeTruthy();
      fireEvent.keyDown(area(), { key: 'Escape' });
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(save).not.toHaveBeenCalled();
      expect(pageEsc).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  test('a rejection keeps the draft in the editor with the error', async () => {
    const pending = deferred();
    render(<DescriptionHost save={() => pending.promise} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.change(area(), { target: { value: 'Will fail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(area().readOnly).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled
    ).toBe(true);
    await act(async () => {
      pending.reject(new Error('Too long for Linear.'));
      await pending.promise.catch(() => undefined);
    });
    await settle();
    expect(area().value).toBe('Will fail');
    expect(area().readOnly).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain(
      'Too long for Linear.'
    );
    expect(area().getAttribute('aria-describedby')).toContain(
      screen.getByRole('alert').id
    );
  });

  test('the count appears near the limit and goes red past it', () => {
    render(<DescriptionHost save={() => undefined} maxLength={40} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.change(area(), { target: { value: 'short' } });
    expect(screen.queryByText(/\/ 40/)).toBeNull();
    fireEvent.change(area(), { target: { value: 'x'.repeat(33) } });
    expect(screen.getByText('33 / 40')).toBeTruthy();
    fireEvent.change(area(), { target: { value: 'x'.repeat(41) } });
    const count = screen.getByText('41 / 40');
    expect(count.getAttribute('data-over')).toBe('true');
    expect(area().getAttribute('aria-invalid')).toBe('true');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled
    ).toBe(true);
  });

  test('a function view renders the just-saved text', async () => {
    function Host() {
      return (
        <TextAreaEditor
          label="Description"
          value="old"
          view={(text) => <em data-testid="rendered">{text.toUpperCase()}</em>}
          onSave={() => Promise.resolve()}
        />
      );
    }
    render(<Host />);
    expect(screen.getByTestId('rendered').textContent).toBe('OLD');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByTestId('rendered').textContent).toBe('NEW');
  });
});

describe('TextAreaEditor: compose mode', () => {
  test('always open; Comment is off while empty; a save clears it', async () => {
    const onSave = mock((_text: string) => undefined);
    render(
      <TextAreaEditor
        mode="compose"
        label="Comment"
        placeholder="Leave a comment…"
        onSave={onSave}
      />
    );
    const area = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Comment',
    });
    const submit = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Comment',
    });
    expect(submit.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.change(area, { target: { value: 'Looks good to me.' } });
    expect(submit.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
      await Promise.resolve();
    });
    await settle();
    expect(onSave).toHaveBeenCalledWith('Looks good to me.');
    expect(area.value).toBe('');
    expect(document.activeElement).toBe(area);
  });

  test('Esc in an empty box reaches the page (it closes a drawer)', () => {
    const pageEsc = mock(() => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) pageEsc();
    };
    document.addEventListener('keydown', onKey);
    try {
      render(
        <TextAreaEditor
          mode="compose"
          label="Comment"
          onSave={() => undefined}
        />
      );
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
      expect(pageEsc).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  test('a failed comment keeps its text', async () => {
    render(
      <TextAreaEditor
        mode="compose"
        label="Comment"
        onSave={() => Promise.reject(new Error('Offline.'))}
      />
    );
    const area = screen.getByRole<HTMLTextAreaElement>('textbox');
    fireEvent.change(area, { target: { value: 'Keep me' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
      await Promise.resolve();
    });
    await settle();
    expect(area.value).toBe('Keep me');
    expect(screen.getByRole('alert').textContent).toContain('Offline.');
  });
});

describe('DateField', () => {
  function DueHost({ save }: { save: (next: string | null) => SaveResult }) {
    const [value, setValue] = useState<string | null>('2026-10-23');
    return (
      <DateField
        label="Due date"
        value={value}
        commitDelay={10}
        onChange={async (next) => {
          await save(next);
          setValue(next);
        }}
      />
    );
  }

  function input(): HTMLInputElement {
    return screen.getByLabelText<HTMLInputElement>('Due date');
  }

  test('a complete date saves after the pause; a partial year never does', async () => {
    const save = mock((_next: string | null) => undefined);
    render(<DueHost save={save} />);
    expect(input().type).toBe('date');
    expect(input().value).toBe('2026-10-23');
    fireEvent.change(input(), { target: { value: '0002-10-30' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: '2026-10-30' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('2026-10-30');
  });

  test('Enter and blur save at once; an incomplete date is put back on blur', async () => {
    const save = mock((_next: string | null) => undefined);
    render(<DueHost save={save} />);
    fireEvent.change(input(), { target: { value: '2026-11-02' } });
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith('2026-11-02');
    fireEvent.change(input(), { target: { value: '0020-11-02' } });
    fireEvent.blur(input());
    expect(input().value).toBe('2026-11-02');
    expect(save).toHaveBeenCalledTimes(1);
  });

  test('Clear saves null and hides itself', async () => {
    const save = mock((_next: string | null) => undefined);
    render(<DueHost save={save} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear Due date' }));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith(null);
    expect(input().value).toBe('');
    expect(screen.queryByRole('button', { name: 'Clear Due date' })).toBeNull();
  });

  test('a rejection puts the old date back with the error', async () => {
    render(
      <DateField
        label="Due date"
        value="2026-10-23"
        onChange={() => Promise.reject(new Error('Locked by Linear.'))}
      />
    );
    fireEvent.change(input(), { target: { value: '2026-12-01' } });
    await act(async () => {
      fireEvent.blur(input());
      await Promise.resolve();
    });
    await settle();
    expect(input().value).toBe('2026-10-23');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain(
      'Locked by Linear.'
    );
  });

  test('out of range is never saved', () => {
    const onChange = mock((_next: string | null) => undefined);
    render(
      <DateField
        label="Due date"
        value={null}
        min="2026-10-01"
        max="2026-12-31"
        onChange={onChange}
      />
    );
    fireEvent.change(input(), { target: { value: '2027-01-05' } });
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe('');
  });
});
