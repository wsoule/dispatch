import { fireEvent, render } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LiveTotals } from './liveBandModel';
import { LiveHeader } from './LiveHeader';

const totals: LiveTotals = {
  slots: { used: 2, total: 4 },
  running: 2,
  queued: 3,
  waitingOnTeammate: 1,
  landing: 0,
};

function renderHeader(
  fleet: { active: number; resumable: number; capped?: number },
  handlers: { onPauseAll?: () => void; onResumeAll?: () => void } = {}
) {
  return render(
    <LiveHeader
      totals={totals}
      spendToday={4.2}
      ceilings={{ live: 1, settledUsd: 8.1, ceilingUsd: 60 }}
      active={fleet.active}
      resumable={fleet.resumable}
      capped={fleet.capped ?? 0}
      busy={false}
      onPauseAll={handlers.onPauseAll ?? (() => {})}
      onResumeAll={handlers.onResumeAll ?? (() => {})}
    />
  );
}

// The strip's row: the element holding both the list's frame and the controls.
function stripRow(list: HTMLElement): HTMLElement | null {
  return list.parentElement?.parentElement?.parentElement ?? null;
}

describe('LiveHeader', () => {
  test('Pause all sits at the end of the strip row, outside the list', () => {
    const onPauseAll = mock(() => {});
    const { getByRole } = renderHeader(
      { active: 2, resumable: 0 },
      { onPauseAll }
    );
    const list = getByRole('list', { name: 'Live' });
    expect(list.getAttribute('data-slot')).toBe('live-header');
    expect(list.getAttribute('data-variant')).toBe('compact');
    const pause = getByRole('button', { name: 'Pause all' });
    expect(pause.getAttribute('data-slot')).toBe('live-pause-all');
    expect(list.contains(pause)).toBe(false);
    expect(stripRow(list)?.contains(pause)).toBe(true);
    fireEvent.click(pause);
    expect(onPauseAll).toHaveBeenCalledTimes(1);
  });

  test('Resume all takes the same place, hinting at ceiling-paused fan-outs', () => {
    const { getByRole, queryByRole } = renderHeader({
      active: 0,
      resumable: 2,
      capped: 1,
    });
    expect(queryByRole('button', { name: 'Pause all' })).toBeNull();
    const resume = getByRole('button', { name: 'Resume all' });
    expect(resume.getAttribute('data-slot')).toBe('live-resume-all');
    expect(resume.getAttribute('title')).toBe(
      '1 paused on a ceiling stay paused: raise it on the band'
    );
    const list = getByRole('list', { name: 'Live' });
    expect(stripRow(list)?.contains(resume)).toBe(true);
  });

  test('with nothing to pause or resume the row holds the strip alone', () => {
    const { getByRole, queryByRole } = renderHeader({
      active: 0,
      resumable: 0,
    });
    expect(queryByRole('button')).toBeNull();
    const row = stripRow(getByRole('list', { name: 'Live' }));
    expect(row?.childElementCount).toBe(1);
  });

  test('short keys and notes that each say what they count, detail in each hint', () => {
    const { getAllByRole } = renderHeader({ active: 1, resumable: 0 });
    const cells = getAllByRole('listitem');
    expect(cells.map((c) => c.textContent)).toEqual([
      'Slots2/4',
      'Running2',
      'Queued3',
      'Blocked on teammates1',
      'Landing0',
      'Spend$4.20today · $8.10 of $60 ceilings',
    ]);
    // Each hint is on the cell's inner element, never the <li>, so it is read as a
    // description and the key stays the item's words.
    expect(cells.map((c) => c.hasAttribute('title'))).toEqual(
      cells.map(() => false)
    );
    expect(
      cells.map((c) => c.firstElementChild?.getAttribute('title') ?? null)
    ).toEqual([
      '2 of 4 agent slots in use',
      null,
      'Starts on its own as a fan-out slot frees',
      "Blocked behind a teammate's issue, which no fan-out starts",
      null,
      '$4.20 spent today; $8.10 settled in the live fan-outs, of their $60 ceilings',
    ]);
  });

  test('no fan-out live and no ceiling: the hints say so', () => {
    const { getAllByRole } = render(
      <LiveHeader
        totals={{ ...totals, slots: { used: 0, total: 0 } }}
        spendToday={null}
        ceilings={{ live: 1, settledUsd: 8.1, ceilingUsd: null }}
        active={0}
        resumable={0}
        capped={0}
        busy={false}
        onPauseAll={() => {}}
        onResumeAll={() => {}}
      />
    );
    const cells = getAllByRole('listitem');
    expect(cells[0]?.textContent).toBe('SlotsNone');
    expect(cells[0]?.firstElementChild?.getAttribute('title')).toBe(
      'No fan-out is live, so no agent slots are held'
    );
    expect(cells[5]?.textContent).toBe('Spend$8.10no ceiling');
    expect(cells[5]?.firstElementChild?.getAttribute('title')).toBe(
      '$8.10 settled in the live fan-outs, which set no ceiling'
    );
  });

  test('the header is padding and a rule around the one-row strip', () => {
    const css = readFileSync(
      join(import.meta.dir, 'LiveHeader.module.css'),
      'utf8'
    );
    // The strip lays out its own row; the header no longer wraps a second one.
    expect(css).not.toContain('flex-wrap');
    expect(css).toContain('padding: var(--s-2) var(--s-4);');
    expect(css).toContain('border-bottom: 1px solid var(--border);');
  });
});
