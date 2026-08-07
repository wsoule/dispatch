import { ApiError } from '@dispatch/client';

import type { BlastEntry, HopGroup } from './impactGroups';
import { filterByPath, groupByHop } from './impactGroups';

/** What `ImpactView`'s "Affected files" panel should show — decided once,
 *  in one place, so the component never chooses between "empty" and
 *  "error" inline. `error` always wins over `empty`, regardless of what
 *  `entries` holds (e.g. stale data left over from a prior successful
 *  fetch): a failed request is not the same fact as "nothing affected",
 *  and rendering it that way would silently under-report the blast radius
 *  — precisely what this feature exists to prevent. `pending` covers both
 *  an in-flight fetch and a query that is disabled (e.g. no API client
 *  yet) and so will never settle on its own — neither has produced a real
 *  answer, so neither may render as `empty`. */
export type AffectedFilesStatus =
  | { kind: 'error'; message: string }
  | { kind: 'pending' }
  | { kind: 'empty'; message: string }
  | { kind: 'entries'; groups: HopGroup[] };

const GENERIC_ERROR_MESSAGE = "Couldn't load the blast radius.";

/** Chooses the "Affected files" panel's state from a `useQuery` result plus
 *  the current path filter. Priority order: a failed request is always an
 *  `error`; next, a request that has not resolved (still loading, or
 *  disabled and so never even started) is `pending`, never `empty` —
 *  otherwise a disabled query (e.g. `client === null`) would render "No
 *  files affected." forever instead of a loading state. Only once the
 *  request has resolved without error do "no entries" and "filtered to
 *  nothing" get to produce their own `empty` wording. */
export function resolveAffectedFilesStatus({
  isError,
  error,
  entries,
  filter,
  resolved,
}: {
  isError: boolean;
  error: unknown;
  entries: BlastEntry[];
  filter: string;
  /** True once the query has actually settled with data — false while
   *  in-flight or disabled. */
  resolved: boolean;
}): AffectedFilesStatus {
  if (isError) {
    return {
      kind: 'error',
      message:
        error instanceof ApiError ? error.message : GENERIC_ERROR_MESSAGE,
    };
  }
  if (!resolved) {
    return { kind: 'pending' };
  }
  const filtered = filterByPath(entries, filter);
  if (filtered.length === 0) {
    return {
      kind: 'empty',
      message:
        entries.length === 0
          ? 'No files affected.'
          : 'No files match that filter.',
    };
  }
  return { kind: 'entries', groups: groupByHop(filtered) };
}
