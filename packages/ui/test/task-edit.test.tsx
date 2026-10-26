import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import {
  InlineTextField,
  type TaskComment,
  TaskCommentList,
  TaskDetail,
  type TaskDetailProps,
  type TaskRelation,
  TaskRelationList,
  TextAreaEditor,
} from '../src/index';

afterEach(cleanup);

// What the edit stage added to the task view: comments with a composer,
// controls in the built-in sections' headings, and async relation removal.

function relation(
  key: string,
  extra: Partial<TaskRelation> = {}
): TaskRelation {
  return {
    id: key,
    taskKey: key,
    title: `Task ${key}`,
    state: { kind: 'started', label: 'In Progress' },
    ...extra,
  };
}

const COMMENTS: TaskComment[] = [
  {
    id: 'c1',
    author: 'Ana Moreno',
    at: 'Oct 19',
    dateTime: '2026-10-19T10:00:00Z',
    body: 'First pass done.\n<img src=x onerror=alert(1)>',
    href: 'https://linear.app/northwind/issue/ENG-24#comment-c1',
  },
  {
    id: 'c2',
    author: 'GitHub',
    at: 'Oct 20',
    body: 'PR #88 merged.',
    tone: 'muted',
  },
];

function props(extra: Partial<TaskDetailProps> = {}): TaskDetailProps {
  return {
    taskKey: 'ENG-24',
    title: 'Search analytics events',
    status: { kind: 'unstarted', label: 'Todo' },
    properties: [{ label: 'Assignee', value: 'Ana Moreno' }],
    ...extra,
  };
}

