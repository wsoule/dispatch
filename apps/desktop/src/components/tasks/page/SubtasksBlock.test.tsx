import { DEFAULT_STATUS_MODEL } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ShellActionsProvider } from '../../shell/ShellActionsContext';
import { SHELL, task } from './pageHost.test-helper';
import { SubtasksBlock } from './SubtasksBlock';

const PARENT = task('e-1', { kind: 'milestone', title: 'Cart v2' });
const CHILDREN = [
  task('t-1', {
    parent: 'e-1',
    title:
      'Move the cart totals into a single reducer so the coupon, tax and shipping lines agree',
    labels: ['ui', 'cart'],
  }),
  task('t-2', { parent: 'e-1', status: 'landed' }),
];
const NO_RUNS = new Map<string, RunMeta>();

function renderBlock(section: boolean) {
  return render(
    <ShellActionsProvider value={SHELL}>
      <SubtasksBlock
        title="Sub-issues"
        parent={PARENT}
        tasks={CHILDREN}
        model={DEFAULT_STATUS_MODEL}
        latestRunByTaskId={NO_RUNS}
        createPreset={{ milestone: 'e-1' }}
        section={section}
        lead={section ? <p>The mini plan</p> : undefined}
      />
    </ShellActionsProvider>
  );
}

// A module's rules, comments dropped (bun gives CSS modules no class names here).
const css = readFileSync(
  join(import.meta.dir, 'pageBlocks.module.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect([selector, at >= 0]).toEqual([selector, true]);
  return css.slice(at, css.indexOf('}', at));
}

// Inside a host that heads it (the drawer's "Work"), the block's header is a plain row: the
// fold button and the +, and no heading of its own.
test('in a headed host the header is a fold button row, not a heading', () => {
  renderBlock(false);
  expect(screen.queryByRole('heading')).toBeNull();
  const fold = screen.getByRole('button', { name: 'Sub-issues 1 of 2 done' });
  expect(fold.getAttribute('aria-expanded')).toBe('true');
  expect(
    screen.getByRole('button', { name: 'Add sub-task to Cart v2' })
  ).toBeDefined();
  // The label chips show where there is room for them.
  expect(document.querySelectorAll('[data-slot="label-pill"]')).toHaveLength(2);
});

// The task page rail: one heading carries the title and the done/total progress, the fold
// button inside it, so "Sub-issues" is never said twice; the lead folds with the rows.
test('as a section, its one heading holds the fold button and the progress', () => {
  renderBlock(true);
  const section = screen.getByRole('region', { name: /^Sub-issues/ });
  const headings = within(section).getAllByRole('heading');
  expect(headings).toHaveLength(1);
  const [heading] = headings;
  if (heading === undefined) throw new Error('no heading');
  const fold = within(heading).getByRole('button', {
    name: 'Sub-issues 1 of 2 done',
  });
  expect(fold.textContent).toContain('1/2');
  expect(within(section).getAllByText('Sub-issues')).toHaveLength(1);
  expect(
    within(section).getByRole('button', { name: 'Add sub-task to Cart v2' })
  ).toBeDefined();
  expect(within(section).getByText('The mini plan')).toBeDefined();
  fireEvent.click(fold);
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(within(section).queryByText('The mini plan')).toBeNull();
  expect(within(section).queryByText('Title of t-2')).toBeNull();
  fireEvent.click(fold);
  expect(within(section).getByText('Title of t-2')).toBeDefined();
});

// In the ~300px rail a long title used to push the crumb (status glyph and id) into the
// ellipsis. The title now has its own span that truncates; the crumb after it keeps its width.
test('a row keeps its status glyph and id whole, and only the title truncates', () => {
  renderBlock(true);
  for (const child of CHILDREN) {
    const title = screen.getByText(child.meta.title);
    const key = title.nextElementSibling;
    expect(key?.getAttribute('data-slot')).toBe('subtask-key');
    expect(key?.textContent).toContain(child.meta.id);
    // The status glyph says the status in words for assistive tech.
    expect(key?.querySelector('[role="img"]')).not.toBeNull();
    expect(title.closest('[data-slot="list-item-title"]')).not.toBeNull();
    // A truncated title still reads whole on hover.
    expect(title.getAttribute('title')).toBe(child.meta.title);
  }
  const titleRule = rule('.subtaskTitle');
  for (const declaration of [
    'min-width: 0;',
    'overflow: hidden;',
    'text-overflow: ellipsis;',
    'white-space: nowrap;',
  ]) {
    expect(titleRule).toContain(declaration);
  }
  expect(rule('.subtaskKey')).toContain('flex: none;');
  expect(rule('.subtaskLine')).toContain('display: flex;');
  // The trailing slot never shrinks, so a narrow host drops the label chips instead.
  expect(rule('.subtaskRows')).toContain(
    'container: subtask-rows / inline-size;'
  );
  expect(css).toMatch(
    /@container subtask-rows \(width < 360px\) \{\s*\.subtaskLabels \{\s*display: none;/
  );
});

// `subtasks-block` names the whole block in the rail too: the heading with its count and
// the rows, and it stays (with the count) while the rows are folded away.
test('as a section, the block hook holds the header and stays while folded', () => {
  renderBlock(true);
  const block = document.querySelector<HTMLElement>(
    '[data-slot="subtasks-block"]'
  );
  if (block === null) throw new Error('no subtasks-block');
  expect(within(block).getByRole('heading').textContent).toContain('1/2');
  expect(block.querySelector('[data-slot="subtasks-rows"]')).not.toBeNull();
  fireEvent.click(
    within(block).getByRole('button', { name: 'Sub-issues 1 of 2 done' })
  );
  expect(
    document.querySelector('[data-slot="subtasks-block"]')?.textContent
  ).toContain('1/2');
  expect(block.querySelector('[data-slot="subtasks-rows"]')).toBeNull();
});

// Where the rail is too narrow for the chips, the row keeps a trace of them: a tag and
// their count, every name in its title and in words for assistive tech.
test('a row with labels keeps their count and names for when the chips drop', () => {
  renderBlock(true);
  const counts = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="subtask-label-count"]')
  );
  // Only the row that has labels.
  expect(counts).toHaveLength(1);
  const [count] = counts;
  if (count === undefined) throw new Error('no label count');
  expect(count.title).toBe('ui, cart');
  expect(count.textContent).toContain('2');
  expect(within(count).getByText('Labels: ui, cart')).toBeDefined();
  // Hidden while the chips show; shown in their place below 360px.
  expect(rule('.subtaskLabelCount')).toContain('display: none;');
  expect(css).toMatch(
    /@container subtask-rows \(width < 360px\) \{[^@]*\.subtaskLabelCount \{\s*display: inline-flex;/
  );
});
