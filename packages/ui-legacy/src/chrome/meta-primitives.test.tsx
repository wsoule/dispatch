import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { CollapseBar } from './collapse-bar';
import { CountChip } from './CountChip';
import { PathCrumb } from './path-crumb';
import { SectionLabel } from './SectionLabel';
import { StatPair } from './stat-pair';
import { HintText, MetaText } from './text';

test('a stat pair shows signed counts', () => {
  render(<StatPair added={591} removed={46} />);
  expect(screen.getByText('+591')).toBeDefined();
  expect(screen.getByText('−46')).toBeDefined();
});

test('a stat pair omits a zero side', () => {
  render(<StatPair added={12} removed={0} />);
  expect(screen.queryByText('−0')).toBeNull();
});

test('a stat pair with nothing to report renders nothing', () => {
  const { container } = render(<StatPair added={0} removed={0} />);
  expect(container.innerHTML).toBe('');
});

// Each primitive sets a default colour on the same element that receives
// `className`, so a colour passed in must survive to the DOM for twMerge to
// resolve the conflict in the caller's favour.
test('a colour passed through className reaches the element', () => {
  const cases = [
    <MetaText key="meta" className="text-foreground">
      12s
    </MetaText>,
    <CountChip key="chip" count={4} className="text-foreground" />,
    <SectionLabel key="label" className="text-foreground">
      Merge queue
    </SectionLabel>,
    <StatPair key="stat" added={1} removed={1} className="text-foreground" />,
    <PathCrumb key="crumb" path="a/b.ts" className="text-foreground" />,
    <CollapseBar
      key="bar"
      label="16 unmodified lines"
      collapsed
      onToggle={() => {}}
      className="text-foreground"
    />,
  ];
  for (const element of cases) {
    const { container } = render(element);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className.split(/\s+/)).toContain('text-foreground');
  }
});

// The last segment is the file; the leading directories are context and must
// not compete with it.
test('a path crumb emphasises the last segment', () => {
  render(<PathCrumb path="apps/docs/app/AgentUi.tsx" />);
  const leaf = screen.getByText('AgentUi.tsx');
  expect(leaf.className).toContain('text-foreground');
});

test('a collapse bar toggles', () => {
  let toggled = false;
  render(
    <CollapseBar
      label="16 unmodified lines"
      collapsed
      onToggle={() => {
        toggled = true;
      }}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: /16 unmodified lines/ }));
  expect(toggled).toBe(true);
});

// Ids, counts and times are 12px sans — mono is for code, paths and diffs only.
test('meta text, counts and section labels are sans, not mono', () => {
  const cases = [
    render(<MetaText>12s</MetaText>).container,
    render(<CountChip count={4} />).container,
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
