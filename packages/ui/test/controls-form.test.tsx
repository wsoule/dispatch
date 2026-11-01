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

import {
  Disclosure,
  Field,
  RadioGroup,
  Select,
  Spinner,
  TextArea,
  TextField,
} from '../src/index';

afterEach(cleanup);

// The form controls, the Field wiring, Disclosure and Spinner, plus the
// family's sheets: tokens only, and motion that respects reduced motion.

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
});

describe('Disclosure', () => {
  test('a button controls a region that mounts its content when open', () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    render(
      <Disclosure summary="Details" onOpenChange={onOpenChange}>
        <p>Raw error</p>
      </Disclosure>
    );
    const button = screen.getByRole('button', { name: 'Details' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const region = document.getElementById(
      button.getAttribute('aria-controls') ?? ''
    );
    expect(region?.hidden).toBe(true);
    expect(screen.queryByText('Raw error')).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(region?.hidden).toBe(false);
    expect(screen.getByText('Raw error')).toBeTruthy();
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  test('controlled, it follows the host', () => {
    const { rerender } = render(
      <Disclosure summary="Work" open>
        <p>Steps</p>
      </Disclosure>
    );
    const button = screen.getByRole('button', { name: 'Work' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    rerender(
      <Disclosure summary="Work" open={false}>
        <p>Steps</p>
      </Disclosure>
    );
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Spinner', () => {
  test('is a status named by its label, or decoration with label null', () => {
    render(
      <>
        <Spinner />
        <Spinner label="Starting the agent" size="lg" />
        <Spinner label={null} />
      </>
    );
    const statuses = screen.getAllByRole('status');
    expect(statuses.map((status) => status.textContent)).toEqual([
      'Loading',
      'Starting the agent',
    ]);
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
