// Wraps an async function so overlapping calls share exactly one in-flight
// invocation instead of racing multiple concurrent ones — used by every
// `--watch` surface (run/epic) to collapse "several WS events landed while
// one refetch was already in progress" into a single HTTP round-trip
// instead of firing one per event. A fresh call starts a new invocation
// only once the previous one has settled (resolved OR rejected); the
// in-flight promise itself is returned to every caller that arrives while
// it's pending, so they all observe the same outcome.
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    inFlight ??= fn().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
