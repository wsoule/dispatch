import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import { Disclosure } from '../src/index';
import { contrast, hex, readCss, THEMES, tokensCss } from './contrast-helpers';

afterEach(cleanup);

// Disclosure: the aria wiring between its trigger and panel, the hidden
// panel (content unmounted, or kept with keepMounted), toggling, the
// render-prop trigger, controlled and uncontrolled use, the host's data
// hooks, and its stylesheet (tokens only, motion only when welcome, the
// focus ring, forced colours, contrast).

function panelOf(button: HTMLElement): HTMLElement {
  const id = button.getAttribute('aria-controls');
  const panel = id === null ? null : document.getElementById(id);
  if (panel === null) throw new Error('aria-controls names no element');
  return panel;
}

describe('Disclosure', () => {
  test('the trigger is a button wired to a hidden panel; the content is not mounted', () => {
    render(
      <Disclosure summary="Details">
        <pre>exit code 1</pre>
      </Disclosure>
    );
    const button = screen.getByRole('button', { name: 'Details' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const panel = panelOf(button);
    expect(panel.hidden).toBe(true);
    expect(panel.textContent).toBe('');
    expect(screen.queryByText('exit code 1')).toBeNull();
    // The chevron is decoration.
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true'
    );
    const root = button.parentElement;
    expect(root?.getAttribute('data-open')).toBeNull();
    expect(root?.getAttribute('data-variant')).toBe('inline');
  });

  test('a click opens and closes it, mounting and unmounting the content', () => {
    render(
      <Disclosure summary="Details">
        <pre>exit code 1</pre>
      </Disclosure>
    );
    const button = screen.getByRole('button', { name: 'Details' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panelOf(button).hidden).toBe(false);
    expect(screen.getByText('exit code 1')).toBeTruthy();
    expect(button.parentElement?.getAttribute('data-open')).toBe('true');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panelOf(button).hidden).toBe(true);
    expect(screen.queryByText('exit code 1')).toBeNull();
  });

  test('the keyboard reaches it: a native button, so Enter and Space press it', () => {
    render(<Disclosure summary="Details">Log</Disclosure>);
    const button = screen.getByRole('button', { name: 'Details' });
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect(button.tagName).toBe('BUTTON');
    // What Enter or Space on a focused button dispatches in a browser.
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(button);
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('summary may be a function of the state; id names the panel', () => {
    render(
      <Disclosure
        id="run-log"
        summary={({ open }) => (open ? 'Hide log' : 'Show log')}
      >
        Log
      </Disclosure>
    );
    const button = screen.getByRole('button', { name: 'Show log' });
    expect(button.getAttribute('aria-controls')).toBe('run-log');
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Hide log' })).toBe(button);
  });

  test('a render-prop trigger replaces the face and gets the wiring', () => {
    const seen: boolean[] = [];
    render(
      <Disclosure
        trigger={({ open, props }) => {
          seen.push(open);
          return (
            <button {...props} className="chip">
              {open ? 'Fewer' : '+3 more'}
            </button>
          );
        }}
      >
        <ul>
          <li>Three more</li>
        </ul>
      </Disclosure>
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    const chip = screen.getByRole('button', { name: '+3 more' });
    expect(chip.getAttribute('type')).toBe('button');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(chip.querySelector('svg')).toBeNull();
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.textContent).toBe('Fewer');
    expect(panelOf(chip).textContent).toBe('Three more');
    expect(seen).toEqual([false, true]);
  });

  test('controlled: the host decides, onOpenChange asks', () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Expand all
          </button>
          <Disclosure
            open={open}
            onOpenChange={(next) => {
              onOpenChange(next);
            }}
            summary="Tool call"
          >
            Arguments
          </Disclosure>
        </>
      );
    }
    render(<Host />);
    const button = screen.getByRole('button', { name: 'Tool call' });
    fireEvent.click(button);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    // The host kept it closed.
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Arguments')).toBeTruthy();
    fireEvent.click(button);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  test('uncontrolled: defaultOpen, and onOpenChange reports each press', () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    render(
      <Disclosure defaultOpen onOpenChange={onOpenChange} summary="Thinking">
        Weighing the options
      </Disclosure>
    );
    const button = screen.getByRole('button', { name: 'Thinking' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Weighing the options')).toBeTruthy();
    // Open from the first render: no motion until a press.
    expect(panelOf(button).getAttribute('data-motion')).toBeNull();
    fireEvent.click(button);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panelOf(button).getAttribute('data-motion')).toBe('true');
  });

  test('keepMounted keeps the content (and its state) while closed, hidden', () => {
    render(
      <Disclosure keepMounted summary="Deny with a reason">
        <textarea aria-label="Reason" />
      </Disclosure>
    );
    const button = screen.getByRole('button', { name: 'Deny with a reason' });
    const panel = panelOf(button);
    expect(panel.hidden).toBe(true);
    const field = panel.querySelector('textarea');
    if (field === null) throw new Error('not mounted');
    fireEvent.click(button);
    fireEvent.change(field, { target: { value: 'Wrong branch' } });
    fireEvent.click(button);
    expect(panel.hidden).toBe(true);
    expect(panel.querySelector('textarea')).toBe(field);
    fireEvent.click(button);
    expect(panel.querySelector('textarea')?.value).toBe('Wrong branch');
  });

  test('a host’s data hooks reach the root; its own data-* stay its own', () => {
    render(
      <Disclosure
        variant="bar"
        defaultOpen
        summary="Setup"
        data-testid="setup-step"
        data-slot="collapse-bar"
        data-open="no"
      >
        Steps
      </Disclosure>
    );
    const root = screen.getByTestId('setup-step');
    expect(root.getAttribute('data-slot')).toBe('collapse-bar');
    expect(root.getAttribute('data-variant')).toBe('bar');
    expect(root.getAttribute('data-open')).toBe('true');
    expect(root.contains(screen.getByRole('button', { name: 'Setup' }))).toBe(
      true
    );
  });

  test('chevron={false} draws the face without it; plain is a variant', () => {
    render(
      <Disclosure variant="plain" chevron={false} summary="More">
        Body
      </Disclosure>
    );
    const button = screen.getByRole('button', { name: 'More' });
    expect(button.querySelector('svg')).toBeNull();
    expect(button.parentElement?.getAttribute('data-variant')).toBe('plain');
  });
});

describe('disclosure.module.css', () => {
  const css = readCss('tasks/disclosure.module.css');
  const flat = css.replace(/\s+/g, ' ');

  test('tokens only: no hex, and every var() it reads is a token', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    const declared = new Set(
      [...tokensCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
    );
    const read = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(5);
    expect(read.filter((name) => !declared.has(name))).toEqual([]);
  });

  test('motion only under no-preference, the ring on --focus-ring, forced colours keep the edge', () => {
    // Every transition and animation sits in a no-preference block.
    const outside = flat.replace(
      /@media \(prefers-reduced-motion: no-preference\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g,
      ''
    );
    expect(outside).not.toMatch(/(?:transition|animation):/);
    expect(flat).toContain(
      '.trigger:focus-visible { outline: 2px solid var(--focus-ring);'
    );
    expect(flat).not.toMatch(/outline:\s*none/);
    expect(flat).toMatch(
      /@media \(forced-colors: active\) \{ \.inline > \.trigger, \.bar > \.trigger \{ border-color: ButtonText; \}/
    );
    // The chevron turns for its own fold only, not a nested one's.
    expect(flat).toContain(
      ".root[data-open='true'] > .trigger > .chevron { transform: rotate(90deg); }"
    );
    expect(flat).toContain('.panel[hidden] { display: none; }');
  });

  for (const [theme, tokens] of THEMES) {
    test(`${theme}: the inline face reads at 4.5:1, the bar at 4.5:1 with a 3:1 chevron`, () => {
      const failing: string[] = [];
      const check = (name: string, ratio: number, floor: number): void => {
        if (ratio < floor) failing.push(`${name}: ${ratio.toFixed(2)}`);
      };
      for (const surface of ['--surface', '--bg']) {
        check(
          `inline --text-2 on ${surface}`,
          contrast(hex(tokens, '--text-2'), hex(tokens, surface)),
          4.5
        );
      }
      check(
        'inline hover --text on --surface-2',
        contrast(hex(tokens, '--text'), hex(tokens, '--surface-2')),
        4.5
      );
      for (const fill of ['--surface-2', '--surface-3']) {
        check(
          `bar --text on ${fill}`,
          contrast(hex(tokens, '--text'), hex(tokens, fill)),
          4.5
        );
        check(
          `bar chevron --text-2 on ${fill}`,
          contrast(hex(tokens, '--text-2'), hex(tokens, fill)),
          3
        );
      }
      expect(failing).toEqual([]);
    });
  }
});
