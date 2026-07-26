/**
 * A render crash whose message matches one of these phrasings means the module the app just
 * fetched no longer matches what's on disk — the classic long-running-dev-webview failure mode
 * where Vite rebuilds and old chunk URLs 404. Reloading the page (not just remounting the error
 * boundary) is the only real fix, so `ErrorBoundary`'s fallback offers a distinct "Reload app"
 * button whenever the thrown error matches one of these browser-specific phrasings. Kept in its
 * own module (no React/JSX/`@/ui` imports) so it can be unit-tested without dragging in the
 * class component or its component-only dependencies.
 */
export function isStaleChunkError(message: string): boolean {
  return /Importing a module script failed|Failed to fetch dynamically imported module|Load failed/.test(
    message
  );
}
