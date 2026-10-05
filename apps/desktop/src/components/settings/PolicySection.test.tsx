import type {
  DispatchConfig,
  LedgerEntry,
  PolicyConfig,
} from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { testConfig } from './fixtures.test-helper';
import { PolicySection } from './PolicySection';

// Base UI commits a select item on a click that began on it (a bare click is
// treated as one that opened the list under the pointer), so press first.
function chooseOption(name: string) {
  const option = screen.getByRole('option', { name });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

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
  return {
    fetchLedger: () => Promise.resolve(entries),
  } as unknown as ApiClient;
}

const noSave = async () => {};

test('the slider sits on the configured rung and a stop click saves the new one', () => {
  const saves: unknown[] = [];
  render(
    <PolicySection
      config={configAt(1)}
      onSave={(patch) => Promise.resolve(void saves.push(patch))}
      client={null}
    />
  );
  const slider = screen.getByLabelText('Autonomy');
  expect((slider as HTMLInputElement).value).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Fix on its own' }));
  expect(saves).toEqual([{ policy: { rung: 3 } }]);
});

test('re-clicking the current stop does not save', () => {
  const saves: unknown[] = [];
  render(
    <PolicySection
      config={configAt(2)}
      onSave={(patch) => Promise.resolve(void saves.push(patch))}
      client={null}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Allow extra files' }));
  expect(saves).toEqual([]);
});

test('gate rows show the effective mode consultPolicy derives from the rung', () => {
  render(<PolicySection config={configAt(3)} onSave={noSave} client={null} />);
  // Rung 3: scope, approval, verify-retry and wake auto-decide; merge,
  // memory and doc still block.
  expect(screen.getAllByText('Automatic')).toHaveLength(4);
  expect(screen.getAllByText('Waits for you')).toHaveLength(3);
});

test('a pinned gate reads as pinned and a pin change saves key-by-key', () => {
  const saves: unknown[] = [];
  render(
    <PolicySection
      config={configAt(1, { merge: 'auto' })}
      onSave={(patch) => Promise.resolve(void saves.push(patch))}
      client={null}
    />
  );
  expect(screen.getByText('Automatic, pinned')).toBeDefined();
  fireEvent.click(screen.getByRole('combobox', { name: 'Merging override' }));
  chooseOption('Follow level');
  expect(saves).toEqual([{ policy: { gates: { merge: null } } }]);
  fireEvent.click(
    screen.getByRole('combobox', { name: 'Extra files override' })
  );
  chooseOption('Always wait');
  expect(saves).toHaveLength(2);
  expect(saves[1]).toEqual({ policy: { gates: { scope: 'block' } } });
});

test('the irreversibility floor renders fixed rows with no control', () => {
  render(<PolicySection config={configAt(4)} onSave={noSave} client={null} />);
  expect(screen.getAllByText('Always waits')).toHaveLength(6);
  expect(screen.getByText(/Force-push/)).toBeDefined();
  expect(screen.getByText(/Publishing packages/)).toBeDefined();
  // Even at the top rung the floor never gains a select: only the seven
  // policy gates have overrides.
  expect(screen.getAllByRole('combobox')).toHaveLength(7);
});

test("the top stop says it accepts agents' shared memory, and memory has its own row", () => {
  render(<PolicySection config={configAt(4)} onSave={noSave} client={null} />);
  expect(
    screen.getByRole('button', {
      name: 'Merge and accept memory and doc edits on their own',
    })
  ).toBeDefined();
  expect(screen.getByText('Shared memory from agents')).toBeDefined();
  expect(
    screen.getByRole('combobox', { name: 'Shared memory from agents override' })
  ).toBeDefined();
});

test('the top stop covers doc edits, doc has its own row, and saving a rung never writes a doc pin', async () => {
  const saved: unknown[] = [];
  render(
    <PolicySection
      config={configAt(3)}
      onSave={(patch) => Promise.resolve(void saved.push(patch))}
      client={null}
    />
  );
  const top = screen.getByRole('button', {
    name: 'Merge and accept memory and doc edits on their own',
  });
  expect(screen.getByText('Edits to accepted docs')).toBeDefined();
  expect(
    screen.getByRole('combobox', { name: 'Edits to accepted docs override' })
  ).toBeDefined();
  fireEvent.click(top);
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0]).toEqual({ policy: { rung: 4 } });
  expect(JSON.stringify(saved[0])).not.toContain('"doc"');
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

// Lessons moved to memory; the receipts are the ledger's audit class alone.
test('reads receipts from the ledger’s audit class', async () => {
  const filters: unknown[] = [];
  const client = {
    fetchLedger: (filter?: unknown) => {
      filters.push(filter);
      return Promise.resolve([]);
    },
  } as unknown as ApiClient;
  render(
    <PolicySection config={configAt(2)} onSave={noSave} client={client} />
  );
  await waitFor(() => expect(filters).toEqual([{ class: 'audit' }]));
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
    expect(screen.getByText(/None yet\. Each one is listed here/)).toBeDefined()
  );
});

// The hard stops are their own group under a 13px/600 sentence-case heading,
// never an uppercase tracked label, and the receipt's task id is sans with the
// id tracking.
test('the hard stops heading is 13px sentence case and receipt ids are tracked sans', async () => {
  render(
    <PolicySection
      config={configAt(2)}
      onSave={noSave}
      client={clientWith([receipt({})])}
    />
  );
  const floor = screen.getByRole('heading', { level: 2, name: 'Hard stops' });
  expect(floor.className).toContain('text-[13px]');
  expect(floor.className).toContain('font-semibold');
  expect(floor.className).not.toContain('uppercase');
  await screen.findByText('Scope extended for run r-x');
  const id = screen.getByText('t-aaaaaa');
  expect(id.className).toContain('tracking-(--id-tracking)');
  expect(id.className).not.toContain('font-mono');
});
