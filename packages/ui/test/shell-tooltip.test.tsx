import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useRef } from 'react';

import { Button, Tooltip } from '../src/index';

afterEach(cleanup);

// Tooltip: no provider; a hint on hover and keyboard focus, wired through
// aria-describedby, closed by Escape as the top layer of the stack, and
// nothing in the DOM while hidden.

function wait(ms: number): Promise<void> {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

// The tip is aria-hidden (rendered in place, it must not join a heading's
// text), so the queries look past that.
function tip(): HTMLElement | null {
  return screen.queryByRole('tooltip', { hidden: true });
}

describe('Tooltip', () => {
  test('renders nothing while hidden, and no description', () => {
    render(
      <Tooltip content="Copy the link">
        <button type="button">Copy</button>
      </Tooltip>
    );
    expect(tip()).toBeNull();
    const button = screen.getByRole('button', { name: 'Copy' });
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  });

  test('keyboard focus shows it at once, wired by aria-describedby; blur hides it', () => {
    render(
      <Tooltip content="Copy the link">
        <button type="button">Copy</button>
      </Tooltip>
    );
    const button = screen.getByRole('button', { name: 'Copy' });
    act(() => button.focus());
    const shown = tip();
    expect(shown?.textContent).toBe('Copy the link');
    expect(shown?.getAttribute('popover')).toBe('manual');
    expect(button.getAttribute('aria-describedby')).toBe(shown?.id ?? 'none');
    expect(screen.getByRole('button', { description: 'Copy the link' })).toBe(
      button
    );
    act(() => button.blur());
    expect(tip()).toBeNull();
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  });

  test('Escape hides it as the top layer: the page never sees the key', () => {
    const pageEsc = mock((_event: KeyboardEvent) => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') pageEsc(event);
    };
    document.addEventListener('keydown', onKey);
    try {
      render(
        <Tooltip content="Archive">
          <button type="button">A</button>
        </Tooltip>
      );
      const button = screen.getByRole('button', { name: 'A' });
      act(() => button.focus());
      expect(tip()).not.toBeNull();
      fireEvent.keyDown(button, { key: 'Escape' });
      expect(tip()).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(pageEsc).not.toHaveBeenCalled();
      // Hidden now: the next Escape is the page's.
      fireEvent.keyDown(button, { key: 'Escape' });
      expect(pageEsc).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  test('defaultOpen shows it from the first render', () => {
    render(
      <Tooltip content="Needs you: an agent waits on an answer" defaultOpen>
        <span>Needs you</span>
      </Tooltip>
    );
    expect(tip()?.textContent).toBe('Needs you: an agent waits on an answer');
  });

  test('hover shows it after the delay, leaving hides it, touch never shows it', async () => {
    // Let any earlier tooltip's warm window run out.
    await wait(450);
    render(
      <Tooltip content="Filter" delay={40}>
        <button type="button">F</button>
      </Tooltip>
    );
    const button = screen.getByRole('button', { name: 'F' });
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    expect(tip()).toBeNull();
    await wait(70);
    expect(tip()?.textContent).toBe('Filter');
    fireEvent.pointerLeave(button, { pointerType: 'mouse' });
    // A short grace first, so the pointer can reach the tip.
    expect(tip()).not.toBeNull();
    await wait(200);
    expect(tip()).toBeNull();
    await wait(450);
    fireEvent.pointerEnter(button, { pointerType: 'touch' });
    await wait(70);
    expect(tip()).toBeNull();
  });

  test('warm: right after one closes, the next shows with no delay', async () => {
    render(
      <>
        <Tooltip content="Filter" delay={5000}>
          <button type="button">F</button>
        </Tooltip>
        <Tooltip content="Display" delay={5000}>
          <button type="button">D</button>
        </Tooltip>
      </>
    );
    const first = screen.getByRole('button', { name: 'F' });
    act(() => first.focus());
    expect(tip()?.textContent).toBe('Filter');
    act(() => first.blur());
    expect(tip()).toBeNull();
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'D' }), {
      pointerType: 'mouse',
    });
    expect(tip()?.textContent).toBe('Display');
    // Cold again later (the leave's grace, then the warm window): the
    // long delay holds.
    fireEvent.pointerLeave(screen.getByRole('button', { name: 'D' }));
    await wait(200);
    expect(tip()).toBeNull();
    await wait(450);
    fireEvent.pointerEnter(first, { pointerType: 'mouse' });
    expect(tip()).toBeNull();
  });

  test('a press on the trigger hides it; a press there never shows it', () => {
    render(
      <Tooltip content="Star">
        <button type="button">S</button>
      </Tooltip>
    );
    const button = screen.getByRole('button', { name: 'S' });
    act(() => button.focus());
    expect(tip()).not.toBeNull();
    fireEvent.pointerDown(button);
    expect(tip()).toBeNull();
  });

  test('a press elsewhere and a scroll hide it', () => {
    render(
      <>
        <Tooltip content="Star" defaultOpen>
          <button type="button">S</button>
        </Tooltip>
        <p>Elsewhere</p>
      </>
    );
    expect(tip()).not.toBeNull();
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(tip()).toBeNull();
    act(() => screen.getByRole('button', { name: 'S' }).focus());
    expect(tip()).not.toBeNull();
    fireEvent.scroll(document);
    expect(tip()).toBeNull();
  });

  test('a scroll in a pane holding the trigger hides it; one elsewhere does not', () => {
    render(
      <>
        <div data-testid="column">
          <Tooltip content="Milestones: where the plan lands" defaultOpen>
            <span>Milestones</span>
          </Tooltip>
        </div>
        <div data-testid="chat">Streaming reply</div>
      </>
    );
    // The chat beside it follows its bottom while text streams.
    fireEvent.scroll(screen.getByTestId('chat'));
    expect(tip()?.textContent).toBe('Milestones: where the plan lands');
    fireEvent.scroll(screen.getByTestId('column'));
    expect(tip()).toBeNull();
  });

  test('the pointer can move onto the tip and rest there', async () => {
    await wait(450);
    render(
      <Tooltip content="Archive" delay={0}>
        <button type="button">A</button>
      </Tooltip>
    );
    const button = screen.getByRole('button', { name: 'A' });
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    const shown = tip();
    if (shown === null) throw new Error('no tip');
    fireEvent.pointerLeave(button, { pointerType: 'mouse' });
    fireEvent.pointerEnter(shown, { pointerType: 'mouse' });
    await wait(200);
    expect(tip()).not.toBeNull();
    fireEvent.pointerLeave(shown, { pointerType: 'mouse' });
    await wait(200);
    expect(tip()).toBeNull();
  });

  test("stays out of the heading's own name, and still describes its trigger", () => {
    render(
      <h2>
        <Tooltip content="Work arriving from the inbox" defaultOpen>
          <span>Coming in</span>
        </Tooltip>
      </h2>
    );
    expect(screen.getByRole('heading', { name: 'Coming in' })).toBeTruthy();
    expect(tip()?.getAttribute('aria-hidden')).toBe('true');
    const term = screen.getByText('Coming in').parentElement;
    expect(term?.getAttribute('aria-describedby')).toBe(tip()?.id ?? 'none');
  });

  test('Escape typed in a field elsewhere hides it and still reaches the field', () => {
    const fieldEsc = mock((_event: unknown) => undefined);
    render(
      <>
        <Tooltip content="Star" defaultOpen>
          <button type="button">S</button>
        </Tooltip>
        <input
          aria-label="Composer"
          onKeyDown={(event) => {
            if (event.key === 'Escape') fieldEsc(event);
          }}
        />
      </>
    );
    const field = screen.getByRole('textbox', { name: 'Composer' });
    act(() => field.focus());
    expect(tip()).not.toBeNull();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(tip()).toBeNull();
    expect(fieldEsc).toHaveBeenCalledTimes(1);
  });

  test('a child that cannot take focus is wrapped in a focusable span', () => {
    render(
      <>
        <Tooltip content="The work the agent was asked to do">
          <span data-glossary="">Spec</span>
        </Tooltip>
        <Tooltip content="Only the owner can change this">
          <button type="button" disabled>
            Rotate key
          </button>
        </Tooltip>
      </>
    );
    const term = screen.getByText('Spec');
    const wrapper = term.parentElement;
    expect(wrapper?.tagName).toBe('SPAN');
    expect(wrapper?.getAttribute('tabindex')).toBe('0');
    if (!(wrapper instanceof HTMLElement)) throw new Error('no wrapper');
    act(() => wrapper.focus());
    expect(wrapper.getAttribute('aria-describedby')).toBe(tip()?.id ?? 'none');
    act(() => wrapper.blur());
    const locked = screen.getByRole('button', { name: 'Rotate key' });
    expect(locked.parentElement?.getAttribute('tabindex')).toBe('0');
  });

  test("keeps the child's own description, handlers and ref", () => {
    const onFocus = mock(() => undefined);
    function Host() {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <>
          <Tooltip content="Copy the link">
            <button
              type="button"
              ref={ref}
              aria-describedby="own-hint"
              onFocus={onFocus}
              onClick={() => {
                if (ref.current !== null) ref.current.dataset.clicked = 'yes';
              }}
            >
              Copy
            </button>
          </Tooltip>
          <p id="own-hint">Anyone with the link can read it.</p>
        </>
      );
    }
    render(<Host />);
    const button = screen.getByRole('button', { name: 'Copy' });
    expect(button.getAttribute('aria-describedby')).toBe('own-hint');
    act(() => button.focus());
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-describedby')).toBe(
      `own-hint ${tip()?.id ?? 'none'}`
    );
    fireEvent.click(button);
    expect(button.dataset.clicked).toBe('yes');
  });

  test('works on a Button (an icon-only one keeps its name)', () => {
    render(
      <Tooltip content="Copy link" side="bottom">
        <Button icon={<svg />} aria-label="Copy link" />
      </Tooltip>
    );
    const button = screen.getByRole('button', { name: 'Copy link' });
    act(() => button.focus());
    expect(tip()?.dataset.side).toBe('bottom');
    expect(button.getAttribute('aria-describedby')).toBe(tip()?.id ?? 'none');
  });

  test('disabled never shows', () => {
    render(
      <Tooltip content="Archive" disabled defaultOpen>
        <button type="button">A</button>
      </Tooltip>
    );
    expect(tip()).toBeNull();
    act(() => screen.getByRole('button', { name: 'A' }).focus());
    expect(tip()).toBeNull();
  });
});

describe('tooltip.module.css', () => {
  const css = readFileSync(
    path.join(import.meta.dir, '..', 'src', 'shell', 'tooltip.module.css'),
    'utf8'
  );

  test("Gr8r's inverted chip, on tokens, that the pointer can rest on", () => {
    const rule = /^\.tip \{[^}]*\}/m.exec(css)?.[0] ?? '';
    expect(rule).toContain('background: var(--text);');
    expect(rule).toContain('color: var(--text-inv);');
    expect(rule).toContain('border-radius: var(--r-chip);');
    expect(rule).toContain('box-shadow: var(--shadow-pop);');
    expect(rule).toContain('font-size: var(--fs-xs);');
    expect(rule).toContain('max-width: min(256px, calc(100vw - 16px));');
    // Hoverable (WCAG 1.4.13): the pointer may move onto it.
    expect(rule).not.toContain('pointer-events: none;');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    // Motion only when welcome; forced colours keep an edge.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) \{\s*\.tip\[data-placed='true'\] \{\s*animation/
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\.tip \{\s*border: 1px solid CanvasText;/
    );
  });
});
