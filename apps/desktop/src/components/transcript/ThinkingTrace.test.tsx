import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import { ThinkingTrace } from './ThinkingTrace';

const REASONING = 'The test fails because the fixture is stale.';

// The row's trigger, through ToolChip's stable data-slot hook.
function trigger(): HTMLElement {
  const chip = document.querySelector<HTMLElement>('[data-slot="tool-chip"]');
  if (chip === null) throw new Error('no thinking row');
  return chip;
}

// A host that holds the fold state the way TranscriptRow does: collapsed first.
function Host({ live }: { live: boolean }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <ThinkingTrace
      text={REASONING}
      live={live}
      collapsed={collapsed}
      onToggle={() => setCollapsed((value) => !value)}
    />
  );
}

describe('ThinkingTrace', () => {
  test('reads Thinking while live and Thought once the thought is settled', () => {
    const { rerender } = render(<Host live />);
    expect(screen.getByText('Thinking')).toBeDefined();
    expect(screen.queryByText('Thought')).toBeNull();
    rerender(<Host live={false} />);
    expect(screen.getByText('Thought')).toBeDefined();
    expect(screen.queryByText('Thinking')).toBeNull();
  });

  test('collapsed hides the reasoning; open shows it in the well', () => {
    const { rerender } = render(
      <ThinkingTrace
        text={REASONING}
        live={false}
        collapsed
        onToggle={() => {}}
      />
    );
    expect(screen.queryByText(REASONING)).toBeNull();
    rerender(
      <ThinkingTrace
        text={REASONING}
        live={false}
        collapsed={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText(REASONING).tagName).toBe('PRE');
  });

  test('pressing the row calls onToggle', () => {
    const onToggle = mock(() => {});
    render(
      <ThinkingTrace
        text={REASONING}
        live={false}
        collapsed
        onToggle={onToggle}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Thought/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test('only a live thought shimmers its label', () => {
    const { rerender } = render(<Host live />);
    expect(trigger().querySelector('[data-shimmer]')).not.toBeNull();
    rerender(<Host live={false} />);
    expect(trigger().querySelector('[data-shimmer]')).toBeNull();
  });

  test('aria-expanded follows collapsed, and the row names the panel it opens', () => {
    render(<Host live={false} />);
    const button = screen.getByRole('button', { name: /Thought/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(
      button.getAttribute('aria-controls') ?? ''
    );
    expect(panel?.textContent).toContain(REASONING);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(REASONING)).toBeNull();
  });

  test('a thought with no text is a plain row with nothing to open', () => {
    render(
      <ThinkingTrace text="" live={false} collapsed onToggle={() => {}} />
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Thought')).toBeDefined();
  });
});
