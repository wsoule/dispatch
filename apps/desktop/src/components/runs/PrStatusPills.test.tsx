import type { PrCheckSummary } from '@dispatch/client';
import { render } from '@testing-library/react';
import { expect, test } from 'bun:test';

import {
  PrChecksPill,
  REVIEW_VERDICT,
  STATE_TONE,
  StatusPill,
} from './PrStatusPills';

const checks = (over: Partial<PrCheckSummary> = {}): PrCheckSummary => ({
  passed: 0,
  failed: 0,
  pending: 0,
  total: 0,
  runs: [],
  ...over,
});

test('a repo with no checks renders no pill at all', () => {
  const { container } = render(<PrChecksPill checks={checks()} />);
  expect(container.innerHTML).toBe('');
  const bare = render(<PrChecksPill />);
  expect(bare.container.innerHTML).toBe('');
});

// One failure outranks any pending run; pending outranks a clean pass.
test.each([
  [
    checks({ passed: 1, failed: 1, total: 3, pending: 1 }),
    'danger',
    'lucide-x',
  ],
  [checks({ passed: 1, pending: 1, total: 2 }), 'warning', 'lucide-clock'],
  [checks({ passed: 2, total: 2 }), 'success', 'lucide-check'],
])('the checks rollup picks its tone and icon: %#', (summary, tone, icon) => {
  const { container } = render(<PrChecksPill checks={summary} />);
  const chip = container.firstElementChild;
  // The glyph carries the tone, so the chip itself is the neutral badge.
  expect(chip?.getAttribute('data-tone')).toBe('default');
  const mark = chip?.querySelector('.toneText');
  expect(mark?.getAttribute('data-tone')).toBe(tone);
  const glyph = mark?.querySelector('svg');
  expect(glyph?.getAttribute('class')).toContain(icon);
  expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  expect(chip?.textContent).toBe(`${summary.passed}/${summary.total} checks`);
});

// A leading glyph is the fact's status mark, so it replaces the pill's dot:
// one toned mark per chip, never a hue dot beside a grey glyph.
test('a fact with a glyph draws the glyph in its tone and no dot', () => {
  const { container } = render(
    <>
      <StatusPill tone="success" icon={<svg data-glyph="open" />}>
        open
      </StatusPill>
      <StatusPill tone="danger" icon={<svg data-glyph="conflicts" />}>
        Conflicts
      </StatusPill>
      <StatusPill tone="muted" icon={<svg data-glyph="required" />}>
        Review required
      </StatusPill>
    </>
  );
  const chips = Array.from(container.children);
  expect(chips.map((chip) => chip.getAttribute('data-tone'))).toEqual([
    'default',
    'default',
    'default',
  ]);
  expect(
    chips.map((chip) =>
      chip.querySelector('.toneText')?.getAttribute('data-tone')
    )
  ).toEqual(['success', 'danger', 'muted']);
  for (const chip of chips) {
    // The library pill's dot is an empty aria-hidden span; none is drawn.
    expect(
      chip.querySelectorAll('span[aria-hidden="true"]:empty')
    ).toHaveLength(0);
  }
});

test('a toned fact without a glyph keeps the status pill and its dot', () => {
  const { container } = render(
    <StatusPill tone="warning">Changes requested</StatusPill>
  );
  const chip = container.firstElementChild;
  expect(chip?.getAttribute('data-tone')).toBe('warning');
  expect(chip?.querySelectorAll('span[aria-hidden="true"]:empty')).toHaveLength(
    1
  );
});

test('a toned fact is a status chip; muted is plain words with no glyph', () => {
  const { container } = render(
    <>
      <StatusPill tone="success">Reviewed</StatusPill>
      <StatusPill>Commented</StatusPill>
    </>
  );
  const [success, muted] = Array.from(
    container.querySelectorAll('[data-tone]')
  );
  expect(success?.getAttribute('data-tone')).toBe('success');
  expect(success?.textContent).toBe('Reviewed');
  expect(muted?.getAttribute('data-tone')).toBe('muted');
  expect(muted?.querySelector('svg')).toBeNull();
});

// Q6: a merged PR is closed-out work, the filled neutral mark. It is never
// green beside a red one, and never the purple accent, which is no status.
test('a merged PR is the filled neutral chip, with no status tone', () => {
  expect(STATE_TONE.MERGED).toBe('done');
  expect(STATE_TONE.OPEN).toBe('success');
  expect(STATE_TONE.CLOSED).toBe('danger');
  const { container } = render(
    <StatusPill tone={STATE_TONE.MERGED}>merged</StatusPill>
  );
  const chip = container.querySelector('[data-fill="neutral"]');
  expect(chip).not.toBeNull();
  expect(chip?.getAttribute('data-tone')).toBe('default');
  expect(chip?.textContent).toBe('merged');
});

test('verdict labels are sentence case, never shouted', () => {
  for (const { label } of Object.values(REVIEW_VERDICT)) {
    expect(label).toMatch(/^[A-Z][a-z]+(?: [a-z]+)*$/);
  }
  expect(REVIEW_VERDICT.CHANGES_REQUESTED.label).toBe('Changes requested');
});

test('verdicts keep the status table: approved green, changes amber, the rest quiet', () => {
  expect(REVIEW_VERDICT.APPROVED.tone).toBe('success');
  expect(REVIEW_VERDICT.CHANGES_REQUESTED.tone).toBe('warning');
  expect(REVIEW_VERDICT.COMMENTED.tone).toBe('muted');
  expect(REVIEW_VERDICT.DISMISSED.tone).toBe('muted');
});
