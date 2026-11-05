import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { StyledSpan, TerminalScreen } from '../../lib/terminalScreen';
import { DEFAULT_STYLE } from '../../lib/terminalScreen';
import { TerminalCanvas } from './TerminalCanvas';
import styles from './TerminalCanvas.module.css';

// bun loads a CSS module as an empty map (every class undefined), so a rendered
// class proves nothing alone: these read the sheet's rules as well.
const SHEET = readFileSync(
  join(import.meta.dir, 'TerminalCanvas.module.css'),
  'utf8'
);

// The body of one rule in the sheet, by its exact selector.
function rule(selector: string): string {
  const start = SHEET.indexOf(`${selector} {`);
  if (start === -1) return '';
  return SHEET.slice(start, SHEET.indexOf('}', start));
}

// A screen stub: TerminalCanvas only reads toSpans().
function stubScreen(lines: StyledSpan[][]): TerminalScreen {
  return { toSpans: () => lines } as unknown as TerminalScreen;
}

function renderCanvas(lines: StyledSpan[][], search = '') {
  render(
    <TerminalCanvas
      screen={stubScreen(lines)}
      revision={1}
      search={search}
      follow={false}
    />
  );
  return screen.getByTestId('terminal-canvas');
}

test('an inverse cell with no colours flips the surface colours', () => {
  const canvas = renderCanvas([
    [{ text: 'selected', style: { ...DEFAULT_STYLE, inverse: true } }],
  ]);
  const span = canvas.querySelector('span');
  expect(span?.textContent).toBe('selected');
  expect(span?.style.color).toBe('var(--surface)');
  expect(span?.style.backgroundColor).toBe('var(--text)');
});

test('a plain cell sets no inline colour, inheriting the screen', () => {
  const canvas = renderCanvas([[{ text: 'plain', style: DEFAULT_STYLE }]]);
  const span = canvas.querySelector('span');
  expect(span?.style.color).toBe('');
  expect(span?.style.backgroundColor).toBe('');
  expect(canvas.className).toBe(styles.screen ?? '');
  expect(rule('.screen')).toContain('background: var(--surface)');
  expect(rule('.screen')).toContain('color: var(--text)');
});

test('a search wraps each match in a mark with the match class', () => {
  const canvas = renderCanvas(
    [[{ text: 'error: Error again', style: DEFAULT_STYLE }]],
    'error'
  );
  const marks = Array.from(canvas.querySelectorAll<HTMLElement>('mark'));
  expect(marks.map((mark) => mark.textContent)).toEqual(['error', 'Error']);
  for (const mark of marks) expect(mark.className).toBe(styles.match ?? '');
  expect(rule('.match')).toContain('background: var(--accent-soft)');
  // Not colour alone: an accent rule along the hit's foot.
  expect(rule('.match')).toContain('box-shadow: inset 0 -2px 0 var(--accent)');
  expect(SHEET).not.toContain('dark:');
});

test('an empty search renders no mark', () => {
  const canvas = renderCanvas([
    [{ text: 'error: Error again', style: DEFAULT_STYLE }],
  ]);
  expect(canvas.querySelector('mark')).toBeNull();
  expect(canvas.textContent).toBe('error: Error again');
});
