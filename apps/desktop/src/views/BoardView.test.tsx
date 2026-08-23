import type { TaskDoc } from '@dispatch/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';

import { testConfig } from '../components/settings/fixtures.test-helper';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { BoardView } from './BoardView';
import { TooltipProvider } from '@/ui/tooltip';

function task(
  id: string,
  title: string,
  status: string,
  parent: string | null = null,
  kind = 'task'
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status,
      kind,
      priority: 2,
      parent,
      labels: [],
      assignee: null,
      blockedBy: [],
      created: '2026-08-10T00:00:00.000Z',
      updated: '2026-08-10T00:00:00.000Z',
    },
    body: '',
  } as unknown as TaskDoc;
}

const EPICS = [
  task('e-1', 'Payments epic', 'todo', null, 'epic'),
  task('e-2', 'Search epic', 'todo', null, 'epic'),
];

const TASKS = [
  ...EPICS,
  task('t-1', 'Card one', 'todo', 'e-1'),
  task('t-2', 'Card two', 'done', 'e-1'),
  task('t-3', 'Card three', 'todo', 'e-2'),
  task('t-loose', 'Unparented card', 'todo'),
];

/** A `DispatchProjectData` stub carrying only what BoardView reads. */
function boardData(): DispatchProjectData {
  return {
    config: testConfig,
    client: {},
    portLoading: false,
    portError: false,
    tasksLoading: false,
    tasks: TASKS,
    tasksIncludingArchived: TASKS,
    archivedTasks: [],
    showArchived: false,
    setShowArchived: () => {},
    epics: EPICS,
    epicProgressById: new Map(),
    readyIds: new Set<string>(),
    blockedIds: new Set<string>(),
    runs: [],
    latestRunByTaskId: new Map(),
    liveRunStateByTaskId: new Map(),
    attentionByTaskId: new Map(),
    mergeQueue: null,
    handleMergeAllReady: async () => {},
    moveTaskStatus: async () => {},
    handleUpdate: async () => {},
    handleDispatch: async () => {},
    handleWorkEpic: async () => {},
    handleStopEpic: async () => {},
  } as unknown as DispatchProjectData;
}

function mount(onSelectTask: (taskId: string) => void = () => {}) {
  return render(
    <TooltipProvider>
      <BoardView
        data={boardData()}
        mode="board"
        onSelectTask={onSelectTask}
        onNewTask={() => {}}
        onPlanWork={() => {}}
      />
    </TooltipProvider>
  );
}

/** A card's own root element — the keydown target a real keypress has, and the only one whose
 * events reach the board track (a card stops keydowns that came from its inner controls). */
function cardRoot(title: string): HTMLElement {
  const root = screen
    .getByText(title)
    .closest<HTMLElement>('[aria-roledescription="draggable"]');
  if (root === null) throw new Error(`no card rendered for ${title}`);
  return root;
}

/** j/k are handled by the board track the cards sit inside, so a keypress on a card bubbles up
 * to it — which is exactly what happens when the roving cursor has moved focus onto a card. */
function pressNav(key: 'j' | 'k' | 'Enter', on: HTMLElement) {
  fireEvent.keyDown(on, { key });
}

/** The card the roving cursor is on, by the text it renders. */
function focusedCardText(): string {
  const card = screen
    .getAllByRole('button')
    .find((el) => el.getAttribute('data-focused') === 'true');
  return (card?.textContent ?? '').replace(/\s+/g, ' ');
}

beforeEach(() => {
  // Collapse state is session-scoped, and `cleanup()` does not clear storage — without this a
  // lane collapsed by one test would start the next one folded up.
  window.sessionStorage.clear();
  window.localStorage.clear();
});

// The lane-behavior tests below exercise the opt-in grouped board — the default is the
// flat kanban, so they seed the persisted pref the Display menu would set.
function enableEpicLanes() {
  window.localStorage.setItem(
    'dispatch:board-columns-v1',
    JSON.stringify({ hideEmpty: false, hidden: [], groupByEpic: true })
  );
}

test('the mode prop selects the layout — the switcher lives in the sidebar, not the page', () => {
  const { rerender } = render(
    <TooltipProvider>
      <BoardView
        data={boardData()}
        mode="board"
        onSelectTask={() => {}}
        onNewTask={() => {}}
        onPlanWork={() => {}}
      />
    </TooltipProvider>
  );
  // No in-page view tabs any more.
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
  expect(screen.queryByText('Card one')).not.toBeNull();

  rerender(
    <TooltipProvider>
      <BoardView
        data={boardData()}
        mode="list"
        onSelectTask={() => {}}
        onNewTask={() => {}}
        onPlanWork={() => {}}
      />
    </TooltipProvider>
  );
  expect(
    screen.queryByPlaceholderText('Filter by id or title…')
  ).not.toBeNull();
});

test('the board opens on the unified kanban with every epic expanded', () => {
  mount();
  expect(screen.queryByText('Card one')).not.toBeNull();
  expect(screen.queryByText('Card three')).not.toBeNull();
  expect(screen.queryByText('Unparented card')).not.toBeNull();
});

test('j walks the cards lane by lane, and Enter opens the one it stopped on', () => {
  enableEpicLanes();
  const opened: string[] = [];
  mount((taskId) => opened.push(taskId));
  const anchor = cardRoot('Card one');

  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Card one');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Card two');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Card three');
  pressNav('k', anchor);
  expect(focusedCardText()).toContain('Card two');

  // Pressed on the card the cursor is on, as a real Enter would be — the card's own activation
  // and the track's roving-focus confirm both resolve to the same task, so this asserts which
  // task opened rather than how many times the same open fired.
  pressNav('Enter', cardRoot('Card two'));
  expect(opened.length).toBeGreaterThan(0);
  expect(new Set(opened)).toEqual(new Set(['t-2']));
});

// The regression this guards: an order built from all the project's tasks would walk the cursor
// into a folded-up lane, moving real DOM focus to a card nobody can see.
test('j/k skip the cards a collapsed epic is hiding', () => {
  enableEpicLanes();
  mount();
  fireEvent.click(screen.getByRole('button', { name: /Payments epic/ }));
  const anchor = cardRoot('Card three');

  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Card three');
  pressNav('j', anchor);
  expect(focusedCardText()).toContain('Unparented card');
});

test('a collapsed lane stays collapsed after switching to the list and back', () => {
  enableEpicLanes();
  const view = (mode: 'board' | 'list') => (
    <TooltipProvider>
      <BoardView
        data={boardData()}
        mode={mode}
        onSelectTask={() => {}}
        onNewTask={() => {}}
        onPlanWork={() => {}}
      />
    </TooltipProvider>
  );
  const { rerender } = render(view('board'));
  fireEvent.click(screen.getByRole('button', { name: /Payments epic/ }));
  expect(screen.queryByText('Card one')).toBeNull();

  rerender(view('list'));
  rerender(view('board'));
  expect(screen.queryByText('Card one')).toBeNull();
  expect(screen.queryByText('Card three')).not.toBeNull();
});
