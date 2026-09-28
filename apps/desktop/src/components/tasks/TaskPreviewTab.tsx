import type {
  RunMeta,
  RunPreview,
  RunPreviewReason,
  RunPreviewResult,
} from '@dispatch/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorPlay, RotateCw } from 'lucide-react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { isTeamLocalPage } from '../../lib/teamLocal';
import { TabSkeleton } from './TabSkeleton';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';

export interface TaskPreviewTabProps {
  data: Pick<DispatchProjectData, 'client' | 'port' | 'daemonBaseUrl'>;
  selectedRun: RunMeta | undefined;
}

/**
 * The sandbox a preview frame runs under.
 *
 * `allow-same-origin` is deliberately absent, and this is load-bearing rather
 * than cautious: the preview is served from the daemon's own origin, the
 * daemon injects its agent token into the HTML it serves at `/`, and the
 * daemon trusts every loopback origin — so same-origin preview script could
 * fetch `/`, scrape that token and drive the API. Without the flag the frame
 * gets an opaque origin and can do none of it. See proxyPreview's note in
 * packages/server/src/index.ts.
 *
 * `allow-scripts` is what makes the preview a preview; `allow-forms` and
 * `allow-popups` keep ordinary app interactions working inside it.
 */
const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups';

/**
 * The sandbox for a teammate's preview on a team-local daemon, which frames
 * the gateway's link (packages/server/src/previewGateway.ts) instead.
 *
 * Here `allow-same-origin` is right, not a slip. That preview has an origin of
 * its own — its own port — so being same-origin with itself grants it nothing
 * of the daemon's: not the page's storage, not the session cookie (HttpOnly),
 * and its requests to the daemon are cross-origin, which the daemon refuses.
 * What the flag does grant is its own cookie, which is how the gateway lets
 * the frame's scripts, styles and images in; without it every one of them
 * would be refused.
 */
const REMOTE_PREVIEW_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-same-origin';

/**
 * The first value seen for `key`, held until `key` changes.
 *
 * A teammate's preview link carries a fresh grant every time it is fetched,
 * so the URL differs on each refetch; framing the latest one would reload the
 * app under review on every poll, focus and presence event. Held per preview
 * instance instead — the gateway's cookie carries access after the first load.
 */
function useHeldValue(key: string, value: string | undefined) {
  const [held, setHeld] = useState<{ key: string; value: string } | null>(null);
  if (value !== undefined && held?.key !== key) {
    setHeld({ key, value });
  }
  return held?.key === key ? held.value : value;
}

/** What each refusal means to someone looking at this tab. `no-command` is by
 *  far the common one — most repos are not web apps — so it reads as a plain
 *  fact rather than a fault. */
const REFUSAL_COPY: Record<
  RunPreviewReason,
  { heading: string; body: string }
> = {
  'no-command': {
    heading: 'Nothing to preview',
    body: 'This project has no dev script to run. Set preview.command in .dispatch/config.yml to point at one.',
  },
  disabled: {
    heading: 'Previews are off',
    body: 'Set preview.enabled to true in .dispatch/config.yml to turn them back on.',
  },
  'no-worktree': {
    heading: 'Worktree is gone',
    body: 'This run has been merged or discarded, so there is no checkout left to run.',
  },
};

/**
 * The task view's Preview tab: the selected run's work as a running app rather
 * than a diff.
 *
 * Starting is an explicit action, never automatic on opening the tab. A dev
 * server costs an install and a boot, and a reviewer who wanted the diff
 * should not pay for one — so the tab opens on a button and the daemon starts
 * nothing until it is pressed.
 */
