import type { CreateInput } from '@dispatch-foo/core/browser';
import type { DraftRecord } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { DraftView } from './DraftView';

function draftRecord(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: 'd-1',
    prompt: 'cache the search index',
    plannerName: 'planner',
    state: 'ready',
    message: '',
    proposal: {
      tasks: [
        {
          title: 'Cache the search index in redis',
          description: 'Keep the index warm between requests.',
          acceptanceCriteria: ['Index survives a restart', 'p95 under 50ms'],
          priority: 'high',
        },
      ],
    } as unknown as DraftRecord['proposal'],
    questions: [],
    error: null,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    ...over,
  };
}

function mount({
  draft = draftRecord(),
  projectName,
  onCreate = () => Promise.resolve(),
}: {
  draft?: DraftRecord;
  projectName?: string;
  onCreate?: (input: CreateInput) => Promise<void>;
} = {}) {
  const dismissed: string[] = [];
  let done = 0;
  const data = {
    config: { statuses: ['draft', 'ready', 'working', 'landed'] },
    epics: [],
    handleDismissDraft: (id: string) => {
      dismissed.push(id);
      return Promise.resolve();
    },
    handleSendDraftMessage: () => Promise.resolve(),
  } as unknown as DispatchProjectData;
  const created: CreateInput[] = [];
  render(
    <DraftView
      data={data}
      projectName={projectName}
      draft={draft}
      onCreate={(input) => {
        created.push(input);
        return onCreate(input);
      }}
      onDone={() => {
        done += 1;
      }}
    />
  );
  return { created, dismissed, done: () => done };
}

test('the task title is the 24px page heading over 15px prose, under a Drafts crumb', () => {
  mount({ projectName: 'dispatch' });

  const title = screen.getByLabelText<HTMLInputElement>('Task title');
  expect(title.value).toBe('Cache the search index in redis');
  expect(title.dataset['variant']).toBe('borderless');
  expect(title.className).toContain('text-[24px]');
  expect(title.className).toContain('font-semibold');
  expect(screen.queryByRole('heading', { name: 'Review draft' })).toBeNull();

  const description =
    screen.getByLabelText<HTMLTextAreaElement>('Task description');
  expect(description.dataset['variant']).toBe('borderless');
  expect(description.className).toContain('text-[15px]');

  const crumb = document.querySelector('[data-slot=page-header-crumb]');
  expect(crumb?.textContent).toContain('dispatch');
  expect(crumb?.textContent).toContain('Drafts');
  expect(crumb?.textContent).toContain('Draft');
});

test('acceptance criteria render as a checklist and the properties rail holds 32px rows', () => {
  mount();

  expect(
    screen.getByLabelText<HTMLInputElement>('Acceptance criterion 1').value
  ).toBe('Index survives a restart');
  expect(
    screen.getByLabelText<HTMLInputElement>('Acceptance criterion 2').value
  ).toBe('p95 under 50ms');
  expect(document.querySelectorAll('[data-slot=criterion-box]')).toHaveLength(
    2
  );

  const rail = screen.getByRole('complementary', { name: 'Properties' });
  expect(rail.className).toContain('w-[280px]');
  const rows = Array.from(
    rail.querySelectorAll('[data-slot=property-control]')
  );
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.getAttribute('data-variant')).toBe('row');
    expect(row.className).toContain('h-8');
  }
  expect(
    screen.getByRole('button', { name: 'Change status' }).textContent
  ).toBe('Draft');
  expect(
    screen.getByRole('button', { name: 'Change priority' }).textContent
  ).toBe('High');
});

test('Create task saves the edited draft, dismisses it and leaves', async () => {
  const { created, dismissed, done } = mount();

  fireEvent.change(screen.getByLabelText('Task title'), {
    target: { value: 'Cache the index' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await act(async () => {});

  expect(created[0]).toMatchObject({
    title: 'Cache the index',
    status: 'draft',
    priority: 'high',
  });
  expect(dismissed).toEqual(['d-1']);
  expect(done()).toBe(1);
});

test('a draft started inside a container saves the task under it', async () => {
  const { created } = mount({ draft: draftRecord({ parent: 'e-7' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await act(async () => {});
  expect(created[0]).toMatchObject({ parent: 'e-7' });
});

test('a failed create keeps the draft with the error inline', async () => {
  const { dismissed, done } = mount({
    onCreate: () => Promise.reject(new Error('daemon said no')),
  });

  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await act(async () => {});

  expect(screen.getByRole('alert').textContent).toBe('daemon said no');
  expect(dismissed).toEqual([]);
  expect(done()).toBe(0);
});

test('Discard dismisses without creating', async () => {
  const { created, dismissed, done } = mount();

  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  await act(async () => {});

  expect(created).toEqual([]);
  expect(dismissed).toEqual(['d-1']);
  expect(done()).toBe(1);
});

test('without a proposal there is no rail and Create task is disabled', () => {
  mount({ draft: draftRecord({ proposal: null, state: 'running' }) });

  expect(
    screen.queryByRole('complementary', { name: 'Properties' })
  ).toBeNull();
  expect(screen.getByText('No proposed task yet.')).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Create task' })
      .disabled
  ).toBe(true);
});
