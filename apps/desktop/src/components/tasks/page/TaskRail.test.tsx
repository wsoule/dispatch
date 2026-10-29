import type {
  ApiClient,
  ConversationQuery,
  Message,
  PlanRecord,
} from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import {
  fakeHost,
  type HostLog,
  newLog,
  PageProviders,
  run,
  task,
} from './pageHost.test-helper';

// The Review mode pulls in the Pierre diff, whose worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { TaskPage } = await import('./TaskPage');

function mount(tasks: ReturnType<typeof task>[], log: HostLog = newLog()) {
  render(
    <PageProviders host={fakeHost(log, { tasks })}>
      <TaskPage taskId="t-1" layout="peek" />
    </PageProviders>
  );
  const rail = document.querySelector<HTMLElement>('[data-slot=task-rail]');
  if (rail === null) throw new Error('no rail');
  return rail;
}

describe('TaskRail Linear fields', () => {
  test('a project shows its icon in its colour, its start date and its creator', () => {
    const rail = mount([
      task('t-1', {
        kind: 'project',
        icon: 'Rocket',
        color: '#5e6ad2',
        startDate: '2026-10-01',
        creator: 'human:maya',
      }),
    ]);
    const container = rail.querySelector<HTMLElement>(
      '[data-slot=container-row]'
    );
    expect(container?.textContent).toContain('Project');
    expect(container?.getAttribute('title')).toBe(
      'Icon Rocket · Color #5e6ad2'
    );
    const icon = container?.querySelector<SVGElement>(
      '[data-slot=container-icon]'
    );
    // Rocket is a known Linear icon, drawn in the project's colour.
    expect(icon?.getAttribute('class')).toContain('lucide-rocket');
    expect(icon?.getAttribute('style')).toContain('color');
    expect(
      rail.querySelector('[data-slot=start-date-control]')?.textContent
    ).toContain('Oct 1');
    expect(
      rail.querySelector('[data-slot=creator-row]')?.textContent
    ).toContain('Created by maya');
  });

  test('an emoji icon draws as itself', () => {
    const rail = mount([task('t-1', { kind: 'milestone', icon: '🧭' })]);
    expect(rail.querySelector('[data-slot=container-icon]')?.textContent).toBe(
      '🧭'
    );
  });

  test('a plain task with neither field shows no start date or creator row', () => {
    const rail = mount([task('t-1')]);
    expect(rail.querySelector('[data-slot=container-row]')).toBeNull();
    expect(rail.querySelector('[data-slot=start-date-control]')).toBeNull();
    expect(rail.querySelector('[data-slot=creator-row]')).toBeNull();
  });

  test('setting and clearing the start date patches the task', async () => {
    const log = newLog();
    mount([task('t-1', { kind: 'project', startDate: '2026-10-01' })], log);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Change start date'));
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-10-05' },
    });
    expect(log.updates.at(-1)).toEqual({
      id: 't-1',
      patch: { startDate: '2026-10-05' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Change start date'));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('Clear start date'));
    expect(log.updates.at(-1)).toEqual({
      id: 't-1',
      patch: { startDate: null },
    });
  });
});

// An enrich plan for t-1 that stopped to ask the human something.
function askingPlan(over: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: 'pl-1',
    prompt: 'add detail',
    plannerName: 'claude',
    role: 'enrich',
    state: 'ready',
    messages: [],
    questions: [
      { id: 'q1', question: 'Which store?', options: ['SQLite', 'JSON'] },
    ],
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...over,
  };
}

function mountAsking({
  live,
  plan = askingPlan(),
  sendPlanMessage = () => Promise.resolve(plan),
}: {
  live: boolean;
  plan?: PlanRecord;
  sendPlanMessage?: ApiClient['sendPlanMessage'];
}) {
  render(
    <PageProviders
      host={fakeHost(newLog(), {
        tasks: [task('t-1')],
        // A live run puts the page in Run mode; none leaves it in Spec mode.
        runs: live ? [run()] : [],
        client: { sendPlanMessage },
        project: { enrichTaskId: 't-1', enrichPlanRecord: plan },
      })}
    >
      <TaskPage taskId="t-1" layout="peek" />
    </PageProviders>
  );
}

