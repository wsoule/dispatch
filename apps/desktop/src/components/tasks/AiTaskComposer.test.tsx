import type { DraftRecord } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from '../shell/ShellActionsContext';
import { AiTaskComposer } from './AiTaskComposer';

type StartOptions = { parent?: string | null } | undefined;

function mount(preset: CreateTaskPreset | null) {
  const started: [string, StartOptions][] = [];
  const quickAdds: CreateTaskPreset[] = [];
  const data = {
    portLoading: false,
    portError: false,
    client: {},
    epics: [
      { meta: { id: 'e-1', title: 'Payments › Beta', kind: 'milestone' } },
    ] as unknown as TaskDoc[],
  } as unknown as DispatchProjectData;
  const shell = { createPreset: preset } as unknown as ShellActions;
  render(
    <ShellActionsProvider value={shell}>
      <AiTaskComposer
        data={data}
        onStartDraft={(prompt, options) => {
          started.push([prompt, options]);
          return Promise.resolve({ id: 'd-1' } as DraftRecord);
        }}
        onQuickAdd={(next) =>
          quickAdds.push({ status: next.status, epic: next.epic })
        }
        onClose={() => {}}
      />
    </ShellActionsProvider>
  );
  return { started, quickAdds };
}

async function draft(text: string) {
  fireEvent.change(screen.getByLabelText('Describe the task'), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: /Draft task/ }));
  // The submit awaits the start call; let it settle.
  await act(() => Promise.resolve());
}

test("a container's + drafts the task inside it", async () => {
  const { started } = mount({ epic: 'e-1' });
  expect(document.querySelector('[data-slot=draft-parent]')?.textContent).toBe(
    'In Payments › Beta'
  );
  await draft('add refunds');
  expect(started).toEqual([['add refunds', { parent: 'e-1' }]]);
});

test('the parent chip can be dropped before drafting', async () => {
  const { started } = mount({ epic: 'e-1' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Not in Payments › Beta' })
  );
  expect(document.querySelector('[data-slot=draft-parent]')).toBeNull();
  await draft('add refunds');
  expect(started).toEqual([['add refunds', undefined]]);
});

test('without a preset nothing is pinned', async () => {
  const { started } = mount(null);
  expect(document.querySelector('[data-slot=draft-parent]')).toBeNull();
  await draft('add refunds');
  expect(started).toEqual([['add refunds', undefined]]);
});

test('Quick add carries the parent the composer still holds', () => {
  const { quickAdds } = mount({ status: 'ready', epic: 'e-1' });
  fireEvent.click(screen.getByRole('button', { name: /Quick add/ }));
  expect(quickAdds).toEqual([{ status: 'ready', epic: 'e-1' }]);
});

test('a dropped parent chip stays dropped in Quick add', () => {
  const { quickAdds } = mount({ status: 'ready', epic: 'e-1' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Not in Payments › Beta' })
  );
  fireEvent.click(screen.getByRole('button', { name: /Quick add/ }));
  expect(quickAdds).toEqual([{ status: 'ready' }]);
});
