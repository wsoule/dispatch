import { render } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { useOnOpening } from './useOnOpening';

function Probe({ open, onOpening }: { open: boolean; onOpening: () => void }) {
  useOnOpening(open, onOpening);
  return null;
}

test('runs once each time the flag turns true, never on close or on a first open render', () => {
  const onOpening = mock(() => {});
  const { rerender } = render(<Probe open onOpening={onOpening} />);
  expect(onOpening).not.toHaveBeenCalled();
  rerender(<Probe open={false} onOpening={onOpening} />);
  expect(onOpening).not.toHaveBeenCalled();
  rerender(<Probe open onOpening={onOpening} />);
  expect(onOpening).toHaveBeenCalledTimes(1);
  rerender(<Probe open onOpening={onOpening} />);
  expect(onOpening).toHaveBeenCalledTimes(1);
  rerender(<Probe open={false} onOpening={onOpening} />);
  rerender(<Probe open onOpening={onOpening} />);
  expect(onOpening).toHaveBeenCalledTimes(2);
});
