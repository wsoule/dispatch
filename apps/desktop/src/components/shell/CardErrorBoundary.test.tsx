import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import { CardErrorBoundary } from './CardErrorBoundary';

interface Item {
  id: string;
  text: string;
  bad?: boolean;
}

function Row({ item }: { item: Item }): ReactNode {
  if (item.bad === true) throw new Error(`bad payload in ${item.id}`);
  return <p data-testid="row">{item.text}</p>;
}

function List({ items }: { items: Item[] }) {
  return (
    <div>
      {items.map((item) => (
        <CardErrorBoundary key={item.id} raw={JSON.stringify(item)}>
          <Row item={item} />
        </CardErrorBoundary>
      ))}
    </div>
  );
}

// React logs a caught render error; keep the test output to the assertions.
const errorLog = console.error;
beforeEach(() => {
  console.error = () => {};
});
afterEach(() => {
  console.error = errorLog;
});

test('one item that throws shows its raw content; the others still render', () => {
  render(
    <List
      items={[
        { id: 'a', text: 'first' },
        { id: 'b', text: 'broken', bad: true },
        { id: 'c', text: 'third' },
      ]}
    />
  );
  expect(screen.getAllByTestId('row').map((el) => el.textContent)).toEqual([
    'first',
    'third',
  ]);
  expect(screen.getByText("Couldn't display this step")).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Show raw' }));
  expect(screen.getByText(/"id":"b"/).textContent).toContain('broken');
});

test('a later update to the item draws it again', () => {
  const { rerender } = render(
    <List items={[{ id: 'b', text: 'partial', bad: true }]} />
  );
  expect(screen.queryAllByTestId('row')).toHaveLength(0);
  rerender(<List items={[{ id: 'b', text: 'complete' }]} />);
  expect(screen.getByTestId('row').textContent).toBe('complete');
  expect(screen.queryByText("Couldn't display this step")).toBeNull();
});
