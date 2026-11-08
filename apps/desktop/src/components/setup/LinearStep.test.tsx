import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { LinearStep } from './LinearStep';

test('offers to connect Linear when the project is not connected', () => {
  let opened = 0;
  render(<LinearStep connected={false} onConnect={() => (opened += 1)} />);
  expect(
    screen.getByRole('heading', { name: 'Linear (optional)' })
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Connect Linear' }));
  expect(opened).toBe(1);
});

test('says so when it already is, and offers nothing', () => {
  render(<LinearStep connected onConnect={() => {}} />);
  expect(screen.getByRole('img', { name: 'Done' })).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
