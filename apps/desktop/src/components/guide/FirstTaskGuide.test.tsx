import type { DraftRecord, RunMeta } from '@dispatch/client';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, type Mock, mock, test } from 'bun:test';

import type { GuideProvider, GuideView } from '../../lib/firstTaskGuide';
import { FirstTaskGuide, type GuideActions } from './FirstTaskGuide';

const BANNED = /dispatchd|\.dispatch\/|tracker|worktree|executor/i;
const CLAUDE: GuideProvider = {
  id: 'claude',
  name: 'Claude Code',
  blurb: 'Uses your Claude Pro or Max plan.',
  plans: true,
  usingApiKey: false,
};

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Dark mode',
    executor: 'claude',
    state: 'running',
    createdAt: '2026-10-11T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

// Every action as a bun mock, typed so tests can both call and inspect them.
type MockActions = { [K in keyof GuideActions]: Mock<GuideActions[K]> };

function actions(): MockActions {
  const ok = () => mock(() => Promise.resolve());
  return {
    showDescribe: mock(() => {}),
    openDraft: mock(() => {}),
    openTask: mock(() => {}),
    send: ok(),
    retryDraft: ok(),
    retryRun: ok(),
    askAgentToFix: ok(),
    looksGood: mock(() => {}),
    askForChanges: ok(),
    land: ok(),
    startOver: ok(),
    dismiss: mock(() => {}),
    closeCompletion: mock(() => {}),
    openBoard: mock(() => {}),
    openOverseer: mock(() => {}),
    inviteTeammate: mock(() => {}),
  } as MockActions;
}

function card(
  view: GuideView,
  over: { provider?: GuideProvider | null; collapsed?: boolean } = {}
) {
  const a = actions();
  const onCollapsedChange = mock(() => {});
  const utils = render(
    <FirstTaskGuide
      view={view}
      provider={over.provider === undefined ? CLAUDE : over.provider}
      sendOptions={{ modelChoice: false }}
      sendError={null}
      collapsed={over.collapsed ?? false}
      onCollapsedChange={onCollapsedChange}
      actions={a}
    />
  );
  return { a, onCollapsedChange, ...utils };
}

test('stage 1 asks for a sentence when the agent can draft, and offers Skip', () => {
  const { a } = card({ stage: 'describe' });
  expect(
    screen.getByText(/Describe the change you want in one sentence/)
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Skip — I know my way around' })
  );
  expect(a.dismiss).toHaveBeenCalled();
});

test('stage 1 points at the two fields when the agent cannot draft', () => {
  card(
    { stage: 'describe' },
    { provider: { ...CLAUDE, id: 'codex', plans: false } }
  );
  expect(screen.getByText(/Write what should change/)).toBeTruthy();
});

