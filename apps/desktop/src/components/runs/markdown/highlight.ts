import type { CodeBlockToken } from '@dispatch/ui';
import { useEffect, useReducer } from 'react';
import type { BundledLanguage, BundledTheme } from 'shiki';

type Shiki = typeof import('shiki');

/** One fence's highlighted lines, as the library CodeBlock draws them. */
export type FenceTokens = ReadonlyArray<ReadonlyArray<CodeBlockToken>>;

// GitHub's high-contrast pair: every token colour holds 4.5:1 on the fence's --sunken,
// --surface and --surface-2 in its own theme (main's github-light/-dark comments and
// strings fall to about 3:1 there; highlight.test.ts checks the pair).
export const FENCE_THEMES = {
  light: 'github-light-high-contrast',
  dark: 'github-dark-high-contrast',
} as const satisfies Record<'light' | 'dark', BundledTheme>;

// Fences that are prose, not code: no colors, so they read as plain text.
const PLAIN_LANGUAGES = new Set(['text', 'txt', 'plain', 'plaintext']);
const CACHE_LIMIT = 500;

let shikiLoad: Promise<Shiki | null> | null = null;
// `null` records a fence Shiki can't color, so it isn't retried on every render.
const highlighted = new Map<string, FenceTokens | null>();

function loadShiki(): Promise<Shiki | null> {
  shikiLoad ??= import('shiki').then(
    (shiki) => shiki,
    () => null
  );
  return shikiLoad;
}

function cacheKey(code: string, language: string): string {
  return `${language}\0${code}`;
}

// Undefined until the fence has been highlighted (or found unsupported) once.
function peekHighlight(
  code: string,
  language: string
): FenceTokens | null | undefined {
  return highlighted.get(cacheKey(code, language));
}

// Reads `--shiki-light:<colour>;--shiki-dark:<colour>` (Shiki's per-theme default foreground)
// into a map, so runs drawn in that default can drop it and read as the app's --text.
function parseStyle(style: string): Map<string, string> {
  const entries = style.split(';').flatMap((declaration) => {
    const at = declaration.indexOf(':');
    if (at < 0) return [];
    return [
      [
        declaration.slice(0, at).trim(),
        declaration
          .slice(at + 1)
          .trim()
          .toLowerCase(),
      ] as const,
    ];
  });
  return new Map(entries);
}

const COLOUR_VARS = ['--shiki-light', '--shiki-dark'] as const;

/**
 * Turns Shiki's themed tokens into CodeBlock runs. Each run keeps only its two colour
 * variables, and drops either one that equals that theme's default foreground (or that
 * Shiki left as `inherit`), so plain text inherits the fence's --text (styles/markdown.css)
 * and only real syntax is tinted. A run the theme paints on a background of its own (a
 * stray carriage return, an ignored diff line) keeps no colour at all: the fence draws no
 * token backgrounds, and its light-on-fill ink would vanish on the well.
 */
export function toFenceTokens(
  lines: ReadonlyArray<
    ReadonlyArray<{ content: string; htmlStyle?: Record<string, string> }>
  >,
  defaultStyle: string
): FenceTokens {
  const defaults = parseStyle(defaultStyle);
  return lines.map((line) =>
    line.map(({ content, htmlStyle }) => {
      const vars: Record<`--${string}`, string> = {};
      const painted =
        htmlStyle?.['--shiki-light-bg'] !== undefined ||
        htmlStyle?.['--shiki-dark-bg'] !== undefined;
      for (const name of painted ? [] : COLOUR_VARS) {
        const value = htmlStyle?.[name];
        if (
          value !== undefined &&
          value !== 'inherit' &&
          value.toLowerCase() !== defaults.get(name)
        )
          vars[name] = value;
      }
      return Object.keys(vars).length > 0 ? { content, vars } : { content };
    })
  );
}

/**
 * Colors one fence with Shiki's GitHub high-contrast light and dark themes as CSS
 * variables, so the theme switch recolors it without re-highlighting. Shiki and each
 * grammar load lazily, on the first fence that needs them. Resolves `null` for languages
 * Shiki doesn't ship.
 */
async function highlightCode(
  code: string,
  language: string
): Promise<FenceTokens | null> {
  const key = cacheKey(code, language);
  const hit = highlighted.get(key);
  if (hit !== undefined) return hit;
  const shiki = PLAIN_LANGUAGES.has(language) ? null : await loadShiki();
  let tokens: FenceTokens | null = null;
  if (shiki && Object.hasOwn(shiki.bundledLanguages, language)) {
    try {
      const result = await shiki.codeToTokens(code, {
        lang: language as BundledLanguage,
        themes: FENCE_THEMES,
        defaultColor: false,
      });
      tokens = toFenceTokens(result.tokens, result.fg ?? '');
    } catch {
      tokens = null;
    }
  }
  if (highlighted.size >= CACHE_LIMIT) {
    const oldest = highlighted.keys().next().value;
    if (oldest !== undefined) highlighted.delete(oldest);
  }
  highlighted.set(key, tokens);
  return tokens;
}

// A fence's highlighted lines once ready, or null while loading, disabled, or unsupported.
export function useHighlightedTokens(
  code: string,
  language: string | undefined,
  enabled: boolean
): FenceTokens | null {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const active = enabled && language !== undefined;
  const cached = active ? peekHighlight(code, language) : null;
  const pending = active && cached === undefined;
  useEffect(() => {
    if (!pending || language === undefined) return;
    let live = true;
    void highlightCode(code, language).then(() => {
      if (live) rerender();
    });
    return () => {
      live = false;
    };
  }, [code, language, pending]);
  return cached ?? null;
}
