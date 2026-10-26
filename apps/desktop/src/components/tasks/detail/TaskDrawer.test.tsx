import type { TaskComment } from '@dispatch-foo/core/browser';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  fakeHost,
  type HostLog,
  newLog,
  PageProviders,
  task,
} from '../page/pageHost.test-helper';
import type { TaskPageHost } from '../page/TaskPageHost';
import { TaskDrawer } from './TaskDrawer';

// The quick-look drawer over a fake host (pageHost.test-helper): the slide-over
// draws a task from the cached list at once, its body and comments as they
// land, and every control writes through the host, which the log records.

afterEach(cleanup);

const BODY = `## Description

Apply the **Burgess** rule everywhere.

## Acceptance Criteria

- tests pass
- docs updated

## Activity

- 2026-09-13T10:00:00.000Z dispatched (claude, branch dispatch/t-1)
`;

function comment(
  id: string,
  author: string,
  body: string,
  parentId: string | null = null
): TaskComment {
  return {
    id,
    taskId: 't-1',
    author,
    body,
    created: '2026-09-23T10:00:00.000Z',
    updated: '2026-09-23T10:00:00.000Z',
    parentId,
    external: null,
  };
}

// t-1 waits on t-2; t-3 waits on t-1 (so t-1 blocks it); t-4 waits on t-3.
const TASKS = [
  task('t-1', { blockedBy: ['t-2'], dueDate: '2026-10-30' }),
  task('t-2', { title: 'The blocker' }),
  task('t-3', { title: 'The blocked', blockedBy: ['t-1'] }),
  task('t-4', { title: 'The far blocked', blockedBy: ['t-3'] }),
];

function hostWith(
  log: HostLog,
  overrides: Partial<Parameters<typeof fakeHost>[1]> = {}
): TaskPageHost {
  return fakeHost(log, {
    tasks: TASKS,
    body: BODY,
    comments: [
      comment('c-1', 'human:wyat', 'Looks **good**.'),
      comment('c-2', 'human:maya', 'Agreed.', 'c-1'),
    ],
    ...overrides,
  });
}

function mount(host: TaskPageHost | null, onClose: () => void = () => {}) {
  return render(
    <PageProviders host={host}>
      <TaskDrawer taskId="t-1" onClose={onClose} />
    </PageProviders>
  );
}

function drawer(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Title of t-1' });
}

function optionNamed(name: string): HTMLElement {
  const option = screen
    .getAllByRole('option')
    .find((o) => o.querySelector('[dir="auto"]')?.textContent === name);
  if (option === undefined) {
    throw new Error(
      `no option ${name} among ${screen
        .getAllByRole('option')
        .map((o) => o.textContent)
        .join(', ')}`
    );
  }
  return option;
}

// A popover positions itself a frame after it mounts; opening or driving one
// runs inside an async act that lets that settle.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

