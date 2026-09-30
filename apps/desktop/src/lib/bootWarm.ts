import type { QueryClient } from '@tanstack/react-query';

import { connectionQuery } from '../hooks/useDispatchProject';
import { currentProjectRoot, hasDispatch } from './tauri';

// App learns its project one render at a time: the launch root, then whether it has
// dispatch, then the daemon connection, each hop a full render of the shell before the
// next request goes out. The warm-up walks the same chain before the first render, on the
// same query keys, so App's first renders find the answers (and the task list in flight).

export function launchRootKey() {
  return ['current-project-root'] as const;
}

export function hasDispatchKey(root: string | null | undefined) {
  return ['has-dispatch', root] as const;
}

const BOOT_SOURCES = { currentProjectRoot, hasDispatch };

/** Walks launch root → has-dispatch → connection into `queryClient`'s cache. A failure
 * stays in that query for App to report, as it would have found it itself. */
export function warmBoot(
  queryClient: QueryClient,
  sources: typeof BOOT_SOURCES = BOOT_SOURCES
): Promise<void> {
  const settled = { staleTime: Number.POSITIVE_INFINITY, retry: false };
  return (async () => {
    const root = await queryClient.fetchQuery({
      queryKey: launchRootKey(),
      queryFn: sources.currentProjectRoot,
      ...settled,
    });
    if (root === null) return;
    const enabled = await queryClient.fetchQuery({
      queryKey: hasDispatchKey(root),
      queryFn: () => sources.hasDispatch(root),
      ...settled,
    });
    if (enabled)
      await queryClient.fetchQuery(connectionQuery(queryClient, root));
  })().catch(() => {});
}
