import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { LayoutNode } from '../../lib/terminalSplits';
import {
  makePane,
  MAX_RATIO,
  MIN_RATIO,
  splitPane,
} from '../../lib/terminalSplits';
import { TerminalSplitView } from './TerminalSplitView';

// A side-by-side split of two empty panes, rendered with no client and no
// socket, recording every resize the divider reports.
function renderSplit(
  node: LayoutNode = splitPane(makePane('a'), 'a', 'row', 'b', 's1')
) {
  const resizes: Array<[string, number]> = [];
  const noop = () => {};
  render(
    <TerminalSplitView
      node={node}
      client={null}
      terminals={[]}
      focusedPaneId={null}
      subscribe={null}
      onFocusPane={noop}
      onAttach={noop}
      onOpenSession={noop}
      onSplit={noop}
      onClosePane={noop}
      onRemoveSession={noop}
      onResize={(splitId, ratio) => resizes.push([splitId, ratio])}
    />
  );
  return {
    resizes,
    divider: screen.getByRole('separator', { name: 'Resize panes' }),
  };
}

test('the divider is a focusable separator announcing its ratio and bounds', () => {
  const { divider } = renderSplit();
  expect(divider.getAttribute('tabindex')).toBe('0');
  expect(divider.getAttribute('aria-orientation')).toBe('vertical');
  expect(divider.getAttribute('aria-valuenow')).toBe('50');
  expect(divider.getAttribute('aria-valuemin')).toBe(String(MIN_RATIO * 100));
  expect(divider.getAttribute('aria-valuemax')).toBe(String(MAX_RATIO * 100));
  expect(screen.getByTestId('terminal-pane-a')).toBeTruthy();
  expect(screen.getByTestId('terminal-pane-b')).toBeTruthy();
});

test('a stacked split has a horizontal divider', () => {
  const { divider } = renderSplit(
    splitPane(makePane('a'), 'a', 'column', 'b', 's1')
  );
  expect(divider.getAttribute('aria-orientation')).toBe('horizontal');
});

test('arrow keys step the ratio by 0.05 and are kept from the page', () => {
  const { divider, resizes } = renderSplit();
  // fireEvent returns false when the handler called preventDefault.
  expect(fireEvent.keyDown(divider, { key: 'ArrowRight' })).toBe(false);
  expect(fireEvent.keyDown(divider, { key: 'ArrowLeft' })).toBe(false);
  expect(fireEvent.keyDown(divider, { key: 'ArrowDown' })).toBe(false);
  expect(fireEvent.keyDown(divider, { key: 'ArrowUp' })).toBe(false);
  expect(resizes).toEqual([
    ['s1', 0.55],
    ['s1', 0.45],
    ['s1', 0.55],
    ['s1', 0.45],
  ]);
});

test('Home and End jump to the bounds', () => {
  const { divider, resizes } = renderSplit();
  expect(fireEvent.keyDown(divider, { key: 'Home' })).toBe(false);
  expect(fireEvent.keyDown(divider, { key: 'End' })).toBe(false);
  expect(resizes).toEqual([
    ['s1', MIN_RATIO],
    ['s1', MAX_RATIO],
  ]);
});

test('other keys pass through untouched', () => {
  const { divider, resizes } = renderSplit();
  expect(fireEvent.keyDown(divider, { key: 'a' })).toBe(true);
  expect(fireEvent.keyDown(divider, { key: 'Enter' })).toBe(true);
  expect(resizes).toEqual([]);
});

test('a step never asks past the bounds', () => {
  const near = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
  const atMax: LayoutNode =
    near.kind === 'split' ? { ...near, ratio: MAX_RATIO } : near;
  const { divider, resizes } = renderSplit(atMax);
  expect(divider.getAttribute('aria-valuenow')).toBe('90');
  fireEvent.keyDown(divider, { key: 'ArrowRight' });
  expect(resizes).toEqual([['s1', MAX_RATIO]]);
});
