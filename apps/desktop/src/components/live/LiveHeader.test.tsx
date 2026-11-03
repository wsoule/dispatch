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
