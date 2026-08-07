import { describe, expect, it } from 'bun:test';

import { diffLinesFromRange } from './selectedDiffLines';

// A rendered diff row, shaped the way Pierre's `processLine` emits one: the row carries its own
// line number and type, and the code sits in a child element.
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

function rangeAcross(first: HTMLElement, last: HTMLElement): Range {
  const range = document.createRange();
  range.setStart(first.firstChild?.firstChild as Node, 0);
  range.setEnd(
    last.firstChild?.firstChild as Node,
    (last.textContent ?? '').length
  );
  return range;
}

describe('diffLinesFromRange', () => {
  it('reads one row’s line number off the row itself', () => {
    const only = row(12, 'change-addition', '  sku: string;');
    document.body.appendChild(only);

    expect(diffLinesFromRange(rangeAcross(only, only))).toEqual({
      startLine: 12,
      endLine: 12,
    });
  });

  it('spans the rows a multi-line drag crosses', () => {
    const first = row(12, 'change-addition', '  sku: string;');
    const last = row(14, 'context', '  score: number;');
    document.body.append(first, last);

    expect(diffLinesFromRange(rangeAcross(first, last))).toEqual({
      startLine: 12,
      endLine: 14,
    });
  });

  // A DOM range is always in document order, so a backwards drag arrives here start-first —
  // but the numbers on those rows need not ascend with document position (an expanded region
  // renumbers around it), so the range is ordered by line rather than by position.
  it('orders the range by line number, not document position', () => {
    const first = row(20, 'context', 'b');
    const second = row(9, 'context', 'a');
    document.body.append(first, second);

    expect(diffLinesFromRange(rangeAcross(first, second))).toEqual({
      startLine: 9,
      endLine: 20,
    });
  });

  // A deleted line's number belongs to the base file, so quoting it would name a line that is
  // not in the code under review at all.
  it('refuses a deletion row', () => {
    const deleted = row(4, 'change-deletion', 'const old = 1;');
    document.body.appendChild(deleted);

    expect(diffLinesFromRange(rangeAcross(deleted, deleted))).toBeNull();
  });

  it('refuses a range that never reaches a row', () => {
    const loose = document.createElement('div');
    loose.appendChild(document.createTextNode('not a diff row'));
    document.body.appendChild(loose);
    const range = document.createRange();
    range.selectNodeContents(loose);

    expect(diffLinesFromRange(range)).toBeNull();
  });

  // Pierre renders into shadow DOM on some surfaces. A row inside one is still a row.
  it('crosses a shadow boundary to find the row', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = row(31, 'change-addition', 'inside the shadow');
    shadow.appendChild(inner);

    expect(diffLinesFromRange(rangeAcross(inner, inner))).toEqual({
      startLine: 31,
      endLine: 31,
    });
  });
});