test('a failed draft explains itself and retries the same sentence', async () => {
  const draft = { id: 'd-1', prompt: 'x' } as DraftRecord;
  const { a } = card({
    stage: 'describe',
    draft,
    failure: { error: 'planner produced no task for this description' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(a.retryDraft).toHaveBeenCalledWith(draft));
});

test('stage 2 on a task is one Send to agent', async () => {
  const { a } = card({ stage: 'check', taskId: 't-1' });
  // "agent" is a glossary span, so match the sentence around it.
  expect(
    screen.getByText(/will do\. Edit anything, then send it\./)
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
  await waitFor(() =>
    expect(a.send).toHaveBeenCalledWith('t-1', { writes: [] })
  );
});

test('stage 3 reassures and says what the run draws on', () => {
  card({ stage: 'works', taskId: 't-1', run: run() });
  expect(
    screen.getByText(
      'The agent works on its own copy of your project. Nothing changes in your files until you say so.'
    )
  ).toBeTruthy();
  expect(screen.getByText('Uses your Claude Pro or Max plan.')).toBeTruthy();
});

test('stage 3 on an API key shows the running cost', () => {
  card(
    { stage: 'works', taskId: 't-1', run: run({ costUsd: 0.42 }) },
    { provider: { ...CLAUDE, usingApiKey: true } }
  );
  expect(
    screen.getByText('Billed to your API key: $0.42 so far.')
  ).toBeTruthy();
});

test('a failed run can be retried or handed back to its agent', async () => {
  const error = 'git worktree add failed: fatal: could not create directory';
  const { a } = card({
    stage: 'works',
    taskId: 't-1',
    run: run({ state: 'failed', sessionId: 's-1' }),
    failure: { error },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(a.retryRun).toHaveBeenCalledWith('t-1'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Ask the agent to fix it' })
  );
  await waitFor(() =>
    expect(a.askAgentToFix).toHaveBeenCalledWith('r-1', error)
  );
});

test('stage 4: Looks good, or ask for changes on the same run', async () => {
  const { a } = card({
    stage: 'review',
    taskId: 't-1',
    run: run({ state: 'finished' }),
  });
  expect(screen.getByText(/Green lines were added/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Looks good' }));
  expect(a.looksGood).toHaveBeenCalledWith('r-1');
  fireEvent.click(screen.getByRole('button', { name: 'Ask for changes' }));
  fireEvent.change(screen.getByLabelText('What should change'), {
    target: { value: 'Use the brand colour' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to the agent' }));
  await waitFor(() =>
    expect(a.askForChanges).toHaveBeenCalledWith('r-1', 'Use the brand colour')
  );
  // The box closes once the request is sent.
  await waitFor(() =>
    expect(screen.queryByLabelText('What should change')).toBeNull()
  );
});

test('stage 5 lands with the plain label, and a refused land says why', async () => {
  const { a } = card({
    stage: 'land',
    taskId: 't-1',
    run: run({ state: 'finished' }),
  });
  a.land.mockImplementation(() =>
    Promise.reject(new Error('merge conflict in src/a.ts'))
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Add these changes to your project' })
  );
  expect(await screen.findByText('merge conflict in src/a.ts')).toBeTruthy();
  expect(a.land).toHaveBeenCalledWith('r-1');
});

test('a pull request that has not merged can be opened, or set aside after a confirm', async () => {
  const { a } = card({
    stage: 'land',
    taskId: 't-1',
    run: run({ state: 'finished', prUrl: 'https://github.com/o/r/pull/1' }),
    waitingOnPr: true,
  });
  expect(screen.getByText(/This step finishes when it merges/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open the review page' }));
  expect(a.openTask).toHaveBeenCalledWith('t-1', 'review', 'r-1');
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  // Nothing happens until the confirm, which says the pull request stays open.
  expect(a.startOver).not.toHaveBeenCalled();
  // The ConfirmDialog renders on the same commit as the click.
  const dialog = screen.getByRole('alertdialog');
  expect(dialog.textContent).toContain(
    "This won't close the pull request on GitHub"
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(a.startOver).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Start the task over',
    })
  );
  await waitFor(() => expect(a.startOver).toHaveBeenCalledWith('r-1'));
});

test('a merge the queue refused shows its reason on the Land step, and Try again lands', async () => {
  const { a } = card({
    stage: 'land',
    taskId: 't-1',
    run: run({
      state: 'finished',
      reviewFailure: {
        action: 'merge',
        reason: 'merge conflict in src/theme.ts',
        at: '2026-10-11T00:00:00.000Z',
      },
    }),
  });
  expect(screen.getByText('merge conflict in src/theme.ts')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(a.land).toHaveBeenCalledWith('r-1'));
});

test("a failed discard is not the Land step's failure", () => {
  card({
    stage: 'land',
    taskId: 't-1',
    run: run({
      state: 'finished',
      reviewFailure: {
        action: 'discard',
        reason: 'worktree would not remove',
        at: '2026-10-11T00:00:00.000Z',
      },
    }),
  });
  expect(screen.queryByText('worktree would not remove')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('done points at the board, the Overseer and a teammate', () => {
  const { a } = card({
    stage: 'done',
    taskId: 't-1',
    run: run({ state: 'finished' }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Invite a teammate' }));
  expect(a.inviteTeammate).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close the guide' }));
  expect(a.closeCompletion).toHaveBeenCalled();
});

test('collapsed shows only where you are', () => {
  card(
    { stage: 'review', taskId: 't-1', run: run({ state: 'finished' }) },
    { collapsed: true }
  );
  expect(
    screen.getByText('Your first task · Step 4 of 5: Review')
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Looks good' })).toBeNull();
});

test('no stage uses a word the copy rules ban', () => {
  const views: GuideView[] = [
    { stage: 'describe' },
    { stage: 'check', taskId: 't-1' },
    { stage: 'works', taskId: 't-1', run: run() },
    { stage: 'review', taskId: 't-1', run: run({ state: 'finished' }) },
    { stage: 'land', taskId: 't-1', run: run({ state: 'finished' }) },
    {
      stage: 'land',
      taskId: 't-1',
      run: run({ state: 'finished', prUrl: 'https://github.com/o/r/pull/1' }),
      waitingOnPr: true,
    },
    { stage: 'done', taskId: 't-1', run: run({ state: 'finished' }) },
  ];
  for (const view of views) {
    const { container, unmount } = card(view);
    expect({
      stage: view.stage,
      banned: BANNED.test(container.textContent ?? ''),
    }).toEqual({
      stage: view.stage,
      banned: false,
    });
    unmount();
  }
});

test('the collapse toggle says whether the card is open', () => {
  const { onCollapsedChange } = card({ stage: 'describe' });
  const toggle = screen.getByRole('button', { name: 'Collapse the guide' });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(toggle);
  expect(onCollapsedChange).toHaveBeenCalledWith(true);
});

test('closing mid-task asks first; closing at Describe does not', () => {
  const first = card({ stage: 'describe' });
  fireEvent.click(screen.getByRole('button', { name: 'Close the guide' }));
  expect(first.a.dismiss).toHaveBeenCalledTimes(1);
  first.unmount();

  const { a } = card({ stage: 'works', taskId: 't-1', run: run() });
  fireEvent.click(screen.getByRole('button', { name: 'Close the guide' }));
  expect(a.dismiss).not.toHaveBeenCalled();
  const dialog = screen.getByRole('alertdialog');
  expect(dialog.textContent).toContain('Your task keeps going');
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Keep the guide' })
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(a.dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close the guide' }));
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Close the guide for good',
    })
  );
  expect(a.dismiss).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('the steps list marks the current step with aria-current, not colour alone', () => {
  card({ stage: 'review', taskId: 't-1', run: run({ state: 'finished' }) });
  const steps = within(
    screen.getByRole('list', { name: 'Steps' })
  ).getAllByRole('listitem');
  expect(steps.map((li) => li.getAttribute('aria-current'))).toEqual([
    null,
    null,
    null,
    'step',
    null,
  ]);
  expect(steps[3]?.textContent).toBe('Review');
});

test('the drafting and working lines are polite status lines beside their Spinners', () => {
  const draft = { id: 'd-1', prompt: 'x' } as DraftRecord;
  const drafting = card({ stage: 'describe', draft, waiting: 'drafting' });
  // The Spinner is hidden from assistive tech, so its line says it in words.
  expect(screen.getByRole('status').textContent).toBe('Drafting your task…');
  drafting.unmount();
  card({ stage: 'works', taskId: 't-1', run: run() });
  expect(screen.getByRole('status').textContent).toBe('Getting started…');
});

test('landing is said in words while the Spinner turns', async () => {
  const { a } = card({
    stage: 'land',
    taskId: 't-1',
    run: run({ state: 'finished' }),
  });
  let finish = () => {};
  a.land.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  // Mounted empty before the click, so the words are announced.
  const status = screen.getByRole('status');
  expect(status.textContent).toBe('');
  fireEvent.click(
    screen.getByRole('button', { name: 'Add these changes to your project' })
  );
  await waitFor(() =>
    expect(status.textContent).toBe('Adding the changes to your project…')
  );
  finish();
  await waitFor(() => expect(status.textContent).toBe(''));
});

test('the review box grows with what you write', () => {
  card({ stage: 'review', taskId: 't-1', run: run({ state: 'finished' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Ask for changes' }));
  const box = screen.getByLabelText<HTMLTextAreaElement>('What should change');
  expect(box.getAttribute('rows')).toBe('3');
  // happy-dom lays nothing out, so stand in the height the text would take.
  Object.defineProperty(box, 'scrollHeight', {
    configurable: true,
    value: 140,
  });
  fireEvent.input(box, { target: { value: 'one\ntwo\nthree\nfour\nfive' } });
  expect(box.style.height).toBe('140px');
});