export function TaskPreviewTab({ data, selectedRun }: TaskPreviewTabProps) {
  const queryClient = useQueryClient();
  const { client } = data;
  const runId = selectedRun?.id;
  const queryKey = ['dispatch-run-preview', data.port, runId];

  // Both `client` and `runId` are consts, so every callback below narrows
  // them itself rather than asserting past the nulls — the daemon may not
  // have resolved yet, and the tab renders before a run is selected.
  const nothing: RunPreviewResult = { preview: null };

  // Bumped by Reload: remounts the frame and, for a teammate, takes a fresh
  // link rather than the one held above.
  const [reloads, setReloads] = useState(0);

  const { data: result, isLoading } = useQuery({
    queryKey,
    enabled: client !== null && runId !== undefined,
    queryFn: () =>
      client === null || runId === undefined
        ? nothing
        : client.fetchRunPreview(runId),
    // A preview that is still coming up changes without anything here acting,
    // so poll while it does and stop once it has settled.
    refetchInterval: (query) =>
      query.state.data?.preview?.status === 'starting' ? 1000 : false,
  });

  const start = useMutation({
    mutationFn: () =>
      client === null || runId === undefined
        ? Promise.resolve(nothing)
        : client.startRunPreview(runId),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });
  const stop = useMutation({
    mutationFn: () =>
      client === null || runId === undefined
        ? Promise.resolve()
        : client.stopRunPreview(runId),
    onSuccess: () => queryClient.setQueryData(queryKey, nothing),
  });

  const teamLocal = isTeamLocalPage();
  const livePreview = result?.preview ?? null;
  const remoteSrc = useHeldValue(
    `${livePreview?.runId}@${livePreview?.startedAt}#${reloads}`,
    livePreview?.remoteUrl
  );

  if (selectedRun === undefined) {
    return (
      <EmptyState
        icon={MonitorPlay}
        heading="No session yet"
        description="Dispatch the task to get something to preview."
        className="h-full justify-center"
      />
    );
  }
  if (isLoading) return <TabSkeleton />;

  const preview: RunPreview | null = result?.preview ?? null;
  const refusal = start.data?.reason ?? result?.reason;

  if (preview === null) {
    const copy = refusal === undefined ? null : REFUSAL_COPY[refusal];
    return (
      <EmptyState
        icon={MonitorPlay}
        heading={copy?.heading ?? 'No preview running'}
        description={
          copy?.body ??
          "Start this run's dev server to see its work as a running app."
        }
        className="h-full justify-center"
        primary={
          // A refusal is not retryable by pressing the same button again —
          // the config or the worktree has to change first.
          copy === null
            ? {
                label: start.isPending ? 'Starting…' : 'Start preview',
                onClick: () => start.mutate(),
              }
            : undefined
        }
      />
    );
  }

  if (preview.status === 'failed') {
    return (
      <EmptyState
        icon={MonitorPlay}
        heading="Preview failed to start"
        description={preview.error ?? `\`${preview.command}\` did not come up.`}
        className="h-full justify-center"
        primary={{
          label: start.isPending ? 'Retrying…' : 'Try again',
          onClick: () => start.mutate(),
        }}
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border-chip flex items-center gap-2 border-b px-3 py-1.5">
        <span className="text-text-secondary truncate font-mono text-[11px]">
          {preview.command}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setReloads((n) => n + 1);
              void queryClient.invalidateQueries({ queryKey });
            }}
            aria-label="Reload preview"
          >
            <RotateCw aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => stop.mutate()}>
            Stop
          </Button>
        </div>
      </div>
      {preview.status === 'starting' ? (
        <TabSkeleton />
      ) : teamLocal && remoteSrc === undefined ? (
        // A daemon from before teammate previews, or one bound to loopback
        // that served this page anyway: nothing a teammate's browser can
        // reach, said plainly rather than as a frame full of 403.
        <EmptyState
          icon={MonitorPlay}
          heading="This preview is only on the host's machine"
          description="The daemon did not offer a link teammates can open. Review the diff here, or ask them to share the run."
          className="h-full justify-center"
        />
      ) : (
        <iframe
          // Keyed on the run so switching sessions remounts the frame rather
          // than leaving the previous run's app on screen under a new label,
          // and on Reload so pressing it actually reloads.
          key={`${preview.runId}#${reloads}`}
          title="Run preview"
          src={
            teamLocal ? remoteSrc : `${data.daemonBaseUrl ?? ''}${preview.url}`
          }
          sandbox={teamLocal ? REMOTE_PREVIEW_SANDBOX : PREVIEW_SANDBOX}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}
