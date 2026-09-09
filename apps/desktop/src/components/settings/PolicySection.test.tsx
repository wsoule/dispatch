import type { ApiClient } from '@dispatch/client';
import type {
  DispatchConfig,
  LedgerEntry,
  PolicyConfig,
} from '@dispatch/core/browser';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { testConfig } from './fixtures.test-helper';
import { PolicySection } from './PolicySection';

function configAt(
  rung: number,
  gates: PolicyConfig['gates'] = {}
): DispatchConfig {
  return { ...testConfig, policy: { rung, gates } };
}

function receipt(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: 'l-000001',
    epicId: null,
    sourceTaskId: 't-aaaaaa',
    kind: 'decision',
    title: 'Scope extended for run r-x',
    detail: 'src/x.ts — needed (auto-decided by policy rung 2 (auto-scope))',
    appliesTo: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    authoredBy: 'human:x',
    ...overrides,
  };
}

function clientWith(entries: LedgerEntry[]): ApiClient {
  return { fetchLedger: async () => entries } as unknown as ApiClient;
}

const noSave = async () => {};

test('the slider sits on the configured rung and a stop click saves the new one', async () => {
  const saves: unknown[] = [];
  render(
    <PolicySection
      config={configAt(1)}
      onSave={async (patch) => void saves.push(patch)}
      client={null}
    />
  );
  const slider = screen.getByLabelText('Autonomy');
  expect((slider as HTMLInputElement).value).toBe('1');
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Auto-review, fix and retry verification',
    })
  );
  expect(saves).toEqual([{ policy: { rung: 3 } }]);
});

test('re-clicking the current stop does not save', () => {
  const saves: unknown[] = [];
  render(
    <PolicySection
      config={configAt(2)}
      onSave={async (patch) => void saves.push(patch)}
      client={null}
    />
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Auto-accept scope requests' })
  );
  expect(saves).toEqual([]);
});

test('gate rows show the effective mode consultPolicy derives from the rung', () => {
  render(<PolicySection config={configAt(3)} onSave={noSave} client={null} />);
  // Rung 3: scope, approval and verify-retry auto-decide, merge still blocks.
  expect(screen.getAllByText('Auto + records')).toHaveLength(3);
  expect(screen.getAllByText('Blocks')).toHaveLength(1);
});

test('a pinned gate reads as pinned and a pin change saves key-by-key', () => {
  const saves: unknown[] = [];
  render(
    <PolicySection
      config={configAt(1, { merge: 'auto' })}
      onSave={async (patch) => void saves.push(patch)}
      client={null}
    />
  );
  expect(screen.getByText('Auto + records (pinned)')).toBeDefined();
  fireEvent.change(screen.getByLabelText('Merge override'), {
    target: { value: 'rung' },
  });
  expect(saves).toEqual([{ policy: { gates: { merge: null } } }]);
  fireEvent.change(screen.getByLabelText('Scope requests override'), {
    target: { value: 'block' },
  });
  expect(saves).toHaveLength(2);
  expect(saves[1]).toEqual({ policy: { gates: { scope: 'block' } } });
});

test('the irreversibility floor renders fixed rows with no control', () => {
  render(<PolicySection config={configAt(4)} onSave={noSave} client={null} />);
  expect(screen.getAllByText('Always blocks')).toHaveLength(6);
  expect(screen.getByText(/Force-push/)).toBeDefined();
  expect(screen.getByText(/npm publish/)).toBeDefined();
  // Even at the top rung the floor never gains a select: only the four
  // policy gates have overrides.
  expect(screen.getAllByRole('combobox')).toHaveLength(4);
});

test('receipts list only policy auto-decisions and click through to the task', async () => {
  const opened: string[] = [];
  render(
    <PolicySection
      config={configAt(2)}
      onSave={noSave}
      client={clientWith([
        receipt({}),
        receipt({
          id: 'l-000002',
          title: 'A human decision',
          detail: 'granted by hand [decided via app]',
        }),
        receipt({
          id: 'l-000003',
          kind: 'hazard',
          title: 'A hazard mentioning auto-decided by',
        }),
      ])}
      onOpenTask={(taskId) => opened.push(taskId)}
    />
  );
  const row = await screen.findByText('Scope extended for run r-x');
  expect(screen.queryByText('A human decision')).toBeNull();
  expect(screen.queryByText(/A hazard/)).toBeNull();
  fireEvent.click(row);
  expect(opened).toEqual(['t-aaaaaa']);
});

test('an empty ledger explains where receipts will land', async () => {
  render(
    <PolicySection
      config={configAt(2)}
      onSave={noSave}
      client={clientWith([])}
    />
  );
  await waitFor(() =>
    expect(screen.getByText(/No auto-decisions yet/)).toBeDefined()
  );
});
