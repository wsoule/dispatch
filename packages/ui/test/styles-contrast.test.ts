import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import {
  contrast,
  cssRule,
  darkTokens,
  hex,
  lightTokens,
  luminance,
  over,
  readCss,
  RETIRED,
  retiredNamesIn,
  sourceFiles,
  srcDir,
  THEMES,
  tintShare,
  tokensCss,
} from './contrast-helpers';

// Contrast of the Gr8r tokens (WCAG AA: 4.5:1 for text, the smallest of
// which is 11px; 3:1 for marks, control edges, focus and selection),
// computed from tokens.css itself in both themes: every text token on
// every surface it can sit on, every tone's text on its own soft tint, the
// text that sits on a fill, and every mark on every surface. Plus the
// data-tone hook's mapping (docs/architecture.md §8.2 "Status colours"),
// the soft dark floor, and the guards for the sheets not yet restyled.
// The issue list's and the graph's own checks live in tasks-contrast and
// graph-contrast.

// Everything text can sit on, back to front.
const SURFACES = [
  '--bg',
  '--bg-side',
  '--surface',
  '--surface-2',
  '--surface-3',
  '--sunken',
];
// Text tokens: three text steps (--text-4 is for glyphs, never words), the
// accent's text step and the status hues, which are text-safe.
const TEXT = [
  '--text',
  '--text-2',
  '--text-3',
  '--accent-ink',
  '--accent-ink-hover',
  '--red',
  '--amber',
  '--green',
  '--blue',
];
// Each tone's text on its own soft tint (a chip, a notice, an alert, a
// selected row), over the surfaces a tinted thing sits on.
const TINTS: [text: string, tint: string][] = [
  ['--accent-ink', '--accent-soft'],
  ['--red', '--red-soft'],
  ['--amber', '--amber-soft'],
  ['--green', '--green-soft'],
  ['--blue', '--blue-soft'],
];
const TINT_BASES = ['--surface', '--surface-2', '--bg-side'];

/** "a on b: ratio" for every pair below `min`, so a failure names it. */
function below(
  min: number,
  tokens: Map<string, string>,
  pairs: [fg: string, bg: string][]
): string[] {
  return pairs
    .map(([fg, bg]) => ({
      label: `${fg} on ${bg}`,
      ratio: contrast(hex(tokens, fg), hex(tokens, bg)),
    }))
    .filter(({ ratio }) => !(ratio >= min))
    .map(({ label, ratio }) => `${label}: ${ratio.toFixed(2)}`);
}

