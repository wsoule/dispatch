import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { CollapseBar } from './collapse-bar';
import { PathCrumb } from './path-crumb';
import { StatPair } from './stat-pair';

test('a stat pair shows signed counts', () => {
  render(<StatPair added={591} removed={46} />);
  expect(screen.getByText('+591')).toBeDefined();
  expect(screen.getByText('−46')).toBeDefined();
});

test('a stat pair omits a zero side', () => {
  render(<StatPair added={12} removed={0} />);
  expect(screen.queryByText('−0')).toBeNull();
});

// The last segment is the file; the leading directories are context and must
// not compete with it.
test('a path crumb emphasises the last segment', () => {
  render(<PathCrumb path="apps/docs/app/AgentUi.tsx" />);
  const leaf = screen.getByText('AgentUi.tsx');
  expect(leaf.className).toContain('text-foreground');
});

test('a collapse bar toggles', () => {
  let toggled = false;
  render(
    <CollapseBar
      label="16 unmodified lines"
      collapsed
      onToggle={() => {
        toggled = true;
      }}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: /16 unmodified lines/ }));
  expect(toggled).toBe(true);
});