describe('TaskDrawer', () => {
  test('draws the listed task at once: title, key, status, properties, relations', () => {
    const log = newLog();
    mount(hostWith(log));
    const dialog = drawer();
    // The title is the editor, in the drawer's heading; the key stands in the status line.
    expect(
      within(dialog).getByRole('button', { name: 'Title of t-1' })
    ).toBeTruthy();
    // The key: in the status line and as the last crumb.
    expect(within(dialog).getAllByText('t-1').length).toBeGreaterThan(0);
    expect(
      within(dialog).getByRole('button', { name: 'Status: Ready' })
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: /^Assignee: / })
    ).toBeTruthy();
    expect(within(dialog).getByLabelText('Due date')).toHaveProperty(
      'value',
      '2026-10-30'
    );
    const blockedBy = within(dialog).getByRole('list', { name: 'Blocked by' });
    expect(within(blockedBy).getByText('The blocker')).toBeTruthy();
    const blocks = within(dialog).getByRole('list', { name: 'Blocks' });
    expect(within(blocks).getByText('The blocked')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Open' })).toBeTruthy();
    // The Work block sits with the properties, above the description.
    expect(
      within(dialog).getByRole('heading', { level: 3, name: 'Work' })
    ).toBeTruthy();
  });

  test('the body, the comments and the activity land behind the metadata', async () => {
    const log = newLog();
    mount(hostWith(log));
    const dialog = drawer();
    await waitFor(() => {
      expect(within(dialog).getByText('Burgess')).toBeTruthy();
    });
    expect(
      within(dialog).getByRole('region', { name: /^Acceptance criteria/ })
    ).toBeTruthy();
    const comments = within(dialog).getByRole('list', { name: 'Comments' });
    expect(within(comments).getAllByRole('listitem')).toHaveLength(2);
    expect(within(comments).getByText('good')).toBeTruthy();
    // The reply is drawn as one; only my own comment gets a menu.
    expect(comments.querySelectorAll('li[data-reply="true"]')).toHaveLength(1);
    expect(
      within(comments).getAllByRole('button', { name: 'Comment actions' })
    ).toHaveLength(1);
    const activity = within(dialog).getByRole('list', { name: 'Activity' });
    expect(within(activity).getByText(/^Dispatched/)).toBeTruthy();
  });

  test('saving the title patches it through the host', async () => {
    const log = newLog();
    mount(hostWith(log));
    fireEvent.click(screen.getByRole('button', { name: 'Title of t-1' }));
    const field = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(field, { target: { value: 'Renamed' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(log.updates).toEqual([{ id: 't-1', patch: { title: 'Renamed' } }]);
    });
  });

  test('the status picker moves the task; a property picker patches it', async () => {
    const log = newLog();
    mount(hostWith(log));
    await settle(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Status: Ready' }));
    });
    await settle(() => {
      fireEvent.click(optionNamed('Dropped'));
    });
    expect(log.moves).toEqual([{ id: 't-1', status: 'dropped' }]);

    await settle(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Assignee: / }));
    });
    await settle(() => {
      fireEvent.click(optionNamed('Any agent'));
    });
    expect(log.updates).toEqual([{ id: 't-1', patch: { assignee: 'agent' } }]);
  });

  test('a refused save prints the reason beside the control and keeps the old value', async () => {
    const log = newLog();
    mount(
      hostWith(log, {
        project: {
          handleUpdate: () =>
            Promise.reject(new Error('invalid priority: refused')),
        },
      })
    );
    await settle(() => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Priority: No priority' })
      );
    });
    await settle(() => {
      fireEvent.click(optionNamed('Urgent'));
    });
    await waitFor(() => {
      expect(screen.getByText('invalid priority: refused')).toBeTruthy();
    });
    expect(
      screen.getByRole('button', { name: 'Priority: No priority' })
    ).toBeTruthy();
    expect(log.updates).toEqual([]);
  });

  test('a due date change patches dueDate', async () => {
    const log = newLog();
    mount(hostWith(log));
    const field = screen.getByLabelText('Due date');
    fireEvent.change(field, { target: { value: '2026-11-02' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => {
      expect(log.updates).toEqual([
        { id: 't-1', patch: { dueDate: '2026-11-02' } },
      ]);
    });
  });

  test('a blocker that would close a cycle is refused with the reason, and nothing is written', async () => {
    const log = newLog();
    mount(hostWith(log));
    await settle(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add blocker' }));
    });
    // t-4 waits on t-3, which waits on t-1: making t-4 a blocker of t-1 closes
    // a cycle. (t-3 itself is already linked, so the picker never offers it.)
    const option = await screen.findByRole('option', {
      name: /The far blocked/,
    });
    await settle(() => {
      fireEvent.click(option);
    });
    await waitFor(() => {
      expect(
        screen.getByText('That would make a dependency cycle.')
      ).toBeTruthy();
    });
    expect(log.updates).toEqual([]);
  });

  test('removing a blocker rewrites blockedBy', async () => {
    const log = newLog();
    mount(hostWith(log));
    fireEvent.click(screen.getByRole('button', { name: 'Remove t-2' }));
    await waitFor(() => {
      expect(log.updates).toEqual([{ id: 't-1', patch: { blockedBy: [] } }]);
    });
  });

  test('the composer adds a comment through the comments api', async () => {
    const log = newLog();
    mount(hostWith(log));
    const box = await screen.findByRole('textbox', { name: 'New comment' });
    fireEvent.change(box, { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => {
      expect(log.comments).toEqual(['Hello there']);
    });
  });

  test('Esc closes; Open and ⌘⏎ go to the full page', () => {
    const log = newLog();
    const opened: string[] = [];
    const host = {
      ...hostWith(log),
      openTaskPage: (id: string) => opened.push(id),
    };
    let closed = 0;
    mount(host, () => {
      closed += 1;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(opened).toEqual(['t-1']);
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    expect(opened).toEqual(['t-1', 't-1']);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(1);
  });

  test('a request-tier window reads only: no editors, no menu writes', async () => {
    const log = newLog();
    mount(hostWith(log, { project: { myTier: 'request' } }));
    const dialog = drawer();
    expect(
      within(dialog).queryByRole('button', { name: 'Title of t-1' })
    ).toBeNull();
    expect(
      within(dialog).queryByRole('button', { name: /^Status: / })
    ).toBeNull();
    expect(
      within(dialog).queryByRole('button', { name: /^Assignee: / })
    ).toBeNull();
    expect(within(dialog).queryByLabelText('Due date')).toBeNull();
    expect(
      within(dialog).queryByRole('button', { name: 'Add blocker' })
    ).toBeNull();
    expect(
      within(dialog).queryByRole('button', { name: /^Remove / })
    ).toBeNull();
    await waitFor(() => {
      expect(within(dialog).getByText('Burgess')).toBeTruthy();
    });
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    // The menu still copies, and nothing more.
    await settle(() => {
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'More actions' })
      );
    });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Copy id',
    ]);
  });

  test('a task that left the list reads as gone; without a host nothing is drawn', () => {
    const log = newLog();
    mount(fakeHost(log, { tasks: [] }));
    expect(screen.getByText(/no longer available/)).toBeTruthy();
    cleanup();
    const { container } = mount(null);
    expect(container.textContent).toBe('');
  });
});