describe('text tokens meet 4.5:1 in both themes', () => {
  for (const [theme, tokens] of THEMES) {
    test(`${theme}: every text token on every surface`, () => {
      const pairs = TEXT.flatMap((text) =>
        SURFACES.map((surface): [string, string] => [text, surface])
      );
      expect(below(4.5, tokens, pairs)).toEqual([]);
    });

    test(`${theme}: each tone's text on its own soft tint`, () => {
      const failing: string[] = [];
      for (const [text, tint] of TINTS) {
        const share = tintShare(lightTokens, tint);
        const hue = tint === '--accent-soft' ? '--accent' : text;
        for (const base of TINT_BASES) {
          const ground = over(hex(tokens, hue), hex(tokens, base), share);
          const ratio = contrast(hex(tokens, text), ground);
          if (ratio < 4.5) failing.push(`${text} on ${tint}/${base}: ${ratio}`);
        }
      }
      expect(failing).toEqual([]);
    });

    // An alert's follow-up is an accent link on the alert's tint, and a
    // notice's sentence is --text on it.
    test(`${theme}: the accent link and the body text on every status tint`, () => {
      const failing: string[] = [];
      for (const [hue, tint] of TINTS.slice(1)) {
        const share = tintShare(lightTokens, tint);
        const ground = over(hex(tokens, hue), hex(tokens, '--surface'), share);
        for (const text of ['--accent-ink', '--text', '--text-2']) {
          const ratio = contrast(hex(tokens, text), ground);
          if (ratio < 4.5) failing.push(`${text} on ${tint}: ${ratio}`);
        }
      }
      expect(failing).toEqual([]);
    });

    test(`${theme}: text on fills`, () => {
      expect(
        below(4.5, tokens, [
          ['--on-accent', '--accent'],
          ['--on-red', '--red'],
          ['--on-amber', '--amber'],
          ['--on-green', '--green'],
          ['--on-blue', '--blue'],
          ['--on-danger', '--red'],
          ['--text-inv', '--text'],
        ])
      ).toEqual([]);
    });

    // A toast, a tooltip and the bulk bar are inverted (--text fill): the
    // accent and the status hues on them use their -ink-inverse step.
    test(`${theme}: the accent and the hues on an inverted fill`, () => {
      expect(
        below(4.5, tokens, [
          ['--accent-ink-inverse', '--text'],
          ['--red-ink-inverse', '--text'],
          ['--amber-ink-inverse', '--text'],
          ['--green-ink-inverse', '--text'],
          ['--blue-ink-inverse', '--text'],
        ])
      ).toEqual([]);
    });
  }

  test('the fill accent is one purple in both themes', () => {
    expect(hex(lightTokens, '--accent')).toBe('#9747ff');
    expect(hex(darkTokens, '--accent')).toBe('#9747ff');
  });
});

// Non-text contrast (WCAG 1.4.11, 3:1): what tells a control, its state
// or a meaningful mark from what is around it. The soft lines (--border,
// --border-strong, --divider) are decoration and are not checked; these
// are the edges and marks a person must be able to see.
const NON_TEXT: [mark: string, why: string][] = [
  // the edge of a field, a checkbox, the switch's off track
  ['--control-border', 'control boundary'],
  // the focus ring, the active-option bar, the selected segment's ring,
  // a checked box, the on switch, the today line
  ['--accent', 'focus ring and selection'],
  // the current nav item's icon
  ['--accent-ink', 'current nav icon'],
  // StatusMark's diamonds and the toned dots: the status hues, the
  // inactive grey, the open and done marks
  ['--red', 'status mark'],
  ['--amber', 'status mark'],
  ['--green', 'status mark'],
  ['--blue', 'status dot'],
  ['--gray', 'inactive mark'],
  ['--text-2', 'open mark'],
  ['--text-3', 'missing mark'],
  // StateGlyph's workflow colours (the state name sits beside them, but
  // the glyph's shape and hue are what a scanning eye reads)
  ['--st-triage', 'state glyph'],
  ['--st-backlog', 'state glyph'],
  ['--st-todo', 'state glyph'],
  ['--st-progress', 'state glyph'],
  ['--st-done', 'state glyph'],
  ['--st-canceled', 'state glyph'],
];

describe('non-text marks meet 3:1 in both themes', () => {
  for (const [theme, tokens] of THEMES) {
    test(`${theme}: control edges, focus and status marks on every surface`, () => {
      const pairs = NON_TEXT.flatMap(([mark]) =>
        SURFACES.map((surface): [string, string] => [mark, surface])
      );
      expect(below(3, tokens, pairs)).toEqual([]);
    });

    test(`${theme}: the accent on its own soft tint (a selected row's bar)`, () => {
      const share = tintShare(lightTokens, '--accent-soft');
      const failing: string[] = [];
      for (const base of TINT_BASES) {
        const ground = over(hex(tokens, '--accent'), hex(tokens, base), share);
        const ratio = contrast(hex(tokens, '--accent'), ground);
        if (ratio < 3)
          failing.push(`--accent on --accent-soft/${base}: ${ratio}`);
      }
      expect(failing).toEqual([]);
    });

    test(`${theme}: the switch knob on its track, off and on`, () => {
      // The knob is --on-accent; off it sits on --control-border, on it
      // sits on --accent. A mark on the accent fill (a checked box's
      // tick) is the same pair.
      expect(
        below(3, tokens, [
          ['--on-accent', '--control-border'],
          ['--on-accent', '--accent'],
        ])
      ).toEqual([]);
    });

    // A done mark is a solid neutral diamond, an overdue one a solid red
    // diamond: they must differ in lightness, not only in hue, for
    // someone without red-green vision or in greyscale. A green fill would
    // not (it is as light as the red one), which is why done is not green.
    test(`${theme}: done and overdue differ in lightness; green and red would not`, () => {
      const done = contrast(hex(tokens, '--text'), hex(tokens, '--red'));
      const green = contrast(hex(tokens, '--green'), hex(tokens, '--red'));
      expect(done).toBeGreaterThan(2);
      expect(green).toBeLessThan(1.5);
    });
  }

  test('fields use the control edge, not the soft line', () => {
    expect(readCss('styles/primitives.css')).toContain(
      'border: 1px solid var(--control-border);'
    );
  });
});

