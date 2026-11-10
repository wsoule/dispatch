import type { ApiClient, WorkspaceSearchHit } from '@dispatch/client';
import { CommandPalette, type PaletteItem } from '@dispatch/ui';
import { File as FileIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/**
 * Quick open (Go to file): type a few letters, get the file.
 *
 * Matching and ranking happen on the daemon (see packages/server/src/fuzzy.ts)
 * because that is where the file list already is — shipping thousands of paths
 * to the renderer on every keystroke would cost more than the search does.
 * The reply carries the matched character positions as UTF-16 offsets, which
 * the library CommandPalette draws as marks (`highlight` on a `matched` item),
 * so a result shows *why* it matched.
 *
 * Mounted only while open: the caller renders it conditionally, and the
 * palette's query starts empty on every mount.
 */

interface QuickOpenDialogProps {
  client: ApiClient;
  runId: string | null;
  onClose: () => void;
  onPick: (path: string) => void;
}

// How long typing must pause before a search goes out, so a keystroke never
// queues a search per character while the previous one is still running.
const SEARCH_DEBOUNCE_MS = 80;

// One daemon hit as a palette row: already matched by the daemon, so the
// palette lists it in the daemon's order and marks the daemon's positions.
// A path is a machine-read string, so it is drawn in mono (Q5).
function hitItem(hit: WorkspaceSearchHit): PaletteItem {
  return {
    id: hit.path,
    label: hit.path,
    section: 'Files',
    matched: true,
    highlight: hit.positions,
    mono: true,
    icon: <FileIcon size={14} strokeWidth={1.8} aria-hidden />,
  };
}

export function QuickOpenDialog({
  client,
  runId,
  onClose,
  onPick,
}: QuickOpenDialogProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<WorkspaceSearchHit[]>([]);
  // True until the first reply (or failure) lands, so the palette shows its
  // loading rows rather than "Nothing to jump to yet" on open.
  const [loading, setLoading] = useState(true);
  // Why the last search failed, shown as the palette's "Could not load" row
  // (with Retry) rather than as "No matches".
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry, so the same query searches again.
  const [attempt, setAttempt] = useState(0);

  // Debounced search for the current query; a reply that lands after a newer
  // query (or after the dialog closed) is dropped through `cancelled`.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .searchWorkspace(query, { runId, limit: 40 })
        .then((result) => {
          if (cancelled) return;
          setHits(result.results);
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setHits([]);
          setError(
            err instanceof Error ? err.message : 'The search did not answer.'
          );
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, runId, query, attempt]);

  const items = useMemo(() => hits.map(hitItem), [hits]);

  return (
    <CommandPalette
      items={items}
      loading={loading}
      error={error}
      onRetry={() => {
        setLoading(true);
        setAttempt((n) => n + 1);
      }}
      onClose={onClose}
      onRun={(item) => {
        onPick(item.id);
        onClose();
      }}
      onQueryChange={setQuery}
      placeholder="Go to file"
      label="Go to file"
      inputLabel="Go to file"
    />
  );
}
