import type { SubagentNode } from '@dispatch-foo/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'bun:test';

import { subagentHeadline, SubagentTree } from './SubagentTree';

function node(over: Partial<SubagentNode> & { id: string }): SubagentNode {
  return {
    parentId: null,
    label: over.id,
    status: 'running',
    startedAt: '2026-08-04T00:00:00.000Z',
    toolUses: 0,
    ...over,
  };
}

describe('SubagentTree', () => {
  it('renders nothing for a run that never fanned out', () => {
    const { container } = render(<SubagentTree nodes={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists one row per sub-agent with its status, calls and tail, nested under its parent', () => {
    render(
      <SubagentTree
        nodes={[
          node({
            id: 'outer',
            label: 'Map the server',
            type: 'Explore',
            toolUses: 4,
            summary: 'Reading routes',
          }),
          node({
            id: 'inner',
            parentId: 'outer',
            label: 'Check one route',
            status: 'failed',
            toolUses: 1,
            durationMs: 65_000,
            finishedAt: '2026-08-04T00:01:05.000Z',
            summary: 'Ran out of budget',
          }),
          node({
            id: 'other',
            label: 'Read the tests',
            status: 'done',
            toolUses: 9,
          }),
        ]}
      />
    );
    const rows = screen.getAllByRole('treeitem');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Map the server, running',
      'Check one route, failed',
      'Read the tests, done',
    ]);
    expect(rows[1].getAttribute('aria-level')).toBe('2');
    expect(rows[0].textContent).toContain('4 calls');
    expect(rows[0].textContent).toContain('Reading routes');
    expect(rows[1].textContent).toContain('1:05');
    expect(rows[1].textContent).toContain('Ran out of budget');
    expect(screen.getByText('Sub-agents · 3')).toBeDefined();
    expect(screen.getByText('1 of 3 running · 1 failed')).toBeDefined();
  });

  it('collapses and reopens from its header', () => {
    render(<SubagentTree nodes={[node({ id: 'a', label: 'A' })]} />);
    const header = screen.getByRole('button', { name: /sub-agents/i });
    expect(screen.queryByRole('tree')).not.toBeNull();
    fireEvent.click(header);
    expect(screen.queryByRole('tree')).toBeNull();
    fireEvent.click(header);
    expect(screen.queryByRole('tree')).not.toBeNull();
  });
});

describe('subagentHeadline', () => {
  it('reads running against total while any runs, and done once they all stopped', () => {
    expect(
      subagentHeadline([node({ id: 'a' }), node({ id: 'b', status: 'done' })])
    ).toBe('1 of 2 running');
    expect(
      subagentHeadline([
        node({ id: 'a', status: 'done' }),
        node({ id: 'b', status: 'stopped' }),
      ])
    ).toBe('1 done · 1 failed');
  });
});
