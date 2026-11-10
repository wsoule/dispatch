import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { Panel, TaskListCard } from '../src/index';
import { readCss } from './contrast-helpers';

afterEach(cleanup);

describe('TaskListCard', () => {
  test('a banded head with the heading and its quiet note', () => {
    const { container, getByRole } = render(
      <TaskListCard
        heading="2 suggested tasks"
        note="1 started"
        items={[
          { id: 'a', title: 'Schema' },
          { id: 'b', title: 'UI' },
        ]}
      />
    );
    // The note sits outside the heading, so the heading's name is its words.
    expect(getByRole('heading').textContent).toBe('2 suggested tasks');
    const head = container.querySelector('[data-part="header"]');
    expect(head?.getAttribute('data-band')).toBe('true');
    expect(head?.querySelector('[data-part="note"]')?.textContent).toBe(
      '1 started'
    );
  });

  test('a row per task with its status line, live or not', () => {
    const { getAllByRole } = render(
      <TaskListCard
        heading="2 suggested tasks"
        items={[
          {
            id: 'a',
            title: 'Schema',
            status: 'Editing db.ts',
            live: true,
            'data-testid': 'row-a',
          },
          { id: 'b', title: 'UI' },
        ]}
      />
    );
    const rows = getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-live')).toBe('true');
    expect(rows[0].getAttribute('data-testid')).toBe('row-a');
    expect(
      rows[0].querySelector('[data-slot="list-item-meta"]')?.textContent
    ).toBe('Editing db.ts');
    expect(rows[1].getAttribute('data-live')).toBe('false');
    expect(rows[1].querySelector('[data-slot="list-item-meta"]')).toBeNull();
  });

  test('a row that opens is one button with a chevron; the rest are text', () => {
    const open = mock(() => {});
    const { getAllByRole, getByRole } = render(
      <TaskListCard
        heading="2 suggested tasks"
        items={[
          {
            id: 'a',
            title: 'Schema',
            onOpen: open,
            mark: <span role="img" aria-label="Working" />,
          },
          { id: 'b', title: 'UI' },
        ]}
      />
    );
    expect(getAllByRole('button')).toHaveLength(1);
    const button = getByRole('button', { name: /Schema/ });
    expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    const rows = getAllByRole('listitem');
    expect(rows[1].querySelector('svg')).toBeNull();
  });

  test('tokens only: no hex in the stylesheet', () => {
    expect(readCss('tasks/task-list-card.module.css')).not.toMatch(
      /#[0-9a-f]{3,8}\b/i
    );
  });
});

describe('Panel note and band', () => {
  test('a note alone draws the head; no band unless asked', () => {
    const { container } = render(
      <Panel note="3 started">
        <p>body</p>
      </Panel>
    );
    const head = container.querySelector('[data-part="header"]');
    expect(head?.querySelector('[data-part="note"]')?.textContent).toBe(
      '3 started'
    );
    expect(head?.hasAttribute('data-band')).toBe(false);
  });
});
