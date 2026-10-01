import type {
  ApiClient,
  DocHit,
  DocLinking,
  DocListParams,
  DocProposal,
  DocRead,
  DocRevisionInfo,
  DocSummary,
  ServerEvent,
} from '@dispatch/client';
import type { QueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';

// Every docs query the desktop makes, and the one event handler that keeps
// them current: doc.changed is a bare refetch signal.

export function docsKey(port: number | undefined) {
  return ['dispatch-docs', port] as const;
}

function docKey(port: number | undefined, ref: string | null) {
  return [...docsKey(port), 'doc', ref] as const;
}

// A restart may have changed docs with no event this window saw.
export function applyDocsEvent(
  queryClient: QueryClient,
  port: number | undefined,
  event: ServerEvent
): void {
  if (event.type !== 'doc.changed' && event.type !== 'hello') return;
  void queryClient.invalidateQueries({ queryKey: docsKey(port) });
}

// A read in flight or answered since the save began at `since` may predate the
// save or follow it: fetch again, and return the fresh read to apply.
export async function refetchDocAfterSave(
  queryClient: QueryClient,
  port: number | undefined,
  ref: string,
  since: number
): Promise<DocRead | null> {
  const key = docKey(port, ref);
  const state = queryClient.getQueryState<DocRead>(key);
  if (
    state === undefined ||
    (state.fetchStatus !== 'fetching' && state.dataUpdatedAt <= since)
  ) {
    return null;
  }
  const asked = Date.now();
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  await queryClient.invalidateQueries({ queryKey: key, exact: true });
  const after = queryClient.getQueryState<DocRead>(key);
  return after?.data !== undefined && after.dataUpdatedAt >= asked
    ? after.data
    : null;
}

const NO_DOCS: DocSummary[] = [];
const NO_LINKING: DocLinking[] = [];
const NO_HITS: DocHit[] = [];
const NO_REVISIONS: DocRevisionInfo[] = [];
const NO_PROPOSALS: DocProposal[] = [];

// The most revisions the history panel lists, the route's own cap.
const HISTORY_LIMIT = 200;

function ready(client: ApiClient | null): ApiClient {
  if (client === null) throw new Error('dispatchd client not ready');
  return client;
}

export function useDocList(
  client: ApiClient | null,
  port: number | undefined,
  params: DocListParams
) {
  const q = useQuery({
    queryKey: [...docsKey(port), 'list', params],
    enabled: client !== null,
    queryFn: () => ready(client).listDocs(params),
  });
  return {
    docs: q.data?.docs ?? NO_DOCS,
    loading: q.isLoading,
    error: q.error,
  };
}

export function useDoc(
  client: ApiClient | null,
  port: number | undefined,
  ref: string | null
) {
  const q = useQuery({
    queryKey: docKey(port, ref),
    enabled: client !== null && ref !== null,
    queryFn: (): Promise<DocRead> => ready(client).getDoc(ref ?? ''),
  });
  return { read: q.data ?? null, loading: q.isLoading, error: q.error };
}

// The docs linked to `target` (`task:t-1`), with how each is linked.
export function useDocsLinking(
  client: ApiClient | null,
  port: number | undefined,
  target: string | null
) {
  const q = useQuery({
    queryKey: [...docsKey(port), 'links', target],
    enabled: client !== null && target !== null,
    queryFn: () => ready(client).docsLinking(target ?? ''),
  });
  return {
    docs: q.data?.docs ?? NO_LINKING,
    loading: q.isLoading,
    error: q.error,
  };
}

// The daemon's search hits for `query` (titles, headings and text); none while it is empty.
export function useDocSearch(
  client: ApiClient | null,
  port: number | undefined,
  query: string,
  limit: number
): DocHit[] {
  const q = useQuery({
    queryKey: [...docsKey(port), 'search', query, limit],
    enabled: client !== null && query !== '',
    queryFn: () => ready(client).searchDocs(query, { limit }),
  });
  return q.data?.hits ?? NO_HITS;
}

// A doc's numbered revisions, newest first, as the history panel and the merge
// view's labels read them.
export function useDocRevisions(
  client: ApiClient | null,
  port: number | undefined,
  ref: string
) {
  const q = useQuery({
    queryKey: [...docsKey(port), 'revisions', ref],
    enabled: client !== null,
    queryFn: () =>
      ready(client).listDocRevisions(ref, { limit: HISTORY_LIMIT }),
  });
  return { revisions: q.data?.revisions ?? NO_REVISIONS, error: q.error };
}

// The daemon's line diff from one revision to another; idle until both are picked.
export function useDocDiff(
  client: ApiClient | null,
  port: number | undefined,
  ref: string,
  pair: { from: string | number; to: string | number } | null
) {
  const q = useQuery({
    queryKey: [...docsKey(port), 'diff', ref, pair?.from, pair?.to],
    enabled: client !== null && pair !== null,
    queryFn: () => ready(client).diffDoc(ref, pair?.from ?? '', pair?.to ?? ''),
  });
  return { diff: q.data ?? null, loading: q.isLoading, error: q.error };
}

// The proposals still waiting on a gate for one doc, oldest first as listed.
export function useOpenDocProposals(
  client: ApiClient | null,
  port: number | undefined,
  doc: string | null
): DocProposal[] {
  const q = useQuery({
    queryKey: [...docsKey(port), 'proposals', doc],
    enabled: client !== null && doc !== null,
    queryFn: () =>
      ready(client).listDocProposals({ doc: doc ?? '', state: ['open'] }),
  });
  return q.data?.proposals ?? NO_PROPOSALS;
}
