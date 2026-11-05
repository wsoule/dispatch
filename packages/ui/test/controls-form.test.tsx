import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRef, useState } from 'react';

import { Field, RadioGroup, Select, TextArea, TextField } from '../src/index';

afterEach(cleanup);

// The form controls and the Field wiring, plus the family's sheets: tokens
// only, and motion that respects reduced motion. Disclosure and Spinner are
// tested in tasks-disclosure and shell-spinner.

describe('TextField', () => {
  test('passes native attributes through and reports typing', () => {
    const onChange = mock((_value: string) => undefined);
    render(
      <TextField
        aria-label="Name"
        placeholder="Ana Moreno"
        type="email"
        onChange={(event) => onChange(event.target.value)}
      />
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.getAttribute('type')).toBe('email');
    expect(input.getAttribute('placeholder')).toBe('Ana Moreno');
    expect(input.className).toContain('input');
    fireEvent.change(input, { target: { value: 'ana@example.com' } });
    expect(onChange).toHaveBeenCalledWith('ana@example.com');
  });

  test('inline drops the field box', () => {
    render(<TextField aria-label="Title" variant="inline" />);
    const input = screen.getByRole('textbox', { name: 'Title' });
    expect(input.className.split(' ')).not.toContain('input');
  });

  test('adornments sit inside one box around a bare input', () => {
    render(
      <TextField
        aria-label="Filter"
        start={<span data-testid="icon">S</span>}
        end={<span>3</span>}
      />
    );
    const input = screen.getByRole('textbox', { name: 'Filter' });
    const box = input.parentElement;
    expect(box?.tagName).toBe('SPAN');
    expect(box?.className).toContain('input');
    expect(box?.contains(screen.getByTestId('icon'))).toBe(true);
  });

  test('a ref reaches the input', () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextField aria-label="Find" ref={ref} />);
    expect(ref.current).toBe(screen.getByRole('textbox', { name: 'Find' }));
  });
});

