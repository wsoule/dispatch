import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
  contrast,
  cssRule,
  hex,
  readCss,
  retiredNamesIn,
  sourceFiles,
  srcDir,
  THEMES,
} from './contrast-helpers';

// The task view and the edit family in the Gr8r look (owner decision
// 2026-10-23, design doc §12; docs/architecture.md §8.2): their sheets
// read only Gr8r token names, keep no mono caps or `outline: none`, draw
// their marks and field edges at 3:1 and their toned words at 4.5:1 on
// the surface, and show a refused value as Gr8r's red error field.

/** The detail lane's package files: task/** and edit/** (the picker
    popover is the lists lane's). */
const LANE_FILES = [
  ...sourceFiles(path.join(srcDir, 'task')),
  ...sourceFiles(path.join(srcDir, 'edit')),
].filter((file) => !file.includes('picker-popover'));

const SHEETS = LANE_FILES.filter((file) => file.endsWith('.css')).map((file) =>
  path.relative(srcDir, file)
);

describe('the task view and editors are migrated', () => {
  test('no task or edit file reads a retired token name', () => {
    expect(retiredNamesIn(LANE_FILES)).toEqual([]);
  });

  test('no sheet keeps the old look: mono caps, an outline removed, a hex', () => {
    for (const sheet of SHEETS) {
      const css = readCss(sheet);
      expect([sheet, css.includes('text-transform: uppercase')]).toEqual([
        sheet,
        false,
      ]);
      expect([sheet, /outline:\s*none/.test(css)]).toEqual([sheet, false]);
      expect([sheet, /#[0-9a-f]{3,8}\b/i.test(css)]).toEqual([sheet, false]);
    }
  });
});

describe('marks and words hold their contrast on the surface', () => {
  test('an open relation nobody holds: "Unassigned" in amber, 4.5:1 or better', () => {
    expect(
      cssRule('task/task-relation-list.module.css', '.unassigned')
    ).toContain('color: var(--amber);');
    for (const [theme, tokens] of THEMES) {
      const ratio = contrast(hex(tokens, '--amber'), hex(tokens, '--surface'));
      expect([theme, ratio >= 4.5]).toEqual([theme, true]);
    }
  });

  test("activity noise is a hollow grey ring at 3:1; toned marks take the tone's hue", () => {
    expect(
      cssRule('task/task-activity-list.module.css', '.muted .mark::before')
    ).toContain('border: 2px solid var(--gray);');
    expect(readCss('task/task-activity-list.module.css')).toContain(
      'background: var(--tone);'
    );
    for (const [theme, tokens] of THEMES) {
      for (const mark of ['--gray', '--text-3']) {
        const ratio = contrast(hex(tokens, mark), hex(tokens, '--surface'));
        expect([theme, mark, ratio >= 3]).toEqual([theme, mark, true]);
      }
    }
  });

  test('the comment box edge is the 3:1 control edge, with the accent ring on focus', () => {
    const box = cssRule(
      'edit/text-area-editor.module.css',
      ".root[data-text-editor='edit'], .root[data-text-editor='compose']"
    );
    expect(box).toContain('border: 1px solid var(--control-border);');
    const focus = cssRule(
      'edit/text-area-editor.module.css',
      '.root[data-text-editor]:focus-within'
    );
    expect(focus).toContain('border-color: var(--accent);');
    expect(focus).toContain('0 0 0 1px var(--accent)');
  });

  // A native date input (the milestone drawer's Due date) keeps the field
  // ring while Tab is on its calendar button, where only :focus-within
  // matches; an invalid one keeps its red edge with the ring outside.
  test('a primitive date input keeps its ring on the calendar button', () => {
    const sheet = readCss('styles/primitives.css').replace(/\s+/g, ' ');
    const scope = ':where(html:not([data-bt-ui-scoped]), [data-bt-ui])';
    const ring = new RegExp(
      `${escapeRe(scope)} \\.input\\[type='date'\\]:focus-within \\{([^}]*)\\}`
    ).exec(sheet);
    expect(ring?.[1]).toContain('border-color: var(--accent);');
    expect(ring?.[1]).toContain('0 0 0 1px var(--accent)');
    expect(ring?.[1]).toContain('outline: 2px solid transparent;');
    const invalid = new RegExp(
      `${escapeRe(scope)} \\.input\\[type='date'\\]\\[aria-invalid='true'\\]:focus-within \\{([^}]*)\\}`
    ).exec(sheet);
    expect(invalid?.[1]).toContain('border-color: var(--red);');
    expect(invalid?.[1]).toContain('outline: 2px solid var(--focus-ring);');
    expect(invalid?.[1]).toContain('outline-offset: 2px;');
  });

  test('fields keep a ring forced colours can paint (a transparent outline)', () => {
    expect(
      cssRule('edit/date-field.module.css', '.input:focus-within')
    ).toContain('outline: 2px solid transparent;');
    expect(
      cssRule('edit/inline-text-field.module.css', '.input:focus-visible')
    ).toContain('outline: 2px solid transparent;');
    expect(
      cssRule('edit/text-area-editor.module.css', '.input:focus-visible')
    ).toContain('outline: 2px solid transparent;');
  });

  // Focused, an invalid field keeps its red edge and takes the focus ring
  // 2px outside it: a red-soft halo alone changed the field by 1.16:1, so
  // focus hid in the error (WCAG 2.4.7; the ring is 3:1).
  test('a refused value is the red error field, with the focus ring outside it on focus', () => {
    for (const [file, selector, focus] of [
      [
        'edit/date-field.module.css',
        ".input[aria-invalid='true']",
        ".input[aria-invalid='true']:focus-within",
      ],
      [
        'edit/inline-text-field.module.css',
        ".input[aria-invalid='true']",
        ".input[aria-invalid='true']:focus-visible",
      ],
      [
        'edit/text-area-editor.module.css',
        ".root[data-invalid='true']",
        ".root[data-invalid='true']:focus-within",
      ],
    ] as const) {
      expect([file, cssRule(file, selector)]).toEqual([
        file,
        'border-color: var(--red); box-shadow: 0 0 0 1px var(--red);',
      ]);
      expect([file, cssRule(file, focus)]).toEqual([
        file,
        'border-color: var(--red); outline: 2px solid var(--focus-ring); outline-offset: 2px; box-shadow: 0 0 0 1px var(--red);',
      ]);
    }
  });
});

/** A string as a literal piece of a regular expression. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
