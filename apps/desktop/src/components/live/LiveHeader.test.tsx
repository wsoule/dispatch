import { act, fireEvent, render, screen } from '@testing-library/react';
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

// A cell's words on the row: its inner element's text without a note moved into the
// cell's hint (srOnly words, still read by a screen reader).
function rowText(cell: HTMLElement): string {
  const inner = cell.firstElementChild;
  if (inner === null) return '';
  return Array.from(inner.childNodes)
    .filter(
      (node) =>
        !(node instanceof HTMLElement && node.classList.contains('srOnly'))
    )
    .map((node) => node.textContent)
    .join('');
}

// The note a hinted cell keeps in its text for a screen reader, or null.
function spokenNote(cell: Element | null | undefined): string | null {
  const inner = cell?.firstElementChild;
  const spoken = Array.from(inner?.children ?? []).find((el) =>
    el.classList.contains('srOnly')
  );
  return spoken?.textContent ?? null;
}

// The hidden words a hinted cell's accessible description holds (its title).
function describedBy(cell: Element | null | undefined): string | null {
  const described = cell?.firstElementChild?.getAttribute('aria-describedby');
  if (described === null || described === undefined) return null;
  return document.getElementById(described)?.textContent ?? null;
}

const SPEND_TITLE =
  '$4.20 spent today; $8.10 settled in the live fan-outs, of their $60 ceilings';

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

  test('short keys that each say what they count; the spend key says which amount, its note in a hint', () => {
    const { getAllByRole } = renderHeader({ active: 1, resumable: 0 });
    const cells = getAllByRole('listitem');
    // The spend's note is in its hint (owner decision 2026-11-04), so every cell fits
    // beside Pause all at 1024px; its key says "Today" on the row, so the value reads as
    // today's spend at a glance, without a hover.
    expect(cells.map(rowText)).toEqual([
      'Slots2/4',
      'Running2',
      'Queued3',
      'Blocked on teammates1',
      'Landing0',
      'Today$4.20',
    ]);
    // The note stays in the cell's text for a screen reader, the title its description.
    expect(spokenNote(cells[5])).toBe('$8.10 of $60 ceilings');
    expect(describedBy(cells[5])).toBe(SPEND_TITLE);
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
      // The hinted cell carries no native title: its Tooltip says it.
      null,
    ]);
    // Only the cell with a note is a tab stop for its hint; the others take no tabindex.
    expect(
      cells.map((c) => c.firstElementChild?.getAttribute('tabindex') ?? null)
    ).toEqual([null, null, null, null, null, '0']);
  });

  test("the spend's hint is its title, on keyboard focus at once and on hover after the delay", async () => {
    const { container } = renderHeader({ active: 1, resumable: 0 });
    const spend = container.querySelector('[data-slot=live-spend] > div');
    if (!(spend instanceof HTMLElement)) throw new Error('no spend cell');
    act(() => spend.focus());
    // The title already says both amounts: no "today · …" fragment before it.
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(
      SPEND_TITLE
    );
    act(() => spend.blur());
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    // Out of the warm window the blur just opened, a hover waits out the delay.
    await act(() => new Promise((resolve) => setTimeout(resolve, 450)));
    fireEvent.pointerEnter(spend, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(
      SPEND_TITLE
    );
  });

  test('today with no fan-out ceilings: "Today" and no note to hint', () => {
    const { getAllByRole } = render(
      <LiveHeader
        totals={totals}
        spendToday={4.2}
        ceilings={null}
        active={1}
        resumable={0}
        capped={0}
        busy={false}
        onPauseAll={() => {}}
        onResumeAll={() => {}}
      />
    );
    const spend = getAllByRole('listitem')[5];
    expect(spend && rowText(spend)).toBe('Today$4.20');
    expect(spend?.firstElementChild?.hasAttribute('data-hint')).toBe(false);
    expect(spend?.firstElementChild?.getAttribute('title')).toBe(
      '$4.20 spent today'
    );
  });

  test('no fan-out live, no spend today and no ceiling: the keys and hints say so', () => {
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
    // With no spend today the value is the live fan-outs' settled spend, under "Spend".
    expect(cells[5] && rowText(cells[5])).toBe('Spend$8.10');
    expect(spokenNote(cells[5])).toBe('no ceiling');
    expect(describedBy(cells[5])).toBe(
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
