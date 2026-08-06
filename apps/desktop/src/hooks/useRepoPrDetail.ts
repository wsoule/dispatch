import type {
  ApiClient,
  DiffResult,
  PrDetail,
  PrReviewEvent,
  ReviewComment,
} from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { repoPrsKey } from './useDispatchProject';

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
  /** This PR's line comments, GitHub's merged with any local drafts. */
  reviewComments: ReviewComment[];
  /** Why the comment sync failed. An empty thread list must not read as
   *  "nobody has commented" when the pull never landed. */
  reviewCommentsError: string | null;
  handleAddReviewComment: (input: {
    file: string;
    line: number;
    startLine?: number;
    anchorText: string;
    body: string;
  }) => Promise<void>;
  handleResolveReviewComment: (
    commentId: string,
    resolved: boolean
  ) => Promise<void>;
  handleReplyReviewComment: (commentId: string, body: string) => Promise<void>;
}

// One shared empty list so a PR with no comments (or none fetched yet) hands
// its consumers a stable identity instead of a new array every render.
const NO_COMMENTS: ReviewComment[] = [];

/**
 * The in-app review surface for a repo PR dispatch never opened itself
 * ("Other open PRs") — mirrors useDispatchProject's own run-PR
 * prDetail/handlePrReview/handlePrComment, plus its line-comment trio, but
 * keyed by PR *number* against the URL-driven server endpoints
 * (`GET/POST /api/prs/:number/…`) instead of a run id, since these rows have
 * no run at all. Line comments here are the same store the run side uses,
 * mirrored to and from GitHub rather than kept on local disk.
 *
 * Kept as its own small hook rather than folded into useDispatchProject:
 * `number` comes from ReviewView's own `selectedPrNumber` state (view-local —
 * there's no run for nav's run-keyed `activeRunId` to point at), and
 * useDispatchProject is instantiated once up in App.tsx, above where that
 * selection lives. `client` is threaded in from the same
 * `DispatchProjectData` every other PR call already uses, and `client.baseUrl`
 * is what scopes this hook's own cache per-project. `port` is only here to
 * name useDispatchProject's repo-PRs query, which every review action has to
 * invalidate — the queue rows and this PR's status come from that one fetch.
 */
export function useRepoPrDetail(
  client: ApiClient | null,
  port: number | undefined,
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

  const commentsKey = useMemo(
    () => ['dispatch-repo-pr-comments', client?.baseUrl, number],
    [client, number]
  );

  // GET /api/prs/:number/comments is not a local read: it pulls GitHub's
  // comments, merges them with local drafts and tags each with its review
  // thread — four `gh` round trips — so this has no poll of its own.
  // Nothing broadcasts `review.changed` for a PR target either, so the
  // list is kept fresh by re-pulling at the two moments it can be wrong:
  // whenever this query mounts (`staleTime: 0` overrides main.tsx's shared
  // 30s, which would otherwise serve a stale list to a reviewer reopening the
  // PR inside that window), and after every mutation below.
  //
  // Focus refetch is off even so: `staleTime: 0` would otherwise re-arm it,
  // and firing this whole sync on every alt-tab back buys nothing the
  // per-mutation reload does not already cover.
  const {
    data: reviewComments,
    error: reviewCommentsErrorDetail,
    refetch: refetchComments,
  } = useQuery({
    queryKey: commentsKey,
    queryFn: () => {
      if (client === null || number === null) {
        throw new Error('no repo PR selected');
      }
      return client.fetchReviewComments({ kind: 'pr', number });
    },
    enabled: client !== null && number !== null,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const reviewCommentsError =
    reviewCommentsErrorDetail instanceof Error
      ? reviewCommentsErrorDetail.message
      : null;

  // Refetch rather than invalidate: a comment write is followed by a GitHub
  // pull that must actually happen, and an invalidated query with no mounted
  // observer would only mark itself stale.
  const reloadComments = useCallback(() => {
    void refetchComments();
  }, [refetchComments]);

  // Submitting a review pushes every pending line comment as part of it —
  // one GitHub review, via POST /api/prs/:number/review-submit, never also
  // reviewRepoPr's `gh pr review` one-shot, which would post a second.
  // It returns only a count, so the PR's own detail is refetched rather than
  // written straight into the cache the way handleComment below still can.
  //
  // The repo-PRs list is invalidated too — it holds its own copy of this PR's
  // decision and checks, and on a 60s poll would contradict what you just did.
  const handleReview = useCallback(
    async (event: PrReviewEvent, body?: string): Promise<void> => {
      if (client === null || number === null) return;
      await client.pushPrReview(number, event, body ?? '');
      void queryClient.invalidateQueries({ queryKey });
      reloadComments();
      void queryClient.invalidateQueries({ queryKey: repoPrsKey(port) });
    },
    [client, number, port, queryClient, queryKey, reloadComments]
  );

  const handleComment = useCallback(
    async (body: string): Promise<void> => {
      if (client === null || number === null) return;
      const detail = await client.commentRepoPr(number, body);
      queryClient.setQueryData(queryKey, detail);
      void queryClient.invalidateQueries({ queryKey: repoPrsKey(port) });
    },
    [client, number, port, queryClient, queryKey]
  );

  // The composer's three verbs, keyed by PR target instead of a run id. Add
  // is local-only until handleReview publishes the batch; resolve and reply
  // go straight to GitHub, so both need the comment to exist there already.
  const handleAddReviewComment = useCallback(
    async (input: {
      file: string;
      line: number;
      startLine?: number;
      anchorText: string;
      body: string;
    }): Promise<void> => {
      if (client === null || number === null) return;
      await client.addReviewComment({ kind: 'pr', number }, input);
      reloadComments();
    },
    [client, number, reloadComments]
  );

  const handleResolveReviewComment = useCallback(
    async (commentId: string, resolved: boolean): Promise<void> => {
      if (client === null || number === null) return;
      await client.resolveReviewComment(
        { kind: 'pr', number },
        commentId,
        resolved
      );
      reloadComments();
    },
    [client, number, reloadComments]
  );

  const handleReplyReviewComment = useCallback(
    async (commentId: string, body: string): Promise<void> => {
      if (client === null || number === null) return;
      await client.replyReviewComment({ kind: 'pr', number }, commentId, body);
      reloadComments();
    },
    [client, number, reloadComments]
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
    reviewComments: reviewComments ?? NO_COMMENTS,
    reviewCommentsError,
    handleAddReviewComment,
    handleResolveReviewComment,
    handleReplyReviewComment,
  };
}
