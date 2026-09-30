import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { PickerPopover } from './PickerPopover';

const ITEMS = Array.from({ length: 50 }, (_, i) => ({
  value: `t-${i}`,
  label: `Task number ${i}`,
  hint: `t-${i}`,
}));

async function settle(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

test('lazy items are built only once the picker opens, and capped by limit', async () => {
  let built = 0;
  const items = () => {
    built += 1;
    return ITEMS;
  };
  const { rerender } = render(
    <PickerPopover
      triggerLabel="Add blocker"
      placeholder="Task…"
      items={items}
      limit={5}
      onSelect={() => {}}
    >
      Add
    </PickerPopover>
  );
  expect(built).toBe(0);
  await settle(() => {
    rerender(
      <PickerPopover
        triggerLabel="Add blocker"
        placeholder="Task…"
        items={items}
        limit={5}
        onSelect={() => {}}
        open
      >
        Add
      </PickerPopover>
    );
  });
  expect(built).toBeGreaterThan(0);
  expect(screen.getAllByRole('option')).toHaveLength(5);
  // Typing narrows past the cap: every word must match.
  await settle(() =>
    fireEvent.change(screen.getByPlaceholderText('Task…'), {
      target: { value: 'number 42' },
    })
  );
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
    'Task number 42t-42',
  ]);
});