describe('Field', () => {
  test('labels its control and describes it by hint and error', () => {
    render(
      <Field label="Your email" hint="Used for commits" error="Not an email">
        <TextField />
      </Field>
    );
    const input = screen.getByRole('textbox', { name: 'Your email' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(['Not an email', 'Used for commits']);
  });

  test('keeps a control description of its own and a given id', () => {
    render(
      <>
        <span id="extra">Extra</span>
        <Field label="Notes" id="notes" hint="Markdown works">
          <TextArea aria-describedby="extra" />
        </Field>
      </>
    );
    const area = screen.getByRole('textbox', { name: 'Notes' });
    expect(area.id).toBe('notes');
    expect(area.getAttribute('aria-describedby')?.startsWith('extra ')).toBe(
      true
    );
    expect(area.getAttribute('aria-invalid')).toBeNull();
  });
});

describe('TextArea', () => {
  test('grows to its content on input and keeps the host handler', () => {
    const onInput = mock(() => undefined);
    render(<TextArea aria-label="Prompt" rows={3} onInput={onInput} />);
    const area = screen.getByRole('textbox', { name: 'Prompt' });
    expect(area.tagName).toBe('TEXTAREA');
    expect(area.className).toContain('textarea');
    fireEvent.input(area, { target: { value: 'a\nb\nc\nd' } });
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(area.style.height).toMatch(/px$/);
  });

  test('a ref reaches the textarea, an object or a callback', () => {
    const ref = createRef<HTMLTextAreaElement>();
    const seen: (HTMLTextAreaElement | null)[] = [];
    render(
      <>
        <TextArea aria-label="Notes" ref={ref} />
        <TextArea
          aria-label="Log"
          ref={(el) => {
            seen.push(el);
          }}
        />
      </>
    );
    expect(ref.current).toBe(screen.getByRole('textbox', { name: 'Notes' }));
    expect(seen[0]).toBe(screen.getByRole('textbox', { name: 'Log' }));
  });

  // The built CSS joins the global primitives and the TextArea module in
  // an order nobody controls; with one class on each side the later sheet
  // won, and the global `resize: vertical` gave an auto-grow box a grip.
  // Both sheets go into the page in each order (the module's class names
  // as written: hashing keeps their specificity), and the auto-grow box
  // must show no grip either way while a plain field keeps its own.
  test('an auto-grow box shows no resize grip whichever sheet comes last', () => {
    const sheets = {
      primitives: readFileSync(
        path.join(import.meta.dir, '..', 'src', 'styles', 'primitives.css'),
        'utf8'
      ),
      module: readFileSync(
        path.join(
          import.meta.dir,
          '..',
          'src',
          'controls',
          'text-area.module.css'
        ),
        'utf8'
      ),
    };
    const grow = document.createElement('textarea');
    grow.className = 'textarea grow';
    const plain = document.createElement('textarea');
    plain.className = 'textarea';
    document.body.append(grow, plain);
    const style = document.createElement('style');
    document.head.append(style);
    try {
      for (const order of [
        [sheets.module, sheets.primitives],
        [sheets.primitives, sheets.module],
      ]) {
        style.textContent = order.join('\n');
        expect({
          grow: getComputedStyle(grow).resize,
          plain: getComputedStyle(plain).resize,
        }).toEqual({ grow: 'none', plain: 'vertical' });
      }
    } finally {
      style.remove();
      grow.remove();
      plain.remove();
    }
  });

  test('autoGrow off leaves the height to CSS', () => {
    render(<TextArea aria-label="Log" autoGrow={false} />);
    const area = screen.getByRole('textbox', { name: 'Log' });
    fireEvent.input(area, { target: { value: 'x' } });
    expect(area.style.height).toBe('');
  });
});

describe('RadioGroup', () => {
  function Host({ onChange }: { onChange: (value: string) => void }) {
    const [value, setValue] = useState<string | null>('team');
    return (
      <RadioGroup
        label="Scope"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        options={[
          { value: 'team', label: 'Team', hint: 'Everyone sees it' },
          { value: 'personal', label: 'Personal' },
          { value: 'gone', label: 'Archived', disabled: true },
        ]}
      />
    );
  }

  test('is a named radiogroup of native radios with hints as descriptions', () => {
    const onChange = mock((_value: string) => undefined);
    render(<Host onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Scope' });
    expect(group).toBeTruthy();
    const team = screen.getByRole<HTMLInputElement>('radio', { name: 'Team' });
    expect(team.checked).toBe(true);
    const hintId = team.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hintId)?.textContent).toBe(
      'Everyone sees it'
    );
    // One name per group: the browser's arrow keys move within it.
    const names = screen
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('name'));
    expect(new Set(names).size).toBe(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Personal' }));
    expect(onChange).toHaveBeenCalledWith('personal');
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Personal' }).checked
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Archived' }).disabled
    ).toBe(true);
  });

  test('a host’s data-* hooks land on the radiogroup', () => {
    render(
      <RadioGroup
        label="Scope"
        value="team"
        onChange={() => undefined}
        options={[{ value: 'team', label: 'Team' }]}
        data-testid="scope"
      />
    );
    expect(screen.getByTestId('scope')).toBe(
      screen.getByRole('radiogroup', { name: 'Scope' })
    );
  });

  // The decision cards' answers: boxed rows, a badge that is part of the
  // name, an aside outside it, and what the checked one reveals.
  function Cards({
    onChange,
    onEdit = () => undefined,
    initial = null,
  }: {
    onChange: (value: string) => void;
    onEdit?: () => void;
    initial?: string | null;
  }) {
    const [value, setValue] = useState<string | null>(initial);
    return (
      <RadioGroup
        label="Answer"
        variant="cards"
        name="answer"
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        options={[
          {
            value: 'deny',
            label: 'Deny and tell it why',
            children: <textarea aria-label="Reason" />,
          },
          {
            value: 'session',
            label: 'Allow Bash for this run',
            hint: 'Ends with the run',
            aside: (
              <button type="button" onClick={onEdit}>
                Edit scope
              </button>
            ),
          },
          {
            value: 'once',
            label: 'Approve once',
            badge: <span>Recommended</span>,
          },
          { value: 'later', label: 'Later', disabled: true },
        ]}
      />
    );
  }

  test('cards box each option; a badge is in the name, an aside is not', () => {
    const onChange = mock((_value: string) => undefined);
    const onEdit = mock(() => undefined);
    render(<Cards onChange={onChange} onEdit={onEdit} />);
    const group = screen.getByRole('radiogroup', { name: 'Answer' });
    expect(group.getAttribute('data-variant')).toBe('cards');
    // The badge reads after the label, with a space between.
    const once = screen.getByRole('radio', {
      name: 'Approve once Recommended',
    });
    expect(once).toBeTruthy();
    // The aside's button is its own control, outside the radio's name.
    const session = screen.getByRole<HTMLInputElement>('radio', {
      name: 'Allow Bash for this run',
    });
    const edit = screen.getByRole('button', { name: 'Edit scope' });
    expect(edit.closest('label')).toBeNull();
    fireEvent.click(edit);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(session.checked).toBe(false);
    // The hint still describes its radio.
    expect(
      document.getElementById(session.getAttribute('aria-describedby') ?? '')
        ?.textContent
    ).toBe('Ends with the run');
    // Each option is a row of its own that says whether it is checked.
    fireEvent.click(session);
    expect(onChange).toHaveBeenCalledWith('session');
    expect(
      session.closest('[data-checked]')?.getAttribute('data-checked')
    ).toBe('true');
  });

  // The whole card row picks, hint line and padding included: the input
  // covers the head with an explicit size. A themed radio (appearance
  // auto) turns an auto width and height into its own 13px box, so the
  // size is 100% and the native look is dropped (the input is invisible).
  test('the cards input covers its whole row, at an explicit size', () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'controls',
        'radio-group.module.css'
      ),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(
      /\.cards \.input \{\s*inset: 0;\s*width: 100%;\s*height: 100%;\s*appearance: none;\s*\}/
    );
    expect(css).toMatch(/\.cards \.head \{\s*position: relative;/);
  });

  test('children render only under the checked option, outside its label', () => {
    render(<Cards onChange={() => undefined} />);
    expect(screen.queryByRole('textbox', { name: 'Reason' })).toBeNull();
    fireEvent.click(
      screen.getByRole('radio', { name: 'Deny and tell it why' })
    );
    const reason = screen.getByRole('textbox', { name: 'Reason' });
    expect(reason.closest('label')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^Approve once/ }));
    expect(screen.queryByRole('textbox', { name: 'Reason' })).toBeNull();
  });

  test('name reaches every input; aria-label names a radio', () => {
    render(
      <RadioGroup
        label="Verdict"
        name="verdict"
        value={null}
        onChange={() => undefined}
        options={[
          { value: 'ok', label: 'OK', 'aria-label': 'Approve the change' },
          { value: 'no', label: 'No' },
        ]}
      />
    );
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('name'))).toEqual([
      'verdict',
      'verdict',
    ]);
    expect(screen.getByRole('radio', { name: 'Approve the change' })).toBe(
      radios[0]
    );
  });

  test('a disabled option and a disabled group still take no pick', () => {
    const onChange = mock((_value: string) => undefined);
    const { rerender } = render(<Cards onChange={onChange} />);
    const later = screen.getByRole<HTMLInputElement>('radio', {
      name: 'Later',
    });
    expect(later.disabled).toBe(true);
    expect(later.closest('[data-disabled]')).not.toBeNull();
    rerender(
      <RadioGroup
        label="Answer"
        variant="cards"
        disabled
        value={null}
        onChange={onChange}
        options={[{ value: 'once', label: 'Approve once' }]}
      />
    );
    const once = screen.getByRole<HTMLInputElement>('radio', {
      name: 'Approve once',
    });
    expect(once.disabled).toBe(true);
    expect(
      screen
        .getByRole('radiogroup', { name: 'Answer' })
        .getAttribute('aria-disabled')
    ).toBe('true');
    fireEvent.keyDown(once, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  // The review verdict bar's one-row footer: no room for hint lines, so
  // each hint is a Tooltip on its option's label, and a hidden copy stays
  // the radio's description.
  describe('hintAs="tooltip"', () => {
    function Tips({
      onChange = () => undefined,
      activation,
    }: {
      onChange?: (value: string) => void;
      activation?: 'auto' | 'manual';
    }) {
      const [value, setValue] = useState<string | null>('comment');
      return (
        <RadioGroup
          label="Verdict"
          orientation="horizontal"
          hintAs="tooltip"
          size="sm"
          activation={activation}
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          options={[
            {
              value: 'comment',
              label: 'Comment',
              hint: 'Feedback only; the run stays open',
            },
            {
              value: 'approve',
              label: 'Approve',
              hint: 'Ready to land as it is',
            },
            { value: 'changes', label: 'Request changes' },
          ]}
        />
      );
    }

    // The tip is aria-hidden (rendered in place), so the query looks past
    // that.
    const tip = () => screen.queryByRole('tooltip', { hidden: true });

    test('draws no hint line; the hidden copy is the radio’s description', () => {
      render(<Tips />);
      const comment = screen.getByRole('radio', { name: 'Comment' });
      const hint = document.getElementById(
        comment.getAttribute('aria-describedby') ?? ''
      );
      expect(hint?.textContent).toBe('Feedback only; the run stays open');
      // Visually hidden (the global .srOnly), never a visible line.
      expect(hint?.className).toBe('srOnly');
      expect(hint?.closest('label')).toBeNull();
      expect(
        screen.getByRole('radio', {
          description: 'Feedback only; the run stays open',
        })
      ).toBe(comment);
      // Nothing shows until asked, and no option gains a tab stop of its
      // own (the radios keep the group's one).
      expect(tip()).toBeNull();
      expect(
        screen.getByRole('radiogroup').querySelectorAll('[tabindex]')
      ).toHaveLength(0);
      // An option without a hint has no description and no tooltip.
      expect(
        screen
          .getByRole('radio', { name: 'Request changes' })
          .hasAttribute('aria-describedby')
      ).toBe(false);
    });

    test('keyboard focus on a radio shows its hint; Escape hides it', () => {
      const pageEsc = mock((_event: KeyboardEvent) => undefined);
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') pageEsc(event);
      };
      document.addEventListener('keydown', onKey);
      try {
        render(<Tips />);
        const approve = screen.getByRole('radio', { name: 'Approve' });
        act(() => approve.focus());
        expect(tip()?.textContent).toBe('Ready to land as it is');
        // Still described once, by the hidden copy, while the tip shows.
        expect(approve.getAttribute('aria-describedby')).not.toContain(
          tip()?.id ?? 'none'
        );
        expect(
          screen.getByRole('radio', { description: 'Ready to land as it is' })
        ).toBe(approve);
        fireEvent.keyDown(approve, { key: 'Escape' });
        expect(tip()).toBeNull();
        expect(document.activeElement).toBe(approve);
        expect(pageEsc).not.toHaveBeenCalled();
        // Moving on hides it and shows the next radio's.
        act(() => approve.blur());
        act(() => approve.focus());
        expect(tip()?.textContent).toBe('Ready to land as it is');
        const comment = screen.getByRole('radio', { name: 'Comment' });
        act(() => comment.focus());
        expect(
          screen.getAllByRole('tooltip', { hidden: true }).map((t) => t.id)
        ).toHaveLength(1);
        expect(tip()?.textContent).toBe('Feedback only; the run stays open');
        act(() => comment.blur());
        expect(tip()).toBeNull();
      } finally {
        document.removeEventListener('keydown', onKey);
      }
    });

    test('hovering the option’s label shows its hint after the delay', async () => {
      // Let any earlier tooltip's warm window run out.
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 450)));
      render(<Tips />);
      const label = screen
        .getByRole('radio', { name: 'Approve' })
        .closest('label');
      expect(label).not.toBeNull();
      if (label === null) return;
      fireEvent.pointerEnter(label, { pointerType: 'mouse' });
      expect(tip()).toBeNull();
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 350)));
      expect(tip()?.textContent).toBe('Ready to land as it is');
      // A press hides it, and picks as before.
      fireEvent.pointerDown(label);
      expect(tip()).toBeNull();
    });

    test('picking, arrows and manual activation are unchanged', () => {
      const onChange = mock((_value: string) => undefined);
      const { unmount } = render(<Tips onChange={onChange} />);
      fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
      expect(onChange.mock.calls).toEqual([['approve']]);
      unmount();
      const manual = mock((_value: string) => undefined);
      render(<Tips onChange={manual} activation="manual" />);
      const comment = screen.getByRole<HTMLInputElement>('radio', {
        name: 'Comment',
      });
      const approve = screen.getByRole<HTMLInputElement>('radio', {
        name: 'Approve',
      });
      fireEvent.keyDown(comment, { key: 'ArrowRight' });
      // The focus shows the radio's tooltip: a state update, so in act.
      act(() => approve.focus());
      fireEvent.click(approve);
      fireEvent.keyUp(approve, { key: 'ArrowRight' });
      expect(manual).not.toHaveBeenCalled();
      expect(comment.checked).toBe(true);
      fireEvent.keyDown(approve, { key: 'Enter' });
      expect(manual.mock.calls).toEqual([['approve']]);
    });

    test('hintAs="text" (the default) keeps the visible line and no tooltip', () => {
      render(
        <RadioGroup
          label="Scope"
          value="team"
          onChange={() => undefined}
          options={[{ value: 'team', label: 'Team', hint: 'Everyone sees it' }]}
        />
      );
      const team = screen.getByRole('radio', { name: 'Team' });
      const hint = document.getElementById(
        team.getAttribute('aria-describedby') ?? ''
      );
      expect(hint?.textContent).toBe('Everyone sees it');
      expect(hint?.className).not.toContain('srOnly');
      act(() => team.focus());
      expect(tip()).toBeNull();
    });
  });

  test('size sets data-size on the radiogroup: md by default, sm when asked', () => {
    const { rerender } = render(
      <RadioGroup
        label="Verdict"
        value={null}
        onChange={() => undefined}
        options={[{ value: 'ok', label: 'OK' }]}
      />
    );
    const group = screen.getByRole('radiogroup', { name: 'Verdict' });
    expect(group.getAttribute('data-size')).toBe('md');
    rerender(
      <RadioGroup
        label="Verdict"
        size="sm"
        value={null}
        onChange={() => undefined}
        options={[{ value: 'ok', label: 'OK' }]}
      />
    );
    expect(group.getAttribute('data-size')).toBe('sm');
    // The sheet: sm keeps the 24px row with 12.5px words.
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'controls',
        'radio-group.module.css'
      ),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ');
    expect(css).toContain(
      ".group[data-size='sm'] .row { gap: 6px; font-size: var(--fs-sm); }"
    );
    expect(css).toMatch(/\.row \{[^}]*min-height: 24px;/);
  });

  describe('manual activation', () => {
    function Manual({ onChange }: { onChange: (value: string) => void }) {
      const [value, setValue] = useState<string | null>('deny');
      return (
        <RadioGroup
          label="Decision"
          activation="manual"
          variant="cards"
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          options={[
            { value: 'deny', label: 'Deny' },
            { value: 'once', label: 'Approve once' },
            { value: 'session', label: 'Allow for this run' },
          ]}
        />
      );
    }

    test('an arrow key moves without picking; the checked option stays', () => {
      const onChange = mock((_value: string) => undefined);
      render(<Manual onChange={onChange} />);
      const deny = screen.getByRole<HTMLInputElement>('radio', {
        name: 'Deny',
      });
      const once = screen.getByRole<HTMLInputElement>('radio', {
        name: 'Approve once',
      });
      // What a browser does on ArrowDown: keydown on the focused radio,
      // then focus and a click (the change) on the next one, then keyup.
      fireEvent.keyDown(deny, { key: 'ArrowDown' });
      once.focus();
      fireEvent.click(once);
      fireEvent.keyUp(once, { key: 'ArrowDown' });
      expect(onChange).not.toHaveBeenCalled();
      expect(deny.checked).toBe(true);
      expect(once.checked).toBe(false);
      expect(document.activeElement).toBe(once);
    });

    test('a click, Space or Enter picks', () => {
      const onChange = mock((_value: string) => undefined);
      render(<Manual onChange={onChange} />);
      const once = screen.getByRole<HTMLInputElement>('radio', {
        name: 'Approve once',
      });
      // A press clears an arrow that never saw its keyup.
      fireEvent.keyDown(once, { key: 'ArrowUp' });
      fireEvent.pointerDown(once);
      fireEvent.click(once);
      expect(onChange.mock.calls).toEqual([['once']]);
      // Space is a keydown of its own, then the browser's click.
      const session = screen.getByRole<HTMLInputElement>('radio', {
        name: 'Allow for this run',
      });
      fireEvent.keyDown(once, { key: 'ArrowDown' });
      fireEvent.keyDown(session, { key: ' ' });
      fireEvent.click(session);
      expect(onChange.mock.calls).toEqual([['once'], ['session']]);
      // Enter on a focused radio picks it (and submits no form).
      const deny = screen.getByRole('radio', { name: 'Deny' });
      const enter = fireEvent.keyDown(deny, { key: 'Enter' });
      expect(enter).toBe(false);
      expect(onChange.mock.calls).toEqual([['once'], ['session'], ['deny']]);
    });

    // An answer given again: a click on the checked radio fires no change,
    // yet manual activation reports it once (an unchecked radio's click is
    // reported once too, by its change).
    test('a click on the checked radio reports it again, once', () => {
      const onChange = mock((_value: string) => undefined);
      render(<Manual onChange={onChange} />);
      const deny = screen.getByRole<HTMLInputElement>('radio', {
        name: 'Deny',
      });
      fireEvent.click(deny);
      expect(onChange.mock.calls).toEqual([['deny']]);
      fireEvent.click(screen.getByRole('radio', { name: 'Approve once' }));
      expect(onChange.mock.calls).toEqual([['deny'], ['once']]);
      // An arrow landing back on the checked radio is still only a move.
      fireEvent.keyDown(deny, { key: 'ArrowUp' });
      fireEvent.click(screen.getByRole('radio', { name: 'Approve once' }));
      expect(onChange.mock.calls).toEqual([['deny'], ['once']]);
    });

    test('auto activation leaves Enter and arrows to the browser', () => {
      const onChange = mock((_value: string) => undefined);
      render(<Host onChange={onChange} />);
      const personal = screen.getByRole('radio', { name: 'Personal' });
      fireEvent.keyDown(screen.getByRole('radio', { name: 'Team' }), {
        key: 'ArrowDown',
      });
      fireEvent.click(personal);
      expect(onChange).toHaveBeenCalledWith('personal');
      expect(fireEvent.keyDown(personal, { key: 'Enter' })).toBe(true);
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Select', () => {
  test('is a field picker without a search row that saves the choice', async () => {
    const onChange = mock((_value: string) => undefined);
    render(
      <Field label="Tier">
        <Select
          label="Tier"
          value="member"
          onChange={onChange}
          options={[
            { value: 'member', label: 'Member' },
            { value: 'admin', label: 'Admin' },
          ]}
        />
      </Field>
    );
    const trigger = screen.getByRole('button', { name: 'Tier: Member' });
    expect(trigger.getAttribute('data-appearance')).toBe('field');
    // The global field rules draw it, as they draw a TextField: one box,
    // ring, disabled fill and aria-invalid edge for every form field.
    expect(trigger.classList.contains('input')).toBe(true);
    // The Field's label points at the trigger.
    const label = document.querySelector('label');
    expect(label?.getAttribute('for')).toBe(trigger.id);
    fireEvent.click(trigger);
    expect(screen.queryByRole('combobox')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Admin' }));
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith('admin');
  });

  test('a host’s data-* hooks land on the open list’s layer, not the field', () => {
    render(
      <Select
        label="Tier"
        value="member"
        onChange={() => undefined}
        options={[
          { value: 'member', label: 'Member' },
          { value: 'admin', label: 'Admin' },
        ]}
        data-testid="tier-select"
      />
    );
    const trigger = screen.getByRole('button', { name: 'Tier: Member' });
    expect(trigger.hasAttribute('data-testid')).toBe(false);
    expect(screen.queryByTestId('tier-select')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByTestId('tier-select')).toBe(
      screen.getByRole('dialog', { name: 'Tier' })
    );
  });
});

describe('the controls stylesheets', () => {
  const dir = path.join(import.meta.dir, '..', 'src', 'controls');
  const sheets = readdirSync(dir).filter((file) => file.endsWith('.css'));

  test.each(sheets)('%s uses tokens, not literal colours', (file) => {
    const css = readFileSync(path.join(dir, file), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    );
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgb|hsl)a?\(/i);
    expect(css).not.toMatch(/@apply|@tailwind/);
  });

  test.each(
    sheets.filter((file) =>
      /(animation|transition)\s*:/.test(
        readFileSync(path.join(dir, file), 'utf8')
      )
    )
  )('%s honours reduced motion', (file) => {
    expect(readFileSync(path.join(dir, file), 'utf8')).toMatch(
      /prefers-reduced-motion/
    );
  });
});
