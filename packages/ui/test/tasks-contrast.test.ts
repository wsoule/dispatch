import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
  contrast,
  cssRule,
  hex,
  over,
  readCss,
  retiredNamesIn,
  srcDir,
  THEMES,
  tintShare,
} from './contrast-helpers';

// The lists' surfaces in the Gr8r look (owner decision 2026-10-23, design
// doc §12; docs/architecture.md §8.2), read from the stylesheets so a
// change there is checked: the inverted bulk bar (a --text fill, --text-inv
// ink, ghost actions at a reduced opacity), the picker's bar trigger on
// it, the selected row's --accent-soft tint with its 2px accent bar, the
// filter chips' accent tint and the warning tint of a value not found,
// the drop target's faint accent wash in its accent edge, the status
// words a row or a deadline group prints, and the control edges (3:1).

/** The opacity a rule sets, read from the stylesheet. */
function ruleOpacity(file: string, selector: string): number {
  const match = /opacity: ([\d.]+);/.exec(cssRule(file, selector));
  expect({ file, selector, found: match !== null }).toEqual({
    file,
    selector,
    found: true,
  });
  return Number(match?.[1] ?? 0);
}

/** The "N%" of `color-mix(in srgb, var(<name>) N%, …)` inside a rule. */
function mixShare(body: string, name: string): number {
  const match = new RegExp(
    `color-mix\\(in srgb, var\\(${name}\\) (\\d+)%`
  ).exec(body);
  expect({ name, found: match !== null }).toEqual({ name, found: true });
  return Number(match?.[1] ?? 0) / 100;
}

describe('the bulk bar reads on its inverted fill', () => {
  const bar = cssRule('tasks/bulk-bar.module.css', '.bar');
  const ghost = ruleOpacity('tasks/bulk-bar.module.css', '.ghost, .close');
  const trigger = ruleOpacity('edit/picker-popover.module.css', '.bar');
  const pending = ruleOpacity(
    'edit/picker-popover.module.css',
    '.bar + [data-edit-pending]'
  );
  const hover = cssRule(
    'tasks/bulk-bar.module.css',
    '@media (hover: hover) and (width >= 901px) { .primary:hover'
  );

  test('the bar is the --text fill with --text-inv ink, floating', () => {
    expect(bar).toContain('background: var(--text);');
    expect(bar).toContain('color: var(--text-inv);');
    expect(bar).toContain('box-shadow: var(--shadow-pop);');
    expect(hover).toContain('background: var(--accent-hover);');
  });

  for (const [theme, t] of THEMES) {
    test(`${theme}: the count, actions, note and confirmation at 4.5:1`, () => {
      const fill = hex(t, '--text');
      const ink = hex(t, '--text-inv');
      const wash = over(ink, fill, 0.14);
      const failing: string[] = [];
      for (const [name, share] of [
        ['count, note and message', 1],
        ['ghost and close actions', ghost],
        ['picker bar trigger', trigger],
        ['pending note beside a trigger', pending],
      ] as const) {
        const ratio = contrast(over(ink, fill, share), fill);
        if (ratio < 4.5) failing.push(`${name} at ${share}: ${ratio}`);
      }
      // Hovered or open: full ink on the light wash.
      const washed = contrast(ink, wash);
      if (washed < 4.5) failing.push(`on the hover wash: ${washed}`);
      // The confirmation's primary: the accent fill.
      const primary = contrast(hex(t, '--on-accent'), hex(t, '--accent'));
      if (primary < 4.5) failing.push(`primary: ${primary}`);
      // The focus ring on the fill (an accent outline).
      const ring = contrast(hex(t, '--accent'), fill);
      if (ring < 3) failing.push(`focus ring on the fill: ${ring}`);
      expect(failing).toEqual([]);
    });
  }
});