describe('TaskDetail: comments', () => {
  test('a Comments section with its count, the list and the composer under it', () => {
    render(
      <TaskDetail
        {...props({
          relations: { blockedBy: [], blocks: [] },
          activity: [{ id: 'a', at: 'Oct 21', label: 'Flagged as stalled' }],
          comments: {
            items: COMMENTS,
            composer: (
              <TextAreaEditor
                mode="compose"
                label="New comment"
                onSave={() => undefined}
              />
            ),
          },
        })}
      />
    );
    const section = screen.getByRole('region', { name: /^Comments\W+2$/ });
    const list = within(section).getByRole('list', { name: 'Comments' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(section).getByRole('textbox', { name: 'New comment' })
    ).toBeTruthy();
    // Order: after Blocks, before Activity.
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      'Properties',
      'Blocked by, 0',
      'Blocks, 0',
      'Comments, 2',
      'Activity',
    ]);
  });

  test('no count while loading or failed', () => {
    const { rerender } = render(
      <TaskDetail {...props({ comments: { items: [], loading: true } })} />
    );
    expect(screen.getByRole('region', { name: 'Comments' })).toBeTruthy();
    rerender(
      <TaskDetail
        {...props({ comments: { items: [], error: 'Linear is down.' } })}
      />
    );
    expect(screen.getByRole('region', { name: 'Comments' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Linear is down.');
  });
});

describe('TaskCommentList', () => {
  test('bodies are text, never markup; links open the tracker in a new tab', () => {
    render(<TaskCommentList items={COMMENTS} />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.innerHTML).toContain('&lt;img src=x');
    const link = screen.getByRole('link', {
      name: 'Open comment (opens in a new tab)',
    });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    const [first, second] = screen.getAllByRole('listitem');
    expect(first.querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-10-19T10:00:00Z'
    );
    // A round avatar with the author's initials, hidden from assistive tech
    // (the author's name is printed beside it).
    const avatar = first.querySelector('[data-mark="avatar"]');
    expect(avatar?.textContent).toBe('AM');
    expect(avatar?.getAttribute('aria-hidden')).toBe('true');
    expect(avatar?.getAttribute('data-size')).toBe('md');
    expect(second.getAttribute('data-tone')).toBe('muted');
  });

  test('empty, loading and error states', () => {
    const onRetry = mock(() => undefined);
    const { rerender } = render(<TaskCommentList items={[]} />);
    expect(screen.getByText('No comments yet.')).toBeTruthy();
    rerender(<TaskCommentList items={[]} loading />);
    expect(screen.getByRole('status').textContent).toBe('Loading comments');
    rerender(
      <TaskCommentList items={[]} error="Timed out." onRetry={onRetry} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('a host-rendered body replaces the text', () => {
    render(
      <TaskCommentList
        items={[
          {
            ...COMMENTS[0],
            content: <strong data-testid="md">rendered</strong>,
          },
        ]}
      />
    );
    expect(screen.getByTestId('md').textContent).toBe('rendered');
    expect(document.body.textContent).not.toContain('First pass done.');
  });
});

describe('TaskDetail: section meta', () => {
  test('controls land in the headings of their sections', () => {
    render(
      <TaskDetail
        {...props({
          description: { text: 'Plain.' },
          relations: { blockedBy: [], blocks: [] },
          comments: { items: [] },
          activity: [],
          sectionMeta: {
            description: <span>From Linear</span>,
            blockedBy: <button type="button">Add blocked by</button>,
            blocks: <button type="button">Add blocks</button>,
            comments: <span>Latest 50</span>,
            activity: <span>Planner only</span>,
          },
        })}
      />
    );
    const region = (name: RegExp) =>
      within(screen.getByRole('region', { name }));
    expect(region(/^Description$/).getByText('From Linear')).toBeTruthy();
    expect(
      region(/^Blocked by\W+0$/).getByRole('button', {
        name: 'Add blocked by',
      })
    ).toBeTruthy();
    expect(
      region(/^Blocks\W+0$/).getByRole('button', { name: 'Add blocks' })
    ).toBeTruthy();
    expect(region(/^Comments\W+0$/).getByText('Latest 50')).toBeTruthy();
    expect(region(/^Activity$/).getByText('Planner only')).toBeTruthy();
  });

  test('an InlineTextField title sits in the heading and keeps its name', () => {
    render(
      <TaskDetail
        {...props({
          titleControl: (
            <InlineTextField
              label="Title"
              value="Search analytics events"
              onSave={() => undefined}
            />
          ),
        })}
      />
    );
    const heading = screen.getByRole('heading', { level: 2 });
    expect(
      within(heading).getByRole('button', { name: 'Search analytics events' })
    ).toBeTruthy();
    expect(
      screen.getByRole('article', { name: 'Search analytics events' })
    ).toBeTruthy();
  });
});

describe('TaskRelationList: async removal', () => {
  test('busy while the promise runs, then the row goes and focus moves to its neighbour', async () => {
    let finish = (): void => undefined;
    function Host() {
      const [items, setItems] = useState(['ENG-12', 'ENG-23', 'ENG-31']);
      return (
        <TaskRelationList
          label="Blocked by"
          items={items.map((key) =>
            relation(key, {
              onRemove: () =>
                new Promise<void>((resolve) => {
                  finish = () => {
                    setItems((list) => list.filter((k) => k !== key));
                    resolve();
                  };
                }),
            })
          )}
        />
      );
    }
    render(<Host />);
    const remove = screen.getByRole('button', { name: 'Remove ENG-23' });
    remove.focus();
    fireEvent.click(remove);
    expect(remove.getAttribute('aria-busy')).toBe('true');
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    // A second click while busy does nothing.
    fireEvent.click(remove);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Remove ENG-23' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Remove ENG-31' })
    );
  });

  test('removing the last row moves focus to the section heading’s Add control', async () => {
    let finish = (): void => undefined;
    function Host() {
      const [items, setItems] = useState(['ENG-12']);
      return (
        <TaskDetail
          {...props({
            relations: {
              blockedBy: items.map((key) =>
                relation(key, {
                  onRemove: () =>
                    new Promise<void>((resolve) => {
                      finish = () => {
                        setItems([]);
                        resolve();
                      };
                    }),
                })
              ),
              blocks: [],
            },
            sectionMeta: {
              blockedBy: <button type="button">Add blocked by</button>,
              blocks: <button type="button">Add blocks</button>,
            },
          })}
        />
      );
    }
    render(<Host />);
    const remove = screen.getByRole('button', { name: 'Remove ENG-12' });
    remove.focus();
    fireEvent.click(remove);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Remove ENG-12' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Add blocked by' })
    );
  });

  test('without a control in the section, the last row hands focus to the heading', async () => {
    let finish = (): void => undefined;
    function Host() {
      const [items, setItems] = useState(['ENG-12']);
      return (
        <TaskDetail
          {...props({
            relations: {
              blockedBy: items.map((key) =>
                relation(key, {
                  onRemove: () =>
                    new Promise<void>((resolve) => {
                      finish = () => {
                        setItems([]);
                        resolve();
                      };
                    }),
                })
              ),
              blocks: [],
            },
          })}
        />
      );
    }
    render(<Host />);
    const remove = screen.getByRole('button', { name: 'Remove ENG-12' });
    remove.focus();
    fireEvent.click(remove);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    const heading = screen.getByRole('heading', { name: /^Blocked by\W+0$/ });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  test('a rejection prints under the row and the row stays', async () => {
    render(
      <TaskRelationList
        label="Blocked by"
        items={[
          relation('ENG-12', {
            onRemove: () =>
              Promise.reject(new Error('You cannot edit this issue.')),
          }),
        ]}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove ENG-12' }));
      await Promise.resolve();
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Not saved');
    expect(alert.textContent).toContain('You cannot edit this issue.');
    expect(alert.closest('li')).not.toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Remove ENG-12' })
        .getAttribute('aria-busy')
    ).toBeNull();
  });

  test('a plain callback still just runs', () => {
    const onRemove = mock(() => undefined);
    render(
      <TaskRelationList
        label="Blocked by"
        items={[relation('ENG-12', { onRemove })]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove ENG-12' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole('button', { name: 'Remove ENG-12' })
        .getAttribute('aria-busy')
    ).toBeNull();
  });
});
