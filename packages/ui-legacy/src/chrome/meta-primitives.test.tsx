import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { SectionLabel } from './SectionLabel';
import { HintText, MetaText } from './text';

// Each primitive sets a default colour on the same element that receives
// `className`, so a colour passed in must survive to the DOM for twMerge to
// resolve the conflict in the caller's favour.
test('a colour passed through className reaches the element', () => {
  const cases = [
    <MetaText key="meta" className="text-foreground">
      12s
    </MetaText>,
    <SectionLabel key="label" className="text-foreground">
      Merge queue
    </SectionLabel>,
  ];
  for (const element of cases) {
    const { container } = render(element);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className.split(/\s+/)).toContain('text-foreground');
  }
});

// Ids, counts and times are 12px sans — mono is for code, paths and diffs only.
test('meta text and section labels are sans, not mono', () => {
  const cases = [
    render(<MetaText>12s</MetaText>).container,
    render(<SectionLabel>Merge queue</SectionLabel>).container,
  ];
  for (const container of cases) {
    expect(container.innerHTML).not.toContain('font-mono');
    expect(container.innerHTML).toContain('text-[12px]');
  }
});

// Hint prose is a sentence: 11px muted, and neither the medium weight of a
// label nor the tabular digits of a column of meta.
test('hint text is 11px muted prose', () => {
  const { container } = render(
    <HintText>The agent that edits the repo.</HintText>
  );
  const span = container.querySelector('span');
  const classes = span?.className.split(/\s+/) ?? [];
  expect(classes).toContain('text-[11px]');
  expect(classes).toContain('text-muted-foreground');
  expect(classes).not.toContain('font-medium');
  expect(classes).not.toContain('tabular-nums');
  expect(screen.getByText('The agent that edits the repo.')).toBeDefined();
});
