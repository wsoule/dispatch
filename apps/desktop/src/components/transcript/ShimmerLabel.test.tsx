import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { ShimmerLabel } from './ShimmerLabel';

// The words stay real text (readable, findable, copyable); the shimmer is a marked span the
// stylesheet animates under no-preference motion only.
test('the words render as text inside a marked shimmer span', () => {
  render(
    <p>
      <ShimmerLabel>working</ShimmerLabel>
    </p>
  );
  const words = screen.getByText('working');
  expect(words.tagName).toBe('SPAN');
  expect(words.hasAttribute('data-shimmer')).toBe(true);
});