// The keyboard focus ring (--focus-ring: the accent in light, its lighter
// step in dark) must read 3:1 wherever focus can land: every surface,
// every status tint over the surfaces a tinted thing sits on (an alert's
// "Graph" link, a warning notice's button, a toned chip's ×), a selected
// row's accent tint, and a toned timeline bar (16% of its hue over the
// surface, the due-date handles). An inverted fill (a toast, the bulk bar)
// uses --focus-ring-inverse on --text.
describe('the focus ring meets 3:1 wherever focus lands, in both themes', () => {
  const BAR_FILL = 0.16;
  for (const [theme, tokens] of THEMES) {
    test(`${theme}: on every surface, status tint and toned bar`, () => {
      const ring = hex(tokens, '--focus-ring');
      const failing: string[] = [];
      for (const surface of SURFACES) {
        const ratio = contrast(ring, hex(tokens, surface));
        if (ratio < 3) failing.push(`on ${surface}: ${ratio.toFixed(2)}`);
      }
      for (const [text, tint] of TINTS) {
        const share = tintShare(lightTokens, tint);
        const hue = tint === '--accent-soft' ? '--accent' : text;
        for (const base of TINT_BASES) {
          const ground = over(hex(tokens, hue), hex(tokens, base), share);
          const ratio = contrast(ring, ground);
          if (ratio < 3)
            failing.push(`on ${tint}/${base}: ${ratio.toFixed(2)}`);
        }
      }
      for (const hue of ['--red', '--amber', '--green', '--blue', '--gray']) {
        const ground = over(
          hex(tokens, hue),
          hex(tokens, '--surface'),
          BAR_FILL
        );
        const ratio = contrast(ring, ground);
        if (ratio < 3) failing.push(`on a ${hue} bar: ${ratio.toFixed(2)}`);
      }
      expect(failing).toEqual([]);
    });

    test(`${theme}: the inverse ring on an inverted fill`, () => {
      expect(below(3, tokens, [['--focus-ring-inverse', '--text']])).toEqual(
        []
      );
    });
  }

  test('light keeps the fill purple; dark takes its lighter step', () => {
    expect(hex(lightTokens, '--focus-ring')).toBe('#9747ff');
    expect(hex(darkTokens, '--focus-ring')).toBe(
      hex(darkTokens, '--accent-ink')
    );
  });

  test('the global ring and every component focus ring use the token', () => {
    expect(
      cssRule(
        'styles/tokens.css',
        ':where(html:not([data-bt-ui-scoped]), [data-bt-ui]) :focus-visible'
      )
    ).toContain('outline: 2px solid var(--focus-ring);');
    // A focus rule (its selector holds :focus-visible or :focus-within,
    // not inside :not()) never draws its ring in the bare accent.
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir).filter((f) => f.endsWith('.css'))) {
      const sheet = readCss(path.relative(srcDir, file)).replace(/\s+/g, ' ');
      for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = (match[1] ?? '').replace(/:not\([^)]*\)/g, '');
        const body = match[2] ?? '';
        if (!/:focus-(visible|within)/.test(selector)) continue;
        if (
          /outline(-color)?:[^;]*var\(--accent\)/.test(body) ||
          /border:[^;]*var\(--accent\)/.test(body)
        ) {
          offenders.push(`${path.relative(srcDir, file)}: ${selector.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The inverted fills hand their controls the inverse ring.
    for (const [file, selector] of [
      ['shell/toast.module.css', '.toast'],
      ['tasks/bulk-bar.module.css', '.bar'],
      ['tasks/chip.module.css', '.inverse'],
    ] as const) {
      expect([file, cssRule(file, selector)]).toEqual([
        file,
        expect.stringContaining('--focus-ring: var(--focus-ring-inverse);'),
      ]);
    }
  });
});

describe('status hues', () => {
  test('no status hue is the purple accent', () => {
    for (const [, tokens] of THEMES) {
      const purples = ['--accent', '--accent-ink', '--accent-ink-hover'].map(
        (name) => hex(tokens, name)
      );
      for (const hue of ['--red', '--amber', '--green', '--blue', '--gray']) {
        expect([hue, purples.includes(hex(tokens, hue))]).toEqual([hue, false]);
      }
    }
  });

  // The on-track mark is only a thin outline (StatusMark, a bar's edge),
  // so its green holds 4.5:1, not just 3:1, on every surface.
  test('the on-track green holds 4.5:1 on every surface in both themes', () => {
    for (const [, tokens] of THEMES) {
      expect(
        below(
          4.5,
          tokens,
          SURFACES.map((surface): [string, string] => ['--green', surface])
        )
      ).toEqual([]);
    }
  });

  // A missing-input timeline bar is a dashed outline on the surface with
  // its "Missing: …" line in amber (the old hatch is retired): amber text
  // reads on the surface, under the hover fill and on a weekend column.
  test('the missing line is 4.5:1 on the surface, the hover fill and the sunken band', () => {
    for (const [, tokens] of THEMES) {
      expect(
        below(4.5, tokens, [
          ['--amber', '--surface'],
          ['--amber', '--surface-2'],
          ['--amber', '--sunken'],
        ])
      ).toEqual([]);
    }
  });
});

describe('the data-tone hook', () => {
  // The tones and the tokens each one maps to (tokens.css, TONE HOOK;
  // docs/architecture.md §8.2): [--tone, --tone-ink, --tone-soft,
  // --tone-line, --on-tone].
  const HOOK: Record<string, [string, string, string, string, string]> = {
    muted: [
      'var(--gray)',
      'var(--text-3)',
      'var(--surface-2)',
      'var(--border)',
      'var(--surface)',
    ],
    accent: [
      'var(--accent)',
      'var(--accent-ink)',
      'var(--accent-soft)',
      'var(--accent-line)',
      'var(--on-accent)',
    ],
    danger: [
      'var(--red)',
      'var(--red)',
      'var(--red-soft)',
      'var(--red-line)',
      'var(--on-red)',
    ],
    warning: [
      'var(--amber)',
      'var(--amber)',
      'var(--amber-soft)',
      'var(--amber-line)',
      'var(--on-amber)',
    ],
    success: [
      'var(--green)',
      'var(--green)',
      'var(--green-soft)',
      'var(--green-line)',
      'var(--on-green)',
    ],
    info: [
      'var(--blue)',
      'var(--blue)',
      'var(--blue-soft)',
      'var(--blue-line)',
      'var(--on-blue)',
    ],
  };
  const NAMES = [
    '--tone',
    '--tone-ink',
    '--tone-soft',
    '--tone-line',
    '--on-tone',
  ];
  const flat = tokensCss.replace(/\s+/g, ' ');

  test('every tone defines its five variables from its hue', () => {
    for (const [tone, values] of Object.entries(HOOK)) {
      const head = `:where([data-tone='${tone}']) {`;
      const at = flat.indexOf(head);
      expect([tone, at >= 0]).toEqual([tone, true]);
      const body = flat.slice(at + head.length, flat.indexOf('}', at));
      NAMES.forEach((name, i) => {
        expect([tone, body]).toEqual([
          tone,
          expect.stringContaining(`${name}: ${values[i]};`),
        ]);
      });
    }
  });

  test('a bare data-tone (default) leaves the surrounding text alone', () => {
    expect(flat).toContain(
      ':where([data-tone]) { --tone: var(--text-2); --tone-ink: currentcolor;'
    );
  });

  // A status tone's text is its hue itself (text-safe in Gr8r, so the
  // same token draws the mark and the words), a literal in both themes.
  test('each status tone reads its text straight from its hue', () => {
    for (const [, tokens] of THEMES) {
      for (const hue of ['red', 'amber', 'green', 'blue']) {
        expect(hex(tokens, `--${hue}`)).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
    for (const tone of ['danger', 'warning', 'success', 'info']) {
      const head = `:where([data-tone='${tone}']) {`;
      const body = flat.slice(
        flat.indexOf(head),
        flat.indexOf('}', flat.indexOf(head))
      );
      expect([tone, body]).toEqual([
        tone,
        expect.not.stringContaining('-ink)'),
      ]);
    }
  });
});

describe('dark mode is a soft dark', () => {
  // Owner 2026-10-23: the old near-black was "too dark". Gr8r's warm dark
  // (#1a1a19 page, #1d1d1c surface) is the floor: no surface is darker
  // than #1a1a19, and the main column is not darker than #1d1d1c.
  test('no dark surface is darker than #1a1a19', () => {
    const floor = luminance('#1a1a19');
    const darker = SURFACES.filter(
      (name) => luminance(hex(darkTokens, name)) < floor
    );
    expect(darker).toEqual([]);
    expect(luminance(hex(darkTokens, '--surface'))).toBeGreaterThanOrEqual(
      luminance('#1d1d1c')
    );
  });

  test('the two dark blocks are a redefinition, not the light values', () => {
    for (const name of SURFACES) {
      expect([name, hex(darkTokens, name) !== hex(lightTokens, name)]).toEqual([
        name,
        true,
      ]);
    }
  });
});

// The old Analytics names were deprecated aliases while the screens moved
// to the Gr8r tokens (docs/architecture.md §8.2 "Old token names" maps each
// one). Every screen, and every branch written before the restyle, has
// moved, so tokens.css no longer declares them and no file reads them: a
// sheet merged in later that still does fails here (it would get nothing
// from the token, not a warm stand-in).
describe('the old token names are gone', () => {
  test('tokens.css declares none of them, in any theme', () => {
    expect(
      RETIRED.filter((name) =>
        new RegExp(`(?<![\\w-])${name}\\s*:`).test(tokensCss)
      )
    ).toEqual([]);
    for (const [, tokens] of THEMES) {
      expect(RETIRED.filter((name) => tokens.has(name))).toEqual([]);
    }
  });

  // The guard covers the whole package, tokens.css included: no file
  // under src reads or sets a retired name.
  test('no file under src reads a retired name', () => {
    const files = sourceFiles(srcDir);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => path.basename(file) === 'tokens.css')).toBe(
      true
    );
    expect(retiredNamesIn(files)).toEqual([]);
  });
});

// The global ring's 4px corners carry no specificity (:focus-visible inside
// :where), so a class that sets its own radius (a pill, a 6px button, a
// graph box) keeps it when focused; the outline itself keeps the
// pseudo-class's weight, so a module cannot drop the ring by accident.
describe('the global focus ring', () => {
  const scope = ':where(html:not([data-bt-ui-scoped]), [data-bt-ui])';

  test('draws the 2px focus-ring outline with no radius of its own', () => {
    const ring = cssRule('styles/tokens.css', `${scope} :focus-visible`);
    expect(ring).toContain('outline: 2px solid var(--focus-ring)');
    expect(ring).not.toContain('border-radius');
  });

  test('rounds only elements without a radius', () => {
    expect(
      cssRule('styles/tokens.css', `${scope} :where(:focus-visible)`)
    ).toBe('border-radius: var(--r-xs);');
  });
});

// The sidebar no longer floods (the Analytics look did): a hovered item
// takes the --surface-3 fill and its project marks keep their own hue,
// which holds 3:1 there and on the sidebar grey in both themes.
describe('the sidebar hover', () => {
  test('the sidebar item hover is a soft fill and its marks keep their hue', () => {
    const body = cssRule(
      'shell/app-shell.module.css',
      ".brandLink:hover, .item:not([aria-current='page']):hover, .iconButton:hover, .tools button:hover"
    );
    expect(body).toContain('background: var(--surface-3);');
    expect(body).not.toMatch(/--(red|amber|green|gray|grey):/);
    for (const [, tokens] of THEMES) {
      expect(
        below(3, tokens, [
          ['--red', '--surface-3'],
          ['--amber', '--surface-3'],
          ['--red', '--bg-side'],
          ['--amber', '--bg-side'],
        ])
      ).toEqual([]);
    }
  });
});

// The brand row as the workspace switcher (AppShellProps.workspaceSwitcher):
// the picker's 'brand' trigger takes the brand link's --surface-3 fill on
// hover and while its menu is open; its chevrons-up-down mark is --text-4
// at rest (3:1 on the sidebar) and --text-3 on that fill (--text-4 would
// fall under 3:1 there in dark); the menu's workspace tiles carry their
// initials at 4.5:1, the current one in the brand tile's colours.
describe('the workspace switcher', () => {
  test('the brand trigger fills like the brand link on hover and while open', () => {
    expect(
      cssRule('edit/picker-popover.module.css', ".brand[aria-expanded='true']")
    ).toBe('background: var(--surface-3);');
    expect(
      cssRule('edit/picker-popover.module.css', '.brand:not(:disabled):hover')
    ).toBe('background: var(--surface-3);');
  });

  test('the chevron is a 3:1 mark at rest and on the hover and open fill', () => {
    const file = 'shell/app-shell.module.css';
    expect(cssRule(file, '.brandChevron')).toContain('color: var(--text-4);');
    for (const selector of [
      ".switcher [aria-expanded='true'] .brandChevron",
      '.switcher button:hover .brandChevron',
    ]) {
      expect([selector, cssRule(file, selector)]).toEqual([
        selector,
        'color: var(--text-3);',
      ]);
    }
    for (const [, tokens] of THEMES) {
      expect(
        below(3, tokens, [
          ['--text-4', '--bg-side'],
          ['--text-3', '--surface-3'],
        ])
      ).toEqual([]);
    }
  });

  test('the menu tiles hold their initials at 4.5:1, on the menu and its active row', () => {
    const file = 'shell/app-shell.module.css';
    const tile = cssRule(file, '.workspaceTile');
    expect(tile).toContain('background: var(--surface-3);');
    expect(tile).toContain('color: var(--text-2);');
    const current = cssRule(file, '.workspaceTileCurrent');
    expect(current).toContain('background: var(--brand-tile-bg, var(--text));');
    expect(current).toContain('color: var(--brand-tile-ink, var(--text-inv));');
    for (const [, tokens] of THEMES) {
      expect(
        below(4.5, tokens, [
          ['--text-2', '--surface-3'],
          ['--brand-tile-ink', '--brand-tile-bg'],
          // The rows' hints ("Guest", "linear.app/acme") on the menu and
          // on its active row's fill.
          ['--text-3', '--surface'],
          ['--text-3', '--surface-2'],
        ])
      ).toEqual([]);
    }
  });
});
