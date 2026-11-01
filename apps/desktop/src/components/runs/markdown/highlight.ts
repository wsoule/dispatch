import { useEffect, useReducer } from 'react';
import type { BundledLanguage } from 'shiki';

type Shiki = typeof import('shiki');

// Fences that are prose, not code: no colors, so they read as plain text.
const PLAIN_LANGUAGES = new Set(['text', 'txt', 'plain', 'plaintext']);
const CACHE_LIMIT = 500;

let shikiLoad: Promise<Shiki | null> | null = null;
// `null` records a fence Shiki can't color, so it isn't retried on every render.
const highlighted = new Map<string, string | null>();

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
): string | null | undefined {
  return highlighted.get(cacheKey(code, language));
}

/**
 * Colors one fence with Shiki's GitHub light and dark themes as CSS variables, so the
 * theme switch recolors it without re-highlighting. Shiki and each grammar load lazily,
 * on the first fence that needs them. Resolves `null` for languages Shiki doesn't ship.
 */
async function highlightCode(
  code: string,
  language: string
): Promise<string | null> {
  const key = cacheKey(code, language);
  const hit = highlighted.get(key);
  if (hit !== undefined) return hit;
  const shiki = PLAIN_LANGUAGES.has(language) ? null : await loadShiki();
  let html: string | null = null;
  if (shiki && Object.hasOwn(shiki.bundledLanguages, language)) {
    try {
      html = await shiki.codeToHtml(code, {
        lang: language as BundledLanguage,
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false,
      });
    } catch {
      html = null;
    }
  }
  if (highlighted.size >= CACHE_LIMIT) {
    const oldest = highlighted.keys().next().value;
    if (oldest !== undefined) highlighted.delete(oldest);
  }
  highlighted.set(key, html);
  return html;
}

// Shiki's HTML for a fence once it's ready, or null while loading, disabled, or unsupported.
export function useHighlightedHtml(
  code: string,
  language: string | undefined,
  enabled: boolean
): string | null {
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