describe('selected rows, filter chips and drop targets', () => {
  const table = 'tasks/task-group-table.module.css';
  const selected = cssRule(
    table,
    ".row[aria-current='true'], .row[data-selected='true']"
  );
  const bar = cssRule(
    table,
    ".row[data-selected='true']::before, .row[aria-current='true']::before"
  );
  const drop = cssRule(table, ".group[data-drop='ok']");
  const dropEdge = cssRule(table, ".group[data-drop='ok']::after");
  const chip = cssRule('tasks/filter-chips.module.css', '.chip');
  const unknown = cssRule(
    'tasks/filter-chips.module.css',
    ".chip[data-unknown='true']"
  );

  test('the tints, the bar and the edge come from the accent tokens', () => {
    expect(selected).toContain('background: var(--accent-soft);');
    expect(bar).toContain('border-left: 2px solid var(--accent);');
    expect(drop).toContain(
      'background: color-mix(in srgb, var(--accent) 6%, var(--sunken));'
    );
    expect(dropEdge).toContain('border: 1px solid var(--accent);');
    expect(chip).toContain('background: var(--accent-soft);');
    expect(chip).toContain('border: 1px solid var(--accent-line);');
    expect(unknown).toContain('background: var(--amber-soft);');
  });

  for (const [theme, t] of THEMES) {
    test(`${theme}: text on the tints, and the bar and edge at 3:1`, () => {
      const surface = hex(t, '--surface');
      const accent = hex(t, '--accent');
      const tint = over(accent, surface, tintShare(t, '--accent-soft'));
      const wash = over(accent, hex(t, '--sunken'), mixShare(drop, '--accent'));
      const failing: string[] = [];
      for (const text of ['--text', '--text-2', '--text-3']) {
        for (const [ground, color] of [
          ['--accent-soft', tint],
          ['drop wash', wash],
        ] as const) {
          const ratio = contrast(hex(t, text), color);
          if (ratio < 4.5) failing.push(`${text} on ${ground}: ${ratio}`);
        }
      }
      // The status words a selected or open row may print (due date,
      // note, "Unassigned", "Missing: …") on its tint.
      for (const hue of ['--red', '--amber', '--green', '--blue']) {
        const ratio = contrast(hex(t, hue), tint);
        if (ratio < 4.5) failing.push(`${hue} on --accent-soft: ${ratio}`);
      }
      for (const [name, ground] of [
        ['selected bar on the tint', tint],
        ['drop edge on the wash', wash],
      ] as const) {
        const ratio = contrast(accent, ground);
        if (ratio < 3) failing.push(`${name}: ${ratio}`);
      }
      // A filter value not found: the amber text (and the chip's words) on
      // the warning tint.
      const amberTint = over(
        hex(t, '--amber'),
        surface,
        tintShare(t, '--amber-soft')
      );
      for (const text of ['--amber', '--text', '--text-2']) {
        const ratio = contrast(hex(t, text), amberTint);
        if (ratio < 4.5) failing.push(`${text} on --amber-soft: ${ratio}`);
      }
      expect(failing).toEqual([]);
    });
  }
});

describe('status words in the lists read on their real grounds', () => {
  // A row's due date, note and "Unassigned", the group's "Missing" line
  // and a deadline group's label: the hue itself (text-safe), on the
  // panel, a hovered or in-flight row (--surface-2) and a section band or
  // drop wash under it (--sunken).
  for (const [theme, t] of THEMES) {
    test(`${theme}: each hue and the quiet steps at 4.5:1`, () => {
      const failing: string[] = [];
      for (const ground of ['--surface', '--surface-2', '--sunken']) {
        for (const text of [
          '--red',
          '--amber',
          '--green',
          '--blue',
          '--text-2',
          '--text-3',
        ]) {
          const ratio = contrast(hex(t, text), hex(t, ground));
          if (ratio < 4.5) failing.push(`${text} on ${ground}: ${ratio}`);
        }
      }
      expect(failing).toEqual([]);
    });
  }

  test('the stylesheets colour them through the hue or the tone hook', () => {
    const table = 'tasks/task-group-table.module.css';
    expect(cssRule(table, '.missing')).toContain('color: var(--amber);');
    expect(cssRule(table, '.urgentText')).toBe('color: var(--red);');
    expect(cssRule(table, '.toneText')).toBe('color: var(--tone-ink);');
    expect(cssRule('tasks/deadline-list.module.css', '.toned')).toBe(
      'color: var(--tone-ink);'
    );
    expect(
      cssRule('tasks/filter-chips.module.css', ".summary[data-unknown='true']")
    ).toBe('color: var(--amber);');
  });
});

