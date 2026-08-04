import type {
  ApiClient,
  DiffResult,
  PrDetail,
  PrReviewEvent,
} from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

export interface RepoPrDetailData {
  prDetail: PrDetail | undefined;
  prDetailLoading: boolean;
  prDetailError: string | null;
  prDiff: DiffResult | undefined;
  prDiffLoading: boolean;
  /** Why the diff fetch failed. A PR whose diff never arrived must not read
   *  as a PR with nothing in it. */
  prDiffError: string | null;
  handleReview: (event: PrReviewEvent, body?: string) => Promise<void>;
  handleComment: (body: string) => Promise<void>;
}

/**
 * The in-app review surface for a repo PR dispatch never opened itself
 * ("Other open PRs") — mirrors useDispatchProject's own run-PR
 * prDetail/handlePrReview/handlePrComment exactly, but keyed by PR *number*
 * against the URL-driven server endpoints (`GET/POST /api/prs/:number/…`)
 * instead of a run id, since these rows have no run at all.
 *
 * Kept as its own small hook rather than folded into useDispatchProject:
 * `number` comes from ReviewView's own `selectedPrNumber` state (view-local —
 * there's no run for nav's run-keyed `activeRunId` to point at), and
 * useDispatchProject is instantiated once up in App.tsx, above where that
 * selection lives. `client` is threaded in from the same
 * `DispatchProjectData` every other PR call already uses; `client.baseUrl`
 * (rather than the dispatchd port useDispatchProject keys its own queries
 * on, which isn't exposed on `DispatchProjectData`) is what scopes this
 * hook's cache per-project.
 */
export function useRepoPrDetail(
  client: ApiClient | null,
  number: number | null
): RepoPrDetailData {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ['dispatch-repo-pr-detail', client?.baseUrl, number],
    [client, number]
  );

  const {
    data: prDetail,
    isLoading: prDetailLoading,
    error: prDetailErrorDetail,
  } = useQuery({
    queryKey,
    queryFn: () => {
      if (client === null || number === null) {
        throw new Error('no repo PR selected');
      }
      return client.fetchRepoPrDetail(number);
    },
    enabled: client !== null && number !== null,
    retry: false,
  });
  const prDetailError =
    prDetailErrorDetail instanceof Error ? prDetailErrorDetail.message : null;

  const {
    data: prDiff,
    isLoading: prDiffLoading,
    error: prDiffErrorDetail,
  } = useQuery({
    queryKey: ['dispatch-repo-pr-diff', client?.baseUrl, number],
    queryFn: () => {
      if (client === null || number === null) {
        throw new Error('no repo PR selected');
      }
      return client.fetchRepoPrDiff(number);
    },
    enabled: client !== null && number !== null,
    retry: false,
  });
  const prDiffError =
    prDiffErrorDetail instanceof Error ? prDiffErrorDetail.message : null;

  // Submitting a review or a comment returns the refreshed PrDetail, which we
  // write straight into this query's cache — same one-round-trip pattern as
  // useDispatchProject's handlePrReview/handlePrComment.
  const handleReview = useCallback(
    async (event: PrReviewEvent, body?: string): Promise<void> => {
      if (client === null || number === null) return;
      const detail = await client.reviewRepoPr(number, event, body);
      queryClient.setQueryData(queryKey, detail);
    },
    [client, number, queryClient, queryKey]
  );

  const handleComment = useCallback(
    async (body: string): Promise<void> => {
      if (client === null || number === null) return;
      const detail = await client.commentRepoPr(number, body);
      queryClient.setQueryData(queryKey, detail);
    },
    [client, number, queryClient, queryKey]
  );

  return {
    prDetail,
    prDetailLoading,
    prDetailError,
    prDiff,
    prDiffLoading,
    prDiffError,
    handleReview,
    handleComment,
  };
}
