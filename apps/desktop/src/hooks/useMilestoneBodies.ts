import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import { useEffect, useMemo, useState } from 'react';

// The task list arrives without bodies (`fields=meta`), but the milestone
// rubric reads "Done means:" from a milestone's description. This fetches the
// bodies of the milestone tasks only (a project has a handful), each once per
// `updated` stamp, so an edit refetches just that milestone. The map keeps its
// identity while no body changed, so the planning chain is not recomputed.

/** What the hook needs of the daemon client. */
export type BodyClient = Pick<ApiClient, 'fetchTask'>;

const EMPTY: ReadonlyMap<string, string> = new Map();

interface Kept {
  stamp: string;
  body: string;
}

/** A milestone's identity for refetching: its id and last update. */
function stampOf(item: TaskListItem): string {
  return item.meta.updated;
}

/** Milestone task id → its body, filled in as the fetches land. */
export function useMilestoneBodies(
  client: BodyClient | null,
  tasks: readonly TaskListItem[]
): ReadonlyMap<string, string> {
  const [kept, setKept] = useState<ReadonlyMap<string, Kept>>(new Map());

  const milestones = useMemo(
    () => tasks.filter((item) => item.meta.kind === 'milestone'),
    [tasks]
  );

  useEffect(() => {
    if (client === null) return;
    const stale = milestones.filter(
      (item) => kept.get(item.meta.id)?.stamp !== stampOf(item)
    );
    if (stale.length === 0) return;
    let live = true;
    void Promise.allSettled(
      stale.map(async (item) => ({
        id: item.meta.id,
        stamp: stampOf(item),
        body: (await client.fetchTask(item.meta.id)).body,
      }))
    ).then((results) => {
      if (!live) return;
      setKept((prev) => {
        const next = new Map(prev);
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const { id, stamp, body } = result.value;
          next.set(id, { stamp, body });
        }
        return next;
      });
    });
    return () => {
      live = false;
    };
  }, [client, milestones, kept]);

  // Bodies of the milestones still listed: a removed one drops out.
  return useMemo(() => {
    if (kept.size === 0) return EMPTY;
    const bodies = new Map<string, string>();
    for (const item of milestones) {
      const entry = kept.get(item.meta.id);
      if (entry !== undefined) bodies.set(item.meta.id, entry.body);
    }
    return bodies;
  }, [kept, milestones]);
}
