import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import { selectionWithin, useTextSelection } from './useTextSelection';

// A paragraph inside the scoped container and one outside it.
function setup() {
  const inside = document.createElement('p');
  inside.textContent = 'cache the search index';
  const outside = document.createElement('p');
  outside.textContent = 'somewhere else';
  document.body.append(inside, outside);
  return { inside, outside };
}

// Selects characters [start, end) of an element's one text node.
function select(element: HTMLElement, start: number, end: number) {
  const text = element.firstChild;
  if (text === null) throw new Error('no text node');
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

// Unmounts first, so clearing the selection updates no mounted hook.
afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

test('selectionWithin reads a selection inside the container only', () => {
  const { inside, outside } = setup();
  expect(selectionWithin(inside)).toBeNull();
  select(inside, 10, 16);
  expect(selectionWithin(inside)?.text).toBe('search');
  expect(selectionWithin(outside)).toBeNull();
  expect(selectionWithin(null)).toBeNull();
  // A bare caret is no selection.
  select(inside, 3, 3);
  expect(selectionWithin(inside)).toBeNull();
});

test('the hook follows selectionchange and drops a selection that leaves', () => {
  const { inside, outside } = setup();
  const ref = { current: inside };
  const { result } = renderHook(() => useTextSelection(ref));
  expect(result.current).toBeNull();

  act(() => select(inside, 0, 5));
  expect(result.current?.text).toBe('cache');

  act(() => select(outside, 0, 9));
  expect(result.current).toBeNull();
});
