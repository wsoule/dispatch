import { act, fireEvent, render } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { createRef, Profiler, useState } from 'react';

import { VirtualRows, type VirtualRowsHandle } from './VirtualRows';

interface Row {
  id: string;
}

const ROWS: Row[] = Array.from({ length: 2000 }, (_, i) => ({ id: `t-${i}` }));
const rowKey = (row: Row) => row.id;
const size = () => 36;

function List({
  rows = ROWS,
  pinnedKeys,
  offscreen,
  handle,
}: {
  rows?: Row[];
  pinnedKeys?: string[];
  offscreen?: boolean;
  handle?: React.Ref<VirtualRowsHandle>;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScroller} data-testid="scroller" style={{ overflow: 'auto' }}>
      <VirtualRows
        rows={rows}
        rowKey={rowKey}
        estimateSize={size}
        scrollElement={scroller}
        pinnedKeys={pinnedKeys}
        offscreen={offscreen}
        handleRef={handle}
        renderRow={(row) => <div data-row-id={row.id}>{row.id}</div>}
      />
    </div>
  );
}

function mountedIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-row-id]')).map(
    (el) => el.getAttribute('data-row-id') ?? ''
  );
}

test('mounts a screenful of 2000 rows, not all of them', () => {
  const { container } = render(<List />);
  const ids = mountedIds(container);
  expect(ids[0]).toBe('t-0');
  expect(ids.length).toBeGreaterThan(10);
  expect(ids.length).toBeLessThan(60);
  // The track is as tall as every row together.
  const track = container.querySelector<HTMLElement>(
    '[data-slot="virtual-rows"]'
  );
  expect(track?.style.height).toBe(`${2000 * 36}px`);
});

test('places each row at its offset', () => {
  const { container } = render(<List />);
  const second = container.querySelector<HTMLElement>('[data-index="1"]');
  expect(second?.style.transform).toBe('translateY(36px)');
  expect(second?.style.height).toBe('36px');
});

test('gives every row its own compositing layer', () => {
  // WebKit repaints every row sharing a backing when one mounts, so each is a layer.
  const { container } = render(<List />);
  const rows = Array.from(container.querySelectorAll('[data-index]'));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.classList.contains('will-change-transform')).toBe(true);
  }
});

test('keeps a pinned row mounted however far away it is', () => {
  const { container } = render(<List pinnedKeys={['t-1500']} />);
  expect(mountedIds(container)).toContain('t-1500');
});

test('an offscreen track mounts only its pinned rows, at full height', () => {
  const { container } = render(
    <List offscreen pinnedKeys={['t-0', 't-1500']} />
  );
  expect(mountedIds(container)).toEqual(['t-0', 't-1500']);
  expect(
    container.querySelector<HTMLElement>('[data-slot="virtual-rows"]')?.style
      .height
  ).toBe(`${2000 * 36}px`);
});

test('scrollToKey scrolls the owner element to that row', () => {
  const handle = createRef<VirtualRowsHandle>();
  const { getByTestId } = render(<List handle={handle} />);
  const scroller = getByTestId('scroller');
  // happy-dom has no layout, so give the scroller the extent a browser would.
  Object.defineProperty(scroller, 'scrollHeight', { value: 2000 * 36 });
  Object.defineProperty(scroller, 'clientHeight', { value: 720 });
  const calls: unknown[] = [];
  scroller.scrollTo = ((options: ScrollToOptions) => {
    calls.push(options);
  }) as typeof scroller.scrollTo;
  act(() => handle.current?.scrollToKey('t-1000', 'start'));
  expect(calls[0]).toMatchObject({ top: 36 * 1000 });
});

test('a row set that shrinks re-windows to what is left', () => {
  const { container, rerender } = render(<List />);
  rerender(<List rows={ROWS.slice(0, 3)} />);
  expect(mountedIds(container)).toEqual(['t-0', 't-1', 't-2']);
});

// Tracks on one scroller, the way the board's columns ride it.
function SharedTracks({ tracks }: { tracks: string[] }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScroller} data-testid="scroller" style={{ overflow: 'auto' }}>
      {tracks.map((track) => (
        <VirtualRows
          key={track}
          rows={ROWS}
          rowKey={rowKey}
          estimateSize={size}
          scrollElement={scroller}
          sharedScroller
          renderRow={(row) => (
            <div data-row-id={`${track}:${row.id}`}>{row.id}</div>
          )}
        />
      ))}
    </div>
  );
}

test('tracks sharing a scroller re-render in one commit, inside the scroll event', () => {
  let commits = 0;
  const { container, getByTestId, rerender } = render(
    <Profiler id="tracks" onRender={() => (commits += 1)}>
      <SharedTracks tracks={['a', 'b']} />
    </Profiler>
  );
  const scroller = getByTestId('scroller');
  // act holds back anything not rendered synchronously until it returns.
  const scrollTo = (row: number) => {
    let atEvent = { commits: -1, ids: [] as string[] };
    act(() => {
      commits = 0;
      scroller.scrollTop = row * 36;
      fireEvent.scroll(scroller);
      atEvent = { commits, ids: mountedIds(container) };
    });
    return atEvent;
  };

  const both = scrollTo(1000);
  expect(both.commits).toBe(1);
  expect(both.ids).toContain('a:t-1000');
  expect(both.ids).toContain('b:t-1000');

  // A track leaving keeps the scroller's listener for the rest.
  rerender(
    <Profiler id="tracks" onRender={() => (commits += 1)}>
      <SharedTracks tracks={['a']} />
    </Profiler>
  );
  const one = scrollTo(1500);
  expect(one.commits).toBe(1);
  expect(one.ids).toContain('a:t-1500');
  expect(one.ids.some((id) => id.startsWith('b:'))).toBe(false);
});