describe('TaskRail planner questions', () => {
  test("outside Spec mode the rail carries the task's open planner questions", () => {
    mountAsking({ live: true });
    const section = document.querySelector<HTMLElement>(
      '[data-slot=task-rail] [data-slot=planner-questions]'
    );
    expect(section?.textContent).toContain('Which store?');
  });

  test('answering in the rail sends the composed answers to the plan', async () => {
    const sent: { id: string; message: string }[] = [];
    mountAsking({
      live: true,
      sendPlanMessage: (id, message) => {
        sent.push({ id, message });
        return Promise.resolve(askingPlan());
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'SQLite' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Send answers/ }));
      await Promise.resolve();
    });
    expect(sent).toEqual([
      { id: 'pl-1', message: 'Q: Which store?\nA: SQLite' },
    ]);
  });

  test('in Spec mode the questions stay in the spec, not twice in the rail', () => {
    mountAsking({ live: false });
    expect(
      document.querySelector(
        '[data-slot=task-rail] [data-slot=planner-questions]'
      )
    ).toBeNull();
    expect(screen.getAllByText('Which store?')).toHaveLength(1);
  });

  test("another task's enrich questions never show on this rail", () => {
    render(
      <PageProviders
        host={fakeHost(newLog(), {
          tasks: [task('t-1'), task('t-2')],
          runs: [run()],
          project: { enrichTaskId: 't-2', enrichPlanRecord: askingPlan() },
        })}
      >
        <TaskPage taskId="t-1" layout="peek" />
      </PageProviders>
    );
    expect(document.querySelector('[data-slot=planner-questions]')).toBeNull();
  });
});

// A message about t-1, with the fields the rail reads.
function a2aMessage(over: Partial<Message>): Message {
  return {
    id: 'm-1',
    thread: 'th-1',
    replyTo: null,
    from: 'run:r-1',
    to: ['task:t-1'],
    kind: 'message',
    body: 'hi',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-10-29T10:00:00.000Z',
    ...over,
  };
}

function mountWithConversation(
  messages: Message[],
  { canMessage = true }: { canMessage?: boolean } = {}
) {
  const asked: ConversationQuery[] = [];
  render(
    <PageProviders
      host={fakeHost(newLog(), {
        tasks: [task('t-1')],
        client: {
          getConversation: (query) => {
            asked.push(query);
            return Promise.resolve({ messages, next: null });
          },
        },
        project: {
          messageAccess: { canDecide: true, canMessage, explanation: null },
        },
      })}
    >
      <TaskPage taskId="t-1" layout="peek" />
    </PageProviders>
  );
  return asked;
}

describe('TaskRail outside agents', () => {
  test("lists each outside agent in the task's conversation with what's waiting", async () => {
    const asked = mountWithConversation([
      a2aMessage({ id: 'q1', kind: 'question', to: ['a2a:acme-billing'] }),
      a2aMessage({
        id: 'q2',
        kind: 'question',
        from: 'agent:wyat/a2a.ci-bot',
        to: ['task:t-1'],
      }),
    ]);
    const section = await screen.findByText('Outside agents');
    expect(section).toBeDefined();
    const summaries = Array.from(
      document.querySelectorAll('[data-slot=outside-agent-summary]'),
      (el) => el.textContent
    );
    // The agent waiting on you comes first.
    expect(summaries).toEqual([
      'Waiting on you · 1 question',
      'Waiting on them · 1 question',
    ]);
    expect(asked[0]).toMatchObject({ about: 'task:t-1' });
  });

  test('a task no outside agent has talked to shows no section', async () => {
    mountWithConversation([a2aMessage({ from: 'human:wyat' })]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('[data-slot=outside-agents]')).toBeNull();
  });

  test('without messaging access the rail never asks for the conversation', async () => {
    const asked = mountWithConversation(
      [a2aMessage({ kind: 'question', to: ['a2a:acme-billing'] })],
      { canMessage: false }
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked).toEqual([]);
    expect(document.querySelector('[data-slot=outside-agents]')).toBeNull();
  });
});
