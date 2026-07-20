import type { DispatchConfig, TaskDoc } from '@dispatch/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { createApiClient } from './api';

export interface UseTasksResult {
  tasks: TaskDoc[];
  config: DispatchConfig | null;
  readyIds: Set<string>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Central data hook for a dispatchd-backed task UI: loads every task, the
// tracker config, and the ready-to-start set once, then reloads all three
// whenever dispatchd broadcasts `task.changed` over WS. There is no
// client-side diffing — every refresh just re-asks the server for the
// current truth, which is cheap at v1 scale and keeps the client dead
// simple. `baseUrl` is passed straight to `createApiClient` — see api.ts's
// module doc comment for why this is baseUrl-first rather than reading an
// env var.
export function useTasks(baseUrl: string): UseTasksResult {
  const client = useMemo(() => createApiClient(baseUrl), [baseUrl]);

  const [tasks, setTasks] = useState<TaskDoc[]>([]);
  const [config, setConfig] = useState<DispatchConfig | null>(null);
  const [readyIds, setReadyIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [taskList, cfg, ready] = await Promise.all([
          client.fetchTasks(),
          client.fetchConfig(),
          client.fetchReadyTasks(),
        ]);
        if (cancelled) return;
        setTasks(taskList);
        setConfig(cfg);
        setReadyIds(new Set(ready.map((t) => t.meta.id)));
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [client, generation]);

  // Reconnect the WS event stream whenever `client` changes (i.e. `baseUrl`
  // changed) and tear it down on unmount; `refresh` is stable (useCallback
  // with no deps) so this never reconnects on its account alone.
  useEffect(() => client.connectEvents(refresh), [client, refresh]);

  return { tasks, config, readyIds, loading, error, refresh };
}
