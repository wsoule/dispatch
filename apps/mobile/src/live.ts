import type { ApiClient, ServerEvent } from '@dispatch/client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useRemote } from './remote';

export interface Live<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Data read through the tunnel, refetched whenever the daemon says one of
 * `events` happened. The daemon's events mean "go refetch", never a diff, so
 * a burst of them collapses into one request.
 */
export function useLive<T>(
  load: (client: ApiClient) => Promise<T>,
  events: ReadonlyArray<ServerEvent['type']>,
  key: string = ''
): Live<T> {
  const { client, status, subscribe } = useRemote();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (client === null) return;
    setLoading(true);
    try {
      setData(await loadRef.current(client));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  const ready = status.kind === 'ready';
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh, key]);

  const eventKey = events.join(',');
  useEffect(() => {
    const wanted = new Set(eventKey.split(','));
    const off = subscribe((event) => {
      if (!wanted.has(event.type)) return;
      if (pending.current !== null) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        void refresh();
      }, 250);
    });
    return () => {
      off();
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [eventKey, refresh, subscribe]);

  return { data, error, loading, refresh };
}
