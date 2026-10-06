import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { DecisionItem } from '../../lib/decisionFeed';
import { needsYou } from '../../lib/needsYou';
import { NeedsYouBlock } from './NeedsYouBlock';

const ME = 'human:wyat';

// No client: the gate query stays off, so rows fall back to their Open button.
const data = {
  client: null,
  port: undefined,
  me: ME,
  tasks: [],
  runs: [],
  presence: [],
  messageAccess: { canDecide: true, canMessage: true, explanation: null },
  scopeDecide: {
    enabled: true,
    notice: null,
    explanation: null,
    restart: null,
  },
} as unknown as DispatchProjectData;

function item(over: Partial<DecisionItem> & Pick<DecisionItem, 'id' | 'kind'>) {
  return {
    summary: `ask ${over.id}`,
    since: '2026-10-06T09:00:00.000Z',
    ageMs: 0,
    state: 'open',
    disposition: 'blocking',
    ...over,
  } satisfies DecisionItem;
}

function mount(
  decisions: DecisionItem[],
  decided: DecisionItem[] = [],
  fold?: { folded: boolean; onFoldedChange: (folded: boolean) => void }
) {
  const opened: string[] = [];
  const needs = needsYou(decisions, ME);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NeedsYouBlock
        data={data}
        needs={needs}
        decided={decided}
        onOpenRef={(action) => opened.push(action.kind)}
        onOpenDecision={(decision) => opened.push(decision.id)}
        folded={fold?.folded}
        onFoldedChange={fold?.onFoldedChange}
      />
    </QueryClientProvider>
  );
  return { needs, opened };
}

describe('NeedsYouBlock', () => {
  test('says so when nothing needs you', () => {
    mount([]);
    expect(screen.getByTestId('needs-you-count').textContent).toBe(
      'Nothing needs you'
    );
  });

  test('the header number is the number of rows', () => {
    const { needs } = mount([
      item({ id: 'a', kind: 'fix-loop-capped', taskId: 't-1' }),
      item({ id: 'b', kind: 'doc', taskId: 't-1' }),
      item({ id: 'c', kind: 'approval', reason: 'agent-registration' }),
    ]);
    expect(screen.getByTestId('needs-you-count').textContent).toBe(
      `Needs you · ${needs.count}`
    );
    expect(screen.getAllByTestId('needs-you-row')).toHaveLength(needs.count);
  });

  test('groups render in their fixed order', () => {
    mount([
      item({ id: 'admin', kind: 'approval', reason: 'agent-registration' }),
      item({ id: 'work', kind: 'scope-request' }),
    ]);
    const groups = screen
      .getAllByTestId(/^needs-you-group-/)
      .map((g) => g.dataset.testid);
    expect(groups).toEqual(['needs-you-group-work', 'needs-you-group-admin']);
  });

  test('an ask with no gate card opens where it is handled', () => {
    const { opened } = mount([
      item({ id: 'stall', kind: 'run-stalled', reason: 'orphan-commits' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(opened).toEqual(['stall']);
  });

  test('a teammate’s ask is shown muted and never counted', () => {
    mount([
      item({ id: 'mine', kind: 'scope-request', owner: ME }),
      item({
        id: 'theirs',
        kind: 'scope-request',
        owner: 'human:priya',
        summary: 'Priya’s r-41 wants Bash',
      }),
    ]);
    expect(screen.getByTestId('needs-you-count').textContent).toBe(
      'Needs you · 1'
    );
    const footer = screen.getByRole('button', { name: /Teammates · 1 ask/ });
    expect(footer.textContent).toContain('not counted');
    expect(
      within(screen.getByTestId('needs-you')).getAllByTestId('needs-you-row')
    ).toHaveLength(1);
  });

  test('folding hides the rows but keeps the count', () => {
    mount([item({ id: 'a', kind: 'scope-request' })]);
    fireEvent.click(screen.getByRole('button', { name: /Needs you · 1/ }));
    expect(screen.queryAllByTestId('needs-you-row')).toHaveLength(0);
    expect(screen.getByTestId('needs-you-count').textContent).toBe(
      'Needs you · 1'
    );
  });
});

describe('folding from outside', () => {
  test('a folded block is one line: the count and the first ask', () => {
    const changes: boolean[] = [];
    mount(
      [
        item({ id: 'a', kind: 'scope-request', summary: 'widen writes' }),
        item({ id: 'b', kind: 'doc' }),
      ],
      [],
      { folded: true, onFoldedChange: (f) => changes.push(f) }
    );
    expect(screen.queryAllByTestId('needs-you-row')).toHaveLength(0);
    expect(screen.getByTestId('needs-you-count').textContent).toBe(
      'Needs you · 2'
    );
    expect(screen.getByTestId('needs-you-preview').textContent).toBe(
      'widen writes'
    );
    fireEvent.click(screen.getByRole('button', { name: /Needs you · 2/ }));
    expect(changes).toEqual([false]);
    // The owner decides; the block stays folded until the prop changes.
    expect(screen.queryAllByTestId('needs-you-row')).toHaveLength(0);
  });
});

describe('receipts and batches', () => {
  test('an ask decided elsewhere shows as a receipt and is not counted', () => {
    mount(
      [item({ id: 'open', kind: 'scope-request' })],
      [
        item({
          id: 'done',
          kind: 'scope-request',
          state: 'resolved',
          resolvedAt: '2026-10-06T09:14:00.000Z',
          summary: 'agent asked to edit outside its scope: a.ts',
        }),
      ]
    );
    expect(screen.getByTestId('needs-you-count').textContent).toBe(
      'Needs you · 1'
    );
    expect(screen.getByTestId('needs-you-receipt').textContent).toContain(
      'Decided by you · agent asked to edit outside its scope: a.ts'
    );
    expect(screen.getAllByTestId('needs-you-row')).toHaveLength(1);
  });

  test('restored lessons are one row with Approve all', () => {
    const restored = (id: string) =>
      item({
        id,
        kind: 'memory',
        messageId: id,
        summary: 'system proposes a team memory restored from the receipt log',
      });
    mount([restored('m-1'), restored('m-2'), restored('m-3')]);
    expect(screen.getByTestId('needs-you-count').textContent).toBe(
      'Needs you · 1'
    );
    expect(screen.getByText('Review 3 restored lessons')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve all' })).toBeTruthy();
  });
});
