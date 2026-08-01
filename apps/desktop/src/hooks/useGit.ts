import type {
  ApiClient,
  GitBranchWithRun,
  GitLogEntry,
  GitOutcome,
  GitStash,
  GitStatus,
} from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

// Shared first element of every Git page query key, so `git.changed` can invalidate them all
// in one call via TanStack's array-prefix matching.
const GIT_QUERY_ROOT = 'dispatch-git';

export function gitStatusKey(port: number | undefined) {
  return [GIT_QUERY_ROOT, 'status', port] as const;
}
export function gitBranchesKey(port: number | undefined) {
  return [GIT_QUERY_ROOT, 'branches', port] as const;
}
export function gitLogKey(port: number | undefined, ref: string | null) {
  return [GIT_QUERY_ROOT, 'log', port, ref] as const;
}
export function gitStashesKey(port: number | undefined) {
  return [GIT_QUERY_ROOT, 'stashes', port] as const;
}
export function gitDiffKey(
  port: number | undefined,
  staged: boolean,
  path: string | null
) {
  return [GIT_QUERY_ROOT, 'diff', port, staged, path] as const;
}
export function gitCommitDiffKey(port: number | undefined, sha: string | null) {
  return [GIT_QUERY_ROOT, 'commit-diff', port, sha] as const;
}
/** The prefix every Git page query key shares — pass this to `invalidateQueries` to refresh
 * all of them at once on a `git.changed` event. */
export const gitQueryRootKey = [GIT_QUERY_ROOT] as const;

export interface GitWorkingDiffTarget {
  staged: boolean;
  path?: string;
}

export interface UseGitOptions {
  client: ApiClient | null;
  port: number | undefined;
  /** Which branch's commit log to show. `null` shows HEAD's. */
  logRef: string | null;
  /** The working-tree diff to fetch for the right pane, or `null` to skip. Mutually exclusive
   * with `commitSha` — the view only ever wants one of the two at a time. */
  workingDiffTarget: GitWorkingDiffTarget | null;
  /** A single commit's diff to fetch instead of a working-tree diff. */
  commitSha: string | null;
}

export interface GitActions {
  stage: (paths: string[]) => Promise<GitOutcome>;
  unstage: (paths: string[]) => Promise<GitOutcome>;
  stageHunk: (patch: string) => Promise<GitOutcome>;
  unstageHunk: (patch: string) => Promise<GitOutcome>;
  discard: (paths: string[]) => Promise<GitOutcome>;
  commit: (
    message: string,
    opts?: { amend?: boolean }
  ) => Promise<GitOutcome<{ sha: string }>>;
  generateCommitMessage: () => Promise<{ message: string }>;
  checkout: (branch: string) => Promise<GitOutcome>;
  createBranch: (name: string, from?: string) => Promise<GitOutcome>;
  deleteBranch: (
    name: string,
    opts?: { force?: boolean }
  ) => Promise<GitOutcome>;
  stashPush: (message?: string) => Promise<GitOutcome>;
  stashPop: (index: number) => Promise<GitOutcome>;
  stashDrop: (index: number) => Promise<GitOutcome>;
  fetch: (remote?: string) => Promise<GitOutcome>;
  pull: () => Promise<GitOutcome>;
  push: (opts?: { setUpstream?: boolean }) => Promise<GitOutcome>;
  cherryPick: (sha: string) => Promise<GitOutcome>;
  revert: (sha: string) => Promise<GitOutcome>;
}

export interface UseGitResult {
  status: GitStatus | undefined;
  statusLoading: boolean;
  branches: GitBranchWithRun[];
  branchesLoading: boolean;
  log: GitLogEntry[];
  logLoading: boolean;
  stashes: GitStash[];
  stashesLoading: boolean;
  /** The working-tree diff patch for `workingDiffTarget`, when one was requested. */
  workingDiff: string | undefined;
  workingDiffLoading: boolean;
  /** The diff patch for `commitSha`, when one was requested. */
  commitDiff: string | undefined;
  commitDiffLoading: boolean;
  actions: GitActions;
  /** Invalidates every Git page query at once — the manual "Refresh" affordance, for git
   * state that changed outside the app (e.g. a terminal `git` command). */
  refetchAll: () => Promise<void>;
}

/** Owns every read for the Git page plus thin action wrappers; mutations rely on `git.changed`
 * (handled in `useDispatchProject`'s WS effect) to refetch, not on invalidating themselves. */
