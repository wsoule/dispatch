import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// global.css carries the browser fixes the page still needs after Phase 7 removed Tailwind's
// preflight, because @dispatch/ui's reset (packages/ui/src/styles/tokens.css) does not set
// them: the tab width in code and tool output, no tap flash, and the native search, date and
// number field fixes for WebKit and Blink. These tests read the stylesheet's rules, so moving or
// dropping one of them fails here rather than in a transcript or a field on a phone.

const css = readFileSync(path.join(import.meta.dir, 'global.css'), 'utf8');

/** The declarations of every top-level rule whose selector list names `selector`, merged in
    source order (a later rule wins), with comments and whitespace runs removed. */
function declarations(selector: string): Record<string, string> {
  const merged: Record<string, string> = {};
  const rules = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, selectors = '', body = ''] of rules) {
    const names = selectors.split(',').map((name) => name.trim());
    if (!names.includes(selector)) continue;
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      merged[declaration.slice(0, colon).trim()] = declaration
        .slice(colon + 1)
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  return merged;
}

describe('global.css', () => {
  test('a tab is four columns on the whole page', () => {
    expect(declarations('html')['tab-size']).toBe('4');
  });

  test('a tap draws no grey highlight', () => {
    expect(declarations('html')['-webkit-tap-highlight-color']).toBe(
      'transparent'
    );
  });

  test('a search field drops WebKit’s inner decoration', () => {
    expect(declarations('::-webkit-search-decoration')).toEqual({
      '-webkit-appearance': 'none',
    });
  });

  test('a date field keeps its line height and alignment, with no inner padding', () => {
    expect(declarations('::-webkit-date-and-time-value')).toEqual({
      'min-height': '1lh',
      'text-align': 'inherit',
    });
    expect(declarations('::-webkit-datetime-edit')).toEqual({
      display: 'inline-flex',
      'padding-block': '0',
    });
    expect(declarations('::-webkit-datetime-edit-fields-wrapper')).toEqual({
      padding: '0',
    });
    for (const field of [
      'year',
      'month',
      'day',
      'hour',
      'minute',
      'second',
      'millisecond',
      'meridiem',
    ])
      expect(
        declarations(`::-webkit-datetime-edit-${field}-field`)['padding-block']
      ).toBe('0');
    expect(declarations('::-webkit-calendar-picker-indicator')).toEqual({
      'line-height': '1',
    });
  });

  test('a number field’s spin buttons fit its height', () => {
    expect(declarations('::-webkit-inner-spin-button')).toEqual({
      height: 'auto',
    });
    expect(declarations('::-webkit-outer-spin-button')).toEqual({
      height: 'auto',
    });
  });
});
