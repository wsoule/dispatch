import { render } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DiffEmptyState } from './DiffEmptyState';

test('keeps the empty-state hook around the library empty state and its words', () => {
  const { container } = render(
    <DiffEmptyState message="This work has landed, and its diff wasn't kept." />
  );
  const slot = container.querySelector('[data-slot="empty-state"]');
  expect(slot).not.toBeNull();
  expect(slot?.querySelector('.empty')?.textContent).toBe(
    "This work has landed, and its diff wasn't kept."
  );
});

// CSS modules resolve to {} under Bun, so read the rule itself: the wrapper
// fills the pane and centres the message both ways, as the legacy
// placeholder (h-full justify-center) did.
test('fills its pane and centres the message', () => {
  const sheet = readFileSync(
    join(import.meta.dir, 'DiffEmptyState.module.css'),
    'utf8'
  );
  const rule = /\.fill\s*\{([^}]*)\}/.exec(sheet)?.[1] ?? '';
  expect(rule).toContain('height: 100%');
  expect(rule).toContain('align-items: center');
  expect(rule).toContain('justify-content: center');
});
