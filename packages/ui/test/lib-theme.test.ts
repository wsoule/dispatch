import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  applyThemeChoice,
  holdThemeSwitch,
  readThemeChoice,
  showTheme,
  type ThemeChoice,
  themeChoiceOf,
  themeScript,
} from '../src/index';

const KEY = 'bt-test-theme-choice';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-switching');
  localStorage.clear();
});

// Resolves after the browser's next animation frame.
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

const switching = () =>
  document.documentElement.hasAttribute('data-theme-switching');

// A storage whose every call throws, as Safari's private mode or blocked
// site data does.
const throwingStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
} as unknown as Storage;

// Swaps the global localStorage for `storage` while `run` runs, then puts
// happy-dom's own back (it is a configurable getter on globalThis).
function withStorage(storage: Storage, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  try {
    run();
  } finally {
    if (original !== undefined) {
      Object.defineProperty(globalThis, 'localStorage', original);
    }
  }
}

// Stubs matchMedia so the OS reports dark or light (the ThemeToggle tests'
// withOsDark pattern) and returns how many times the stub was asked.
function withOsDark(dark: boolean, run: () => void): number {
  const original = window.matchMedia;
  let calls = 0;
  window.matchMedia = ((query: string) => {
    calls += 1;
    return {
      matches: dark && query.includes('dark'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  }) as unknown as typeof window.matchMedia;
  try {
    run();
  } finally {
    window.matchMedia = original;
  }
  return calls;
}

// What sits under the key before the script runs: a stored string, no key,
// or a storage that throws.
type Stored = { value: string } | 'missing' | 'throws';

const STORED: { name: string; stored: Stored }[] = [
  { name: "'light'", stored: { value: 'light' } },
  { name: "'dark'", stored: { value: 'dark' } },
  { name: "'system'", stored: { value: 'system' } },
  { name: 'garbage', stored: { value: 'garbage' } },
  { name: 'empty', stored: { value: '' } },
  { name: 'no key', stored: 'missing' },
  { name: 'a throwing getItem', stored: 'throws' },
];

// Runs an emitted script the way the browser would, from an <html> with no
// data-theme, and returns what it wrote plus how often it asked the OS.
function runScript(
  script: string,
  stored: Stored,
  osDark: boolean
): { theme: string | undefined; osCalls: number } {
  const execute = () => {
    // The script is a string a host inlines as <script>; running it is the
    // test, the same way a browser would.
    // oxlint-disable-next-line typescript-eslint/no-implied-eval
    new Function(script)();
  };
  const osCalls = withOsDark(osDark, () => {
    if (stored === 'throws') {
      withStorage(throwingStorage, execute);
      return;
    }
    if (stored !== 'missing') localStorage.setItem(KEY, stored.value);
    execute();
  });
  return { theme: document.documentElement.dataset.theme, osCalls };
}

// The theme each fallback must write for a stored value and an OS.
function expectedOs(stored: Stored, osDark: boolean): string {
  if (stored === 'throws') return 'light';
  if (stored !== 'missing' && themeChoiceOf(stored.value) !== 'system') {
    return stored.value;
  }
  return osDark ? 'dark' : 'light';
}

function expectedSystem(stored: Stored): string {
  if (stored === 'throws' || stored === 'missing') return 'system';
  return themeChoiceOf(stored.value);
}

describe('themeScript', () => {
  test("the default 'os' fallback keeps its output byte for byte", () => {
    expect(themeScript('app-theme')).toBe(
      '(function(){try{var t=localStorage.getItem("app-theme");if(t!=="dark"&&t!=="light"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="light";}})();'
    );
    expect(themeScript('app-theme', { fallback: 'os' })).toBe(
      themeScript('app-theme')
    );
    expect(themeScript('app-theme', {})).toBe(themeScript('app-theme'));
  });

  test('both fallbacks emit ES5 and pass the key through JSON.stringify', () => {
    const tricky = 'say "hi"\\there';
    for (const script of [
      themeScript(tricky),
      themeScript(tricky, { fallback: 'system' }),
    ]) {
      expect(script).not.toContain('=>');
      expect(script).not.toContain('let ');
      expect(script).not.toContain('const ');
      expect(script).not.toContain('`');
      expect(script).toContain(
        `localStorage.getItem(${JSON.stringify(tricky)})`
      );
    }
  });

  // A key is a host constant, but the script is inlined as HTML: nothing in
  // it may close the <script> element, open an HTML comment or end a line.
  test('a key cannot break out of the inline <script>', () => {
    const hostile = '</script><script>alert(1)</script><!--\u2028\u2029';
    for (const fallback of ['os', 'system'] as const) {
      const script = themeScript(hostile, { fallback });
      expect(script.toLowerCase()).not.toContain('</script');
      expect(script).not.toContain('<!--');
      expect(script).not.toContain('<');
      expect(script).not.toContain('\u2028');
      expect(script).not.toContain('\u2029');
      expect(script).toContain(
        'localStorage.getItem("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>\\u003c!--\\u2028\\u2029")'
      );
    }
  });

  // The escapes change only how the key is written: the script still reads
  // a choice stored under the exact key.
  test('an escaped key still reads the choice stored under it', () => {
    const hostile = '</script>\u2028key\u2029';
    for (const fallback of ['os', 'system'] as const) {
      localStorage.setItem(hostile, 'dark');
      // oxlint-disable-next-line typescript-eslint/no-implied-eval
      new Function(themeScript(hostile, { fallback }))();
      expect(document.documentElement.dataset.theme).toBe('dark');
      localStorage.clear();
      document.documentElement.removeAttribute('data-theme');
    }
  });

  for (const osDark of [true, false]) {
    const os = osDark ? 'an OS in dark' : 'an OS in light';

    for (const { name, stored } of STORED) {
      test(`'os' with ${name} under ${os}`, () => {
        const { theme } = runScript(themeScript(KEY), stored, osDark);
        expect(theme).toBe(expectedOs(stored, osDark));
      });

      test(`'system' with ${name} under ${os}`, () => {
        const { theme, osCalls } = runScript(
          themeScript(KEY, { fallback: 'system' }),
          stored,
          osDark
        );
        expect(theme).toBe(expectedSystem(stored));
        // tokens.css follows the OS live; the script never asks it.
        expect(osCalls).toBe(0);
      });
    }
  }
});

describe('themeChoiceOf', () => {
  const cases: [string | null | undefined, ThemeChoice][] = [
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
    ['', 'system'],
    [null, 'system'],
    [undefined, 'system'],
    ['garbage', 'system'],
    ['Dark', 'system'],
    [' light', 'system'],
  ];
  for (const [value, choice] of cases) {
    const label = value === undefined ? 'undefined' : JSON.stringify(value);
    test(`${label} is ${choice}`, () => {
      expect(themeChoiceOf(value)).toBe(choice);
    });
  }
});

describe('readThemeChoice and applyThemeChoice', () => {
  test('light and dark are stored and shown; system removes the key', () => {
    applyThemeChoice(KEY, 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(KEY)).toBe('dark');
    expect(readThemeChoice(KEY)).toBe('dark');

    applyThemeChoice(KEY, 'light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(KEY)).toBe('light');
    expect(readThemeChoice(KEY)).toBe('light');

    applyThemeChoice(KEY, 'system');
    expect(document.documentElement.dataset.theme).toBe('system');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readThemeChoice(KEY)).toBe('system');
  });

  test('a missing, system or unknown stored value reads as system', () => {
    expect(readThemeChoice(KEY)).toBe('system');
    for (const value of ['system', '', 'garbage']) {
      localStorage.setItem(KEY, value);
      expect(readThemeChoice(KEY)).toBe('system');
    }
  });

  test('throwing storage still changes the theme and reads as system', () => {
    withStorage(throwingStorage, () => {
      for (const choice of ['dark', 'light', 'system'] as const) {
        expect(() => {
          applyThemeChoice(KEY, choice);
        }).not.toThrow();
        expect(document.documentElement.dataset.theme).toBe(choice);
        expect(readThemeChoice(KEY)).toBe('system');
      }
    });
  });
});

describe('showTheme', () => {
  test('swaps data-theme with transitions off until the frame after', async () => {
    showTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(switching()).toBe(true);
    // Still off for the frame that first paints the new theme…
    await nextFrame();
    expect(switching()).toBe(true);
    // …and back on one frame later.
    await nextFrame();
    await nextFrame();
    expect(switching()).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  test('a second swap before the first settles restarts the wait', async () => {
    showTheme('dark');
    await nextFrame();
    showTheme('light');
    await nextFrame();
    // The first swap's end would have fallen here; the second keeps it off.
    expect(switching()).toBe(true);
    await nextFrame();
    await nextFrame();
    expect(switching()).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  test('a hold keeps transitions off past the swap, until two frames after its release', async () => {
    const release = holdThemeSwitch();
    expect(switching()).toBe(true);
    showTheme('system');
    // The swap's own end falls here, but the hold still needs the attribute.
    await nextFrame();
    await nextFrame();
    await nextFrame();
    expect(switching()).toBe(true);
    release();
    // Released: off for the frame that paints, then on again.
    await nextFrame();
    expect(switching()).toBe(true);
    await nextFrame();
    await nextFrame();
    expect(switching()).toBe(false);
    // A second release changes nothing (no hold count below zero).
    release();
    const again = holdThemeSwitch();
    showTheme('dark');
    await nextFrame();
    await nextFrame();
    await nextFrame();
    expect(switching()).toBe(true);
    again();
    await nextFrame();
    await nextFrame();
    await nextFrame();
    expect(switching()).toBe(false);
  });

  test('applyThemeChoice swaps through it', () => {
    applyThemeChoice(KEY, 'light');
    expect(switching()).toBe(true);
  });

  // The rule the attribute turns on, so the swap is what the attribute does.
  test('tokens.css turns every transition off under the attribute', () => {
    const css = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'styles', 'tokens.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /([^{}]*\[data-theme-switching\][^{}]*)\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const selectors = (rule?.[1] ?? '').split(',').map((s) => s.trim());
    // Every element; no universal ::before/::after (WebKit's cost, see the
    // rule's comment).
    expect(selectors.map((s) => s.split(' ').at(-1))).toEqual(['*']);
    expect(rule?.[2]).toContain('transition: none !important');
  });

  // Pseudo-elements are outside that rule; the picker's pills (the status
  // line's pill is drawn at rest) stand down under the attribute themselves.
  test("the picker's pill pseudo-elements stand down under the attribute too", () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'edit',
        'picker-popover.module.css'
      ),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /([^{}]*\[data-theme-switching\][^{}]*)\{([^}]*)\}/.exec(css);
    const selectors = (rule?.[1] ?? '').split(',').map((s) => s.trim());
    for (const pill of ['.value', '.mono', '.cell', '.mark']) {
      expect(selectors).toContain(
        `:global(:root[data-theme-switching]) ${pill}::before`
      );
    }
    expect(rule?.[2]).toContain('transition: none');
  });
});
