import { describe, expect, it } from 'bun:test';

import type { LayoutNode } from './terminalSplits';
import {
  attachTerminal,
  closePane,
  findPane,
  listPanes,
  makePane,
  MAX_RATIO,
  MIN_RATIO,
  neighbourPane,
  setRatio,
  splitPane,
  terminalIsVisible,
} from './terminalSplits';

function paneIds(node: LayoutNode): string[] {
  return listPanes(node).map((pane) => pane.id);
}

describe('splitPane', () => {
  it('turns a lone pane into a split holding it and a new one', () => {
    const tree = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    expect(tree.kind).toBe('split');
    expect(paneIds(tree)).toEqual(['a', 'b']);
  });

  it('puts the new pane second, so a split reads in the direction it was made', () => {
    const tree = splitPane(makePane('a'), 'a', 'column', 'b', 's1');
    expect(paneIds(tree)).toEqual(['a', 'b']);
  });

  it('nests, so splitting inside a split composes', () => {
    // The case a flat column model cannot express: the right half of a
    // side-by-side split, itself stacked.
    let tree: LayoutNode = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    tree = splitPane(tree, 'b', 'column', 'c', 's2');
    expect(paneIds(tree)).toEqual(['a', 'b', 'c']);

    tree = splitPane(tree, 'c', 'row', 'd', 's3');
    expect(paneIds(tree)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves the tree alone when the pane is not there', () => {
    const tree = makePane('a');
    expect(splitPane(tree, 'missing', 'row', 'b', 's1')).toEqual(tree);
  });

  it('does not mutate the tree it was given', () => {
    const original = makePane('a');
    splitPane(original, 'a', 'row', 'b', 's1');
    expect(original).toEqual(makePane('a'));
  });
});

describe('closePane', () => {
  it('collapses the split that held the closed pane', () => {
    const tree = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    const after = closePane(tree, 'b');
    // The survivor takes the split's place rather than leaving a one-armed node.
    expect(after).toEqual(makePane('a'));
  });

  it('returns null when the last pane closes', () => {
    expect(closePane(makePane('a'), 'a')).toBeNull();
  });

  it('collapses only the split it needs to', () => {
    let tree: LayoutNode = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    tree = splitPane(tree, 'b', 'column', 'c', 's2');
    const after = closePane(tree, 'c');
    // `toBeNull` narrows, so the rest reads without a cast.
    expect(after).not.toBeNull();
    expect(paneIds(after)).toEqual(['a', 'b']);
    expect(after.kind).toBe('split');
  });

  it('is a no-op for an id that is not in the tree', () => {
    const tree = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    expect(closePane(tree, 'missing')).toEqual(tree);
  });
});

describe('attachTerminal', () => {
  it('points one pane at a session and leaves the others alone', () => {
    let tree: LayoutNode = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    tree = attachTerminal(tree, 'b', 'term-1');
    expect(findPane(tree, 'b')?.terminalId).toBe('term-1');
    expect(findPane(tree, 'a')?.terminalId).toBeNull();
  });

  it('detaches on null', () => {
    let tree: LayoutNode = attachTerminal(makePane('a'), 'a', 'term-1');
    tree = attachTerminal(tree, 'a', null);
    expect(findPane(tree, 'a')?.terminalId).toBeNull();
  });
});

describe('setRatio', () => {
  // The ratio only exists on a split node, so every assertion reads it through
  // a narrowing helper rather than asserting the node's shape inline.
  function ratioOf(node: LayoutNode): number | null {
    return node.kind === 'split' ? node.ratio : null;
  }

  it('moves a divider', () => {
    const tree = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    expect(ratioOf(setRatio(tree, 's1', 0.7))).toBe(0.7);
  });

  it('clamps so a pane cannot be dragged out of existence', () => {
    const tree = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    expect(ratioOf(setRatio(tree, 's1', 0))).toBe(0.1);
    expect(ratioOf(setRatio(tree, 's1', 5))).toBe(0.9);
  });

  it('clamps to the exported bounds the divider announces', () => {
    // The divider's aria-valuemin/max and its Home/End keys read these, so
    // they must be the same numbers setRatio clamps to.
    expect(MIN_RATIO).toBe(0.1);
    expect(MAX_RATIO).toBe(0.9);
    const tree = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    expect(ratioOf(setRatio(tree, 's1', -1))).toBe(MIN_RATIO);
    expect(ratioOf(setRatio(tree, 's1', 2))).toBe(MAX_RATIO);
    expect(ratioOf(setRatio(tree, 's1', MIN_RATIO))).toBe(MIN_RATIO);
    expect(ratioOf(setRatio(tree, 's1', MAX_RATIO))).toBe(MAX_RATIO);
  });
});

describe('neighbourPane', () => {
  it('prefers the pane before, so focus does not jump across the layout', () => {
    let tree: LayoutNode = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    tree = splitPane(tree, 'b', 'row', 'c', 's2');
    expect(neighbourPane(tree, 'c')).toBe('b');
  });

  it('falls back to the pane after when closing the first', () => {
    const tree = splitPane(makePane('a'), 'a', 'row', 'b', 's1');
    expect(neighbourPane(tree, 'a')).toBe('b');
  });

  it('is null when nothing else is left', () => {
    expect(neighbourPane(makePane('a'), 'a')).toBeNull();
  });
});

describe('terminalIsVisible', () => {
  it('reports whether any pane is showing a session', () => {
    const tree = attachTerminal(
      splitPane(makePane('a'), 'a', 'row', 'b', 's1'),
      'b',
      'term-1'
    );
    expect(terminalIsVisible(tree, 'term-1')).toBe(true);
    expect(terminalIsVisible(tree, 'term-2')).toBe(false);
  });
});
