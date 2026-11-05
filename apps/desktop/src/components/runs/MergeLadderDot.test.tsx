import type { RunMeta } from '@dispatch/client';
import { render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { MergeLadderPill } from './MergeLadderDot';

// Only the fields mergeLadderState reads; a full RunMeta carries a dozen more.
function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-abc123',
    taskId: 't-abc123',
    state: 'finished',
    branch: 'dispatch/t-abc123',
    baseBranch: 'main',
    ...over,
  } as RunMeta;
}

function pill(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-merge-ladder]');
}

describe('MergeLadderPill', () => {
  test('says nothing for a run that has not merged', () => {
    const { container } = render(<MergeLadderPill meta={run()} />);
    expect(container.innerHTML).toBe('');
    expect(
      render(<MergeLadderPill meta={undefined} />).container.innerHTML
    ).toBe('');
  });

  test('shows the Not merged rung only when asked to', () => {
    const { container } = render(<MergeLadderPill meta={run()} showUnmerged />);
    const el = pill(container);
    expect(el?.dataset['mergeLadder']).toBe('unmerged');
    expect(el?.textContent).toBe('Not merged');
    // The resting rung is grey: the muted tone drawn as a pill with a grey dot.
    expect(el?.dataset['tone']).toBe('muted');
    expect(el?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  test('a squash that never reached the remote is a warning chip', () => {
    const { container } = render(
      <MergeLadderPill
        meta={run({ reviewAction: 'merge', mergeCommit: 'abcdef1234567' })}
      />
    );
    const el = pill(container);
    expect(el?.tagName).toBe('SPAN');
    expect(el?.dataset['mergeLadder']).toBe('merged-local');
    // The status pill: the tone through data-tone, the hue in its aria-hidden dot, no inline
    // colour of its own.
    expect(el?.dataset['tone']).toBe('warning');
    expect(el?.hasAttribute('data-filled')).toBe(false);
    expect(el?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(el?.querySelector('[style]')).toBeNull();
    expect(el?.textContent).toBe('Not on GitHub');
    expect(el?.title).toBe('Merged locally — not on GitHub yet');
  });

  test('a merge that reached origin is a success chip', () => {
    const { container } = render(
      <MergeLadderPill
        meta={run({
          reviewAction: 'merge',
          mergeCommit: 'abcdef1234567',
          pushedToOrigin: true,
        })}
      />
    );
    const el = pill(container);
    expect(el?.dataset['mergeLadder']).toBe('on-origin');
    expect(el?.textContent).toBe('On origin');
    expect(el?.title).toBe('Landed on origin/main · abcdef1');
    expect(el?.dataset['tone']).toBe('success');
  });
});