describe('the list controls keep 3:1 edges', () => {
  test('fields, boxes and the off switch use --control-border', () => {
    expect(cssRule('tasks/view-toolbar.module.css', '.input')).toContain(
      'border: 1px solid var(--control-border);'
    );
    expect(cssRule('tasks/checkbox.module.css', '.glyph')).toContain(
      'border: 1.5px solid var(--control-border);'
    );
    expect(cssRule('tasks/switch.module.css', '.glyph')).toContain(
      'background: var(--control-border);'
    );
    expect(cssRule('edit/picker-popover.module.css', '.check')).toContain(
      'border: 1.5px solid var(--control-border);'
    );
    // The selected segment is ringed in the accent, not left to the soft
    // white-on-grey step.
    expect(
      cssRule(
        'tasks/segmented-control.module.css',
        ".option[aria-checked='true']"
      )
    ).toContain('inset 0 0 0 1.5px var(--accent)');
  });

  // Tab always enters a segmented control on its checked option and the
  // arrows move focus and selection together, so the focus ring must not
  // sit where the selected thumb's inset accent ring is: it stands 2px
  // outside the option, over the track and the surface (WCAG 2.4.7).
  test('a segmented option shows focus apart from its selection', () => {
    const file = 'tasks/segmented-control.module.css';
    const selected = cssRule(file, ".option[aria-checked='true']");
    const focus = cssRule(file, '.option:focus-visible');
    expect(selected).toContain('inset 0 0 0 1.5px var(--accent)');
    expect(focus).toContain('outline-offset: 2px;');
    expect(focus).not.toContain('inset');
    expect(focus).not.toMatch(/outline-offset: -/);
    expect(focus).toContain('z-index: 1;');
  });

  // A stacked (phone) row puts its 20px "Open in Linear" icon on the
  // title's line and its 20px pickers on the line under it; 6px between
  // the lines keeps their 24px target circles apart (WCAG 2.5.8).
  test('a stacked row keeps 6px between its title line and its pickers', () => {
    const sheet = readCss('tasks/task-group-table.module.css').replace(
      /\s+/g,
      ' '
    );
    const stacked = sheet.slice(
      sheet.indexOf('@container task-table (width < 720px)')
    );
    const row = / \.row \{([^}]*)\}/.exec(stacked);
    expect(row?.[1]).toContain('gap: 6px 14px;');
  });

  for (const [theme, t] of THEMES) {
    test(`${theme}: the segmented focus ring reads on the track and the surface`, () => {
      const ring = hex(t, '--focus-ring');
      const failing: string[] = [];
      for (const ground of ['--surface-3', '--surface', '--bg', '--sunken']) {
        const ratio = contrast(ring, hex(t, ground));
        if (ratio < 3) failing.push(`ring on ${ground}: ${ratio}`);
      }
      expect(failing).toEqual([]);
    });
  }

  test('a field takes the fields’ ring, never outline: none', () => {
    const focus = cssRule(
      'tasks/view-toolbar.module.css',
      '.input:focus-visible'
    );
    expect(focus).toContain('outline: 2px solid transparent;');
    expect(focus).toContain('0 0 0 1px var(--accent)');
    for (const file of LANE_FILES) {
      expect({
        file,
        none: /outline:\s*(none|0)\s*;/.test(readCss(file)),
      }).toEqual({ file, none: false });
    }
  });

  for (const [theme, t] of THEMES) {
    test(`${theme}: the edges on every surface they sit on`, () => {
      const failing: string[] = [];
      for (const ground of ['--surface', '--surface-2', '--sunken']) {
        const ratio = contrast(hex(t, '--control-border'), hex(t, ground));
        if (ratio < 3) failing.push(`--control-border on ${ground}: ${ratio}`);
      }
      // The segmented thumb's accent ring against the track.
      const ring = contrast(hex(t, '--accent'), hex(t, '--surface-3'));
      if (ring < 3) failing.push(`segment ring on the track: ${ring}`);
      expect(failing).toEqual([]);
    });
  }
});

/** The lists lane's stylesheets (paths under src). */
const LANE_FILES = [
  'tasks/task-group-table.module.css',
  'tasks/deadline-list.module.css',
  'tasks/filter-chips.module.css',
  'tasks/bulk-bar.module.css',
  'tasks/view-toolbar.module.css',
  'tasks/checkbox.module.css',
  'tasks/switch.module.css',
  'tasks/segmented-control.module.css',
  'tasks/nav-tabs.module.css',
  'edit/picker-popover.module.css',
];

describe('the lists are migrated', () => {
  test('no lists stylesheet or component reads a retired token name', () => {
    const sources = [
      ...LANE_FILES,
      ...LANE_FILES.map((file) => file.replace('.module.css', '.tsx')),
      'tasks/bulk-bar-height.ts',
      'tasks/task-selection.ts',
      'tasks/collapsed-groups.ts',
    ].map((file) => path.join(srcDir, file));
    expect(retiredNamesIn(sources)).toEqual([]);
  });
});
