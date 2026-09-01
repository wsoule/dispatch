import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

test('the test environment can render and query a React component', () => {
  render(<button type="button">Dispatch</button>);
  expect(screen.getByRole('button', { name: 'Dispatch' })).toBeDefined();
});