export function useGit({
  client,
  port,
  logRef,
  workingDiffTarget,
  commitSha,
}: UseGitOptions): UseGitResult {
  const queryClient = useQueryClient();

  const { data: statusResult, isLoading: statusLoading } = useQuery({
    queryKey: gitStatusKey(port),
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchGitStatus();
    },
    enabled: client !== null,
  });

  const { data: branchesResult, isLoading: branchesLoading } = useQuery({
    queryKey: gitBranchesKey(port),
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchGitBranches();
    },
    enabled: client !== null,
  });

  const { data: logResult, isLoading: logLoading } = useQuery({
    queryKey: gitLogKey(port, logRef),
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchGitLog({ ref: logRef ?? undefined, limit: 200 });
    },
    enabled: client !== null,
  });

  const { data: stashesResult, isLoading: stashesLoading } = useQuery({
    queryKey: gitStashesKey(port),
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchGitStashList();
    },
    enabled: client !== null,
  });

  const { data: workingDiffResult, isLoading: workingDiffLoading } = useQuery({
    queryKey: gitDiffKey(
      port,
      workingDiffTarget?.staged ?? false,
      workingDiffTarget?.path ?? null
    ),
    queryFn: () => {
      if (client === null || workingDiffTarget === null) {
        throw new Error('no diff requested');
      }
      return client.fetchGitDiff(workingDiffTarget);
    },
    enabled: client !== null && workingDiffTarget !== null,
  });

  const { data: commitDiffResult, isLoading: commitDiffLoading } = useQuery({
    queryKey: gitCommitDiffKey(port, commitSha),
    queryFn: () => {
      if (client === null || commitSha === null) {
        throw new Error('no commit selected');
      }
      return client.fetchGitCommitDiff(commitSha);
    },
    enabled: client !== null && commitSha !== null,
  });

  const requireClient = useCallback((): ApiClient => {
    if (client === null) throw new Error('dispatchd client not ready');
    return client;
  }, [client]);

  const actions: GitActions = {
    stage: useCallback(
      (paths) => requireClient().gitStage(paths),
      [requireClient]
    ),
    unstage: useCallback(
      (paths) => requireClient().gitUnstage(paths),
      [requireClient]
    ),
    stageHunk: useCallback(
      (patch) => requireClient().gitStageHunk(patch),
      [requireClient]
    ),
    unstageHunk: useCallback(
      (patch) => requireClient().gitUnstageHunk(patch),
      [requireClient]
    ),
    discard: useCallback(
      (paths) => requireClient().gitDiscard(paths, true),
      [requireClient]
    ),
    commit: useCallback(
      (message, opts) => requireClient().gitCommit(message, opts),
      [requireClient]
    ),
    generateCommitMessage: useCallback(
      () => requireClient().generateCommitMessage(),
      [requireClient]
    ),
    checkout: useCallback(
      (branch) => requireClient().gitCheckout(branch),
      [requireClient]
    ),
    createBranch: useCallback(
      (name, from) => requireClient().gitCreateBranch(name, from),
      [requireClient]
    ),
    deleteBranch: useCallback(
      (name, opts) =>
        requireClient().gitDeleteBranch(name, {
          force: opts?.force,
          confirm: opts?.force === true ? true : undefined,
        }),
      [requireClient]
    ),
    stashPush: useCallback(
      (message) => requireClient().gitStashPush(message),
      [requireClient]
    ),
    stashPop: useCallback(
      (index) => requireClient().gitStashPop(index),
      [requireClient]
    ),
    stashDrop: useCallback(
      (index) => requireClient().gitStashDrop(index, true),
      [requireClient]
    ),
    fetch: useCallback(
      (remote) => requireClient().gitFetch(remote),
      [requireClient]
    ),
    pull: useCallback(() => requireClient().gitPull(), [requireClient]),
    push: useCallback((opts) => requireClient().gitPush(opts), [requireClient]),
    cherryPick: useCallback(
      (sha) => requireClient().gitCherryPick(sha),
      [requireClient]
    ),
    revert: useCallback(
      (sha) => requireClient().gitRevert(sha),
      [requireClient]
    ),
  };

  const refetchAll = useCallback(
    () => queryClient.invalidateQueries({ queryKey: gitQueryRootKey }),
    [queryClient]
  );

  return {
    status: statusResult?.ok === true ? statusResult : undefined,
    statusLoading,
    branches: branchesResult?.ok === true ? branchesResult.branches : [],
    branchesLoading,
    log: logResult?.ok === true ? logResult.commits : [],
    logLoading,
    stashes: stashesResult?.ok === true ? stashesResult.stashes : [],
    stashesLoading,
    workingDiff:
      workingDiffResult?.ok === true ? workingDiffResult.patch : undefined,
    workingDiffLoading,
    commitDiff:
      commitDiffResult?.ok === true ? commitDiffResult.patch : undefined,
    commitDiffLoading,
    actions,
    refetchAll,
  };
}
