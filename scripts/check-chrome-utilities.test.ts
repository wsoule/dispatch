import { expect, test } from 'bun:test';

import { findViolations } from './check-chrome-utilities';

test('flags a banned chrome utility in a view', () => {
  const found = findViolations([
    {
      path: 'src/views/RunsView.tsx',
      text: '<div className="rounded-md border p-2">',
    },
  ]);
  expect(found).toHaveLength(1);
  expect(found[0]?.utility).toBe('rounded-md');
});

test('allows banned utilities inside the chrome layer itself', () => {
  const found = findViolations([
    {
      path: 'src/ui/chrome/panel.tsx',
      text: '<div className="rounded-lg border">',
    },
  ]);
  expect(found).toEqual([]);
});

test('ignores an unrelated class that merely contains the name', () => {
  const found = findViolations([
    {
      path: 'src/views/RunsView.tsx',
      text: '<div className="not-rounded-md-thing">',
    },
  ]);
  expect(found).toEqual([]);
});

// The real CLI globs from the repo root, so exempt paths look like
// `apps/desktop/src/ui/chrome/panel.tsx`, not the short `src/ui/...` form used
// in the test above. The exemption must still match that full, globbed shape.
test('allows banned utilities under the full globbed src/ui path', () => {
  const found = findViolations([
    {
      path: 'apps/desktop/src/ui/chrome/panel.tsx',
      text: '<div className="bg-card border-border rounded-lg border">',
    },
  ]);
  expect(found).toEqual([]);
});

// Non-chrome shadcn primitives also live directly under src/ui/ (card.tsx,
// button.tsx, etc.) and legitimately use these utilities too.
test('allows banned utilities under src/ui/ outside the chrome subfolder', () => {
  const found = findViolations([
    {
      path: 'apps/desktop/src/ui/card.tsx',
      text: '<div className="rounded-lg bg-card">',
    },
  ]);
  expect(found).toEqual([]);
});

test('does not let a longer banned utility mask a shorter one at a hyphen boundary', () => {
  const found = findViolations([
    {
      path: 'src/views/RunsView.tsx',
      text: '<div className="shadow-hairline-strong">',
    },
  ]);
  expect(found).toHaveLength(1);
  expect(found[0]?.utility).toBe('shadow-hairline-strong');
});

test('flags multiple distinct banned utilities in the same file', () => {
  const found = findViolations([
    {
      path: 'src/components/Widget.tsx',
      text: '<div className="bg-card text-muted-foreground rounded-xl">',
    },
  ]);
  expect(found.map((violation) => violation.utility).sort()).toEqual([
    'bg-card',
    'rounded-xl',
    'text-muted-foreground',
  ]);
});
