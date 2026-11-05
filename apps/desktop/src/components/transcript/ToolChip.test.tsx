import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { Wrench } from 'lucide-react';

import { ToolChip, ToolChipGroup } from './ToolChip';

// The chip root a label sits in, through the stable data-slot hook.
function chipOf(label: string): HTMLElement {
  const chip = screen
    .getByText(label)
    .closest<HTMLElement>('[data-slot="tool-chip"]');
  if (chip === null) throw new Error(`no chip shows ${label}`);
  return chip;
}

describe('ToolChip', () => {
  test('a finished call is the neutral chip: no tone, no shimmer', () => {
    render(<ToolChip icon={Wrench} label="list_runs" />);
    const chip = chipOf('list_runs');
    expect(chip.tagName).toBe('SPAN');
    expect(chip.dataset.state).toBe('done');
    expect(chip.hasAttribute('data-tone')).toBe(false);
    expect(chip.querySelector('[data-shimmer]')).toBeNull();
  });

  test('a running call is info-toned and shimmers its label', () => {
    render(<ToolChip icon={Wrench} label="Bash" state="running" />);
    const chip = chipOf('Bash');
    expect(chip.dataset.state).toBe('running');
    expect(chip.dataset.tone).toBe('info');
    expect(screen.getByText('Bash').hasAttribute('data-shimmer')).toBe(true);
  });

  // Colour is never the only cue: a failed call also says so, in words for a
  // screen reader and with a visible X mark.
  test('a failed call is danger-toned and says failed', () => {
    render(<ToolChip icon={Wrench} label="Edit" state="failed" />);
    const chip = chipOf('Edit');
    expect(chip.dataset.state).toBe('failed');
    expect(chip.dataset.tone).toBe('danger');
    expect(chip.querySelector('[data-shimmer]')).toBeNull();
    expect(chip.textContent).toContain('failed');
    expect(chip.querySelector('svg.lucide-x')).not.toBeNull();
  });

  // Q5: a tool id is machine-read, so `mono` sets its label (running or not)
  // in the global mono face; human labels keep the chip's sans.
  test('mono sets a tool id label in the mono face, running or done', () => {
    render(
      <>
        <ToolChip icon={Wrench} label="list_runs" mono />
        <ToolChip icon={Wrench} label="cancel_run" state="running" mono />
        <ToolChip icon={Wrench} label="Read 3 files" />
      </>
    );
    const done = chipOf('list_runs').querySelector('.mono');
    expect(done?.textContent).toBe('list_runs');
    const running = chipOf('cancel_run').querySelector('.mono');
    expect(running?.querySelector('[data-shimmer]')?.textContent).toBe(
      'cancel_run'
    );
    expect(chipOf('Read 3 files').querySelector('.mono')).toBeNull();
  });

  test('with onClick it is a button that calls it', () => {
    let clicks = 0;
    render(
      <ToolChip icon={Wrench} label="Read" onClick={() => (clicks += 1)} />
    );
    const chip = chipOf('Read');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.hasAttribute('aria-expanded')).toBe(false);
    fireEvent.click(chip);
    expect(clicks).toBe(1);
  });

  test('an expandable row is a button carrying aria-expanded and aria-controls', () => {
    const { rerender } = render(
      <ToolChip
        icon={Wrench}
        label="Grep"
        variant="row"
        expandable
        expanded={false}
        aria-controls="details-1"
        onClick={() => {}}
      />
    );
    const row = screen.getByRole('button', { name: /Grep/ });
    expect(row.dataset.variant).toBe('row');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.getAttribute('aria-controls')).toBe('details-1');
    rerender(
      <ToolChip
        icon={Wrench}
        label="Grep"
        variant="row"
        expandable
        expanded
        aria-controls="details-1"
        onClick={() => {}}
      />
    );
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(row.dataset.expanded).toBe('true');
  });

  test('meta shows beside the label', () => {
    render(<ToolChip icon={Wrench} label="Edit" meta="+24 −3" />);
    expect(chipOf('Edit').textContent).toContain('+24 −3');
  });
});

describe('ToolChipGroup', () => {
  test('appends the overflow count after the chips it is given', () => {
    const { container } = render(
      <ToolChipGroup overflowCount={3}>
        <ToolChip icon={Wrench} label="Bash" />
      </ToolChipGroup>
    );
    const overflow = container.querySelector(
      '[data-slot="tool-chip-overflow"]'
    );
    expect(overflow?.textContent).toContain('+3');
    expect(screen.getByText('3 more tool calls')).toBeDefined();
  });

  test('draws no count when nothing overflows', () => {
    const { container } = render(
      <ToolChipGroup overflowCount={0}>
        <ToolChip icon={Wrench} label="Bash" />
      </ToolChipGroup>
    );
    expect(
      container.querySelector('[data-slot="tool-chip-overflow"]')
    ).toBeNull();
  });
});
