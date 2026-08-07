import { ApiError } from '@dispatch/client';

import type { BlastEntry, HopGroup } from './impactGroups';
import { filterByPath, groupByHop } from './impactGroups';

/** What `ImpactView`'s "Affected files" panel should show — decided once,
 *  in one place, so the component never chooses between "empty" and
 *  "error" inline. `error` always wins over `empty`, regardless of what
 *  `entries` holds (e.g. stale data left over from a prior successful
 *  fetch): a failed request is not the same fact as "nothing affected",
 *  and rendering it that way would silently under-report the blast radius
 *  — precisely what this feature exists to prevent. */
export type AffectedFilesStatus =
  | { kind: 'error'; message: string }
  | { kind: 'empty'; message: string }
  | { kind: 'entries'; groups: HopGroup[] };

const GENERIC_ERROR_MESSAGE = "Couldn't load the blast radius.";

/** Chooses the "Affected files" panel's state from a `useQuery` result plus
 *  the current path filter. Priority order: a failed request is always an
 *  `error`, never `empty`, even when `entries` is non-empty or empty; only
 *  once the request has *not* failed do "no entries" and "filtered to
 *  nothing" get to produce their own `empty` wording. */
export function resolveAffectedFilesStatus({
  isError,
  error,
  entries,
  filter,
}: {
  isError: boolean;
  error: unknown;
  entries: BlastEntry[];
  filter: string;
}): AffectedFilesStatus {
  if (isError) {
    return {
      kind: 'error',
      message:
        error instanceof ApiError ? error.message : GENERIC_ERROR_MESSAGE,
    };
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
