import type { MemoryEntryView } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';

import type { MemoryActivityItem } from '../../lib/memory';
import { entry } from '../../lib/memory.test-helper';
import { MemoryActivityList } from './MemoryActivityList';

function item(over: Partial<MemoryActivityItem> = {}): MemoryActivityItem {
  return {
    id: 'ma-1',
    memoryId: 'mem-000001',
    text: 'run:r-9f2c01 saved to your memory: pnpm builds',
    at: '2026-09-25T10:00:00.000Z',
    undoable: true,
    ...over,
  };
}

describe('MemoryActivityList', () => {
  it('undoes the entry a row names, holding the button while it runs', async () => {
    let finish: (value: MemoryEntryView) => void = () => {};
    const undoMemory = mock(
      (_ref: string) =>
        new Promise<MemoryEntryView>((resolve) => {
          finish = resolve;
        })
    );
    render(<MemoryActivityList items={[item()]} client={{ undoMemory }} />);
    expect(
      screen.getByText('run:r-9f2c01 saved to your memory: pnpm builds')
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undoMemory).toHaveBeenCalledWith('mem-000001');
    const running = screen.getByRole('button', { name: 'Undoing…' });
    expect(running.hasAttribute('disabled')).toBe(true);
    fireEvent.click(running);
    expect(undoMemory).toHaveBeenCalledTimes(1);
    finish(entry());
    const done = await screen.findByRole('button', { name: 'Undone' });
    expect(done.hasAttribute('disabled')).toBe(true);
  });

  it('says why an undo failed and lets it be tried again', async () => {
    const undoMemory = mock((_ref: string) =>
      Promise.reject(new Error('only the entry’s own human may undo'))
    );
    render(<MemoryActivityList items={[item()]} client={{ undoMemory }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(
      await screen.findByText('only the entry’s own human may undo')
    ).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Undo' });
    expect(retry.hasAttribute('disabled')).toBe(false);
  });

  it('offers no Undo on a notice', () => {
    render(
      <MemoryActivityList
        items={[
          item({
            id: 'ma-2',
            memoryId: null,
            undoable: false,
            text: 'run:r-1 hit the personal memory write limit',
          }),
        ]}
        client={{ undoMemory: () => Promise.resolve(entry()) }}
      />
    );
    expect(
      screen.getByText('run:r-1 hit the personal memory write limit')
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('runs one undo per row at a time, independently', async () => {
    const undoMemory = mock((_ref: string) => Promise.resolve(entry()));
    render(
      <MemoryActivityList
        items={[item(), item({ id: 'ma-2', memoryId: 'mem-000002' })]}
        client={{ undoMemory }}
      />
    );
    const [first] = screen.getAllByRole('button', { name: 'Undo' });
    if (first === undefined) throw new Error('no Undo button');
    fireEvent.click(first);
    await waitFor(() => expect(screen.getAllByText('Undone')).toHaveLength(1));
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    expect(undoMemory).toHaveBeenCalledWith('mem-000001');
  });
});
