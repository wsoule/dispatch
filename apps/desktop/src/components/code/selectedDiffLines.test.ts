import { describe, expect, it } from 'bun:test';

import { diffLinesFromRange } from './selectedDiffLines';

// A rendered diff row, shaped the way Pierre's `processLine` emits one: the row carries the line
// number it drew and its type, and the code sits in a child element.
function row(line: number, type: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-line', String(line));
  el.setAttribute('data-line-type', type);
  el.setAttribute('data-line-index', String(line - 1));
  const code = document.createElement('span');
  code.appendChild(document.createTextNode(text));
  el.appendChild(code);
  return el;
}

// A column of a split diff. Pierre renders two of these — `[data-code][data-deletions]` and
// `[data-code][data-additions]` — side by side (see `DiffHunksRenderer.renderFullAST`); unified
// renders one, marked `data-unified`.
function column(side: 'deletions' | 'additions' | 'unified'): HTMLElement {
  const el = document.createElement('code');
  el.setAttribute('data-code', '');
  el.setAttribute(`data-${side}`, '');
  return el;
}

function textIn(el: Element): Node {
  const node = el.firstChild?.firstChild;
  if (node == null) throw new Error('row has no text');
  return node;
}

function rangeAcross(first: Element, last: Element): Range {
  const range = document.createRange();
  range.setStart(textIn(first), 0);
  range.setEnd(textIn(last), (last.textContent ?? '').length);
  return range;
}

function mount(...nodes: Node[]): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  host.append(...nodes);
}

describe('diffLinesFromRange — one column', () => {
  it('reads one row’s line number off the row itself', () => {
    const only = row(12, 'change-addition', '  sku: string;');
    mount(only);

    expect(diffLinesFromRange(rangeAcross(only, only))).toEqual({
      startLine: 12,
      endLine: 12,
    });
  });

  it('spans the rows a multi-line drag crosses', () => {
    const first = row(12, 'change-addition', '  sku: string;');
    const middle = row(13, 'context', '  id: string;');
    const last = row(14, 'context', '  score: number;');
    mount(first, middle, last);

    expect(diffLinesFromRange(rangeAcross(first, last))).toEqual({
      startLine: 12,
      endLine: 14,
    });
  });

  // A drag released in the gap past a row ends at offset 0 of the next one; that row is not part
  // of what was highlighted.
  it('leaves out a row the range only touches at its edge', () => {
    const first = row(1, 'change-addition', 'a');
    const second = row(2, 'change-addition', 'b');
    const third = row(3, 'change-addition', 'c');
    mount(first, second, third);
    const range = document.createRange();
    range.setStart(textIn(first), 0);
    range.setEnd(third, 0);

    expect(diffLinesFromRange(range)).toEqual({ startLine: 1, endLine: 2 });
  });

  it('refuses a range that never reaches a row', () => {
    const loose = document.createElement('div');
    loose.appendChild(document.createTextNode('not a diff row'));
    mount(loose);
    const range = document.createRange();
    range.selectNodeContents(loose);

    expect(diffLinesFromRange(range)).toBeNull();
  });

  // Pierre renders into shadow DOM on some surfaces. A row inside one is still a row.
  it('finds a row inside a shadow root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const inner = row(31, 'change-addition', 'inside the shadow');
    host.attachShadow({ mode: 'open' }).appendChild(inner);

    expect(diffLinesFromRange(rangeAcross(inner, inner))).toEqual({
      startLine: 31,
      endLine: 31,
    });
  });
});

// Split is the default layout (`DEFAULT_DIFF_DISPLAY_SETTINGS.layout`), and its two columns are
// separate DOM subtrees, so a drag down one column can begin or end in the other.
describe('diffLinesFromRange — split view', () => {
  function splitDiff(): {
    deletions: HTMLElement;
    additions: HTMLElement;
    pre: HTMLElement;
  } {
    const pre = document.createElement('pre');
    const deletions = column('deletions');
    const additions = column('additions');
    pre.append(deletions, additions);
    mount(pre);
    return { deletions, additions, pre };
  }

  it('names the additions column’s own lines', () => {
    const { deletions, additions } = splitDiff();
    deletions.append(row(1, 'context', 'a'), row(2, 'change-deletion', 'old'));
    const first = row(1, 'context', 'a');
    const last = row(2, 'change-addition', 'new');
    additions.append(first, last);

    expect(diffLinesFromRange(rangeAcross(first, last))).toEqual({
      startLine: 1,
      endLine: 2,
    });
  });

  // The failure a human actually saw: a drag down the additions column that also crosses the
  // deleted column. Refusing the whole selection because it touched a deleted line would
  // suppress the bar for essentially every multi-line selection in the default layout.
  it('ignores the deleted column a drag clips on its way down', () => {
    const { deletions, additions } = splitDiff();
    const deletedFirst = row(4, 'change-deletion', 'old one');
    deletions.append(deletedFirst, row(5, 'change-deletion', 'old two'));
    const addedLast = row(9, 'change-addition', 'new nine');
    additions.append(row(7, 'change-addition', 'new seven'), addedLast);

    // Starts in the deleted column and ends in the additions column, which is what a wide drag
    // across a split diff produces.
    expect(diffLinesFromRange(rangeAcross(deletedFirst, addedLast))).toEqual({
      startLine: 7,
      endLine: 9,
    });
  });

  // A context line exists in both columns with a *different* number in each. Counting the
  // deleted column's copy would name lines from the base file.
  it('takes a context line’s number from the additions column, not the deleted one', () => {
    const { deletions, additions } = splitDiff();
    const deletedContext = row(5, 'context', 'shared line');
    deletions.appendChild(deletedContext);
    const addedContext = row(7, 'context', 'shared line');
    additions.appendChild(addedContext);

    expect(
      diffLinesFromRange(rangeAcross(deletedContext, addedContext))
    ).toEqual({ startLine: 7, endLine: 7 });
  });

  it('refuses a selection made entirely in the deleted column', () => {
    const { deletions } = splitDiff();
    const first = row(4, 'change-deletion', 'old one');
    const last = row(5, 'change-deletion', 'old two');
    deletions.append(first, last);

    expect(diffLinesFromRange(rangeAcross(first, last))).toBeNull();
  });
});
