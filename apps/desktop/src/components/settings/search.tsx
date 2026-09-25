import type { ReactNode } from 'react';
import { Children, createContext, isValidElement, useContext } from 'react';

// Settings search filters the real rows rather than a separate index, so a
// row can never be missing from search or point at a setting that moved.
// The shell provides the query; each page, group and row narrows it with its
// own text, and a match at any level shows everything under it.

interface SearchScope {
  /** Lower-cased, trimmed query; empty means search is off. */
  needle: string;
  /** Whether an enclosing page or group already matched on its own name. */
  matched: boolean;
}

const SearchContext = createContext<SearchScope>({
  needle: '',
  matched: false,
});

/** True when every word of `needle` appears somewhere in `haystack`. */
export function matchesQuery(needle: string, haystack: string): boolean {
  const text = haystack.toLowerCase();
  return needle.split(/\s+/).every((word) => text.includes(word));
}

// The visible text of a ReactNode, so a subtitle written as JSX still searches.
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(' ');
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return Children.toArray(node.props.children).map(nodeText).join(' ');
  }
  return '';
}

/** Starts a search scope. The shell passes the raw query at the top. */
export function SettingsSearchProvider({
  query,
  children,
}: {
  query: string;
  children: ReactNode;
}) {
  return (
    <SearchContext.Provider
      value={{ needle: query.trim().toLowerCase(), matched: false }}
    >
      {children}
    </SearchContext.Provider>
  );
}

/** Narrows the scope for a page or group: when its own `text` matches, every
 *  row inside shows regardless of the row's own text. */
export function SearchScopeProvider({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  const scope = useContext(SearchContext);
  const matched =
    scope.matched || (scope.needle !== '' && matchesQuery(scope.needle, text));
  return (
    <SearchContext.Provider value={{ needle: scope.needle, matched }}>
      {children}
    </SearchContext.Provider>
  );
}

/** Whether search is on and an enclosing page or group matched by name. */
export function useScopeMatched(): boolean {
  const { needle, matched } = useContext(SearchContext);
  return needle !== '' && matched;
}

/** Whether search is on at all. */
export function useSearching(): boolean {
  return useContext(SearchContext).needle !== '';
}

/** Whether content with this `text` should show under the current search. */
export function useSearchVisible(text: string): boolean {
  const { needle, matched } = useContext(SearchContext);
  return needle === '' || matched || matchesQuery(needle, text);
}

/**
 * Wraps settings content that is not a `SettingsRow` (a ladder, a table, a
 * preview) so search can find it by `text`. Matching content carries the same
 * marker a row does, which is what keeps its group and page visible.
 */
export function SettingsSearchable({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  const visible = useSearchVisible(text);
  if (!visible) return null;
  return (
    <div data-settings-row="" className="contents">
      {children}
    </div>
  );
}
