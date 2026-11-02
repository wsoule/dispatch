import { useQuery } from '@tanstack/react-query';
import { GitCompare, OctagonAlert, SquareArrowOutUpRight } from 'lucide-react';
import { useState } from 'react';

import { agentMeta } from '../../lib/agents';
import { sessionDisplayName } from '../../lib/format';
import { modelDisplayName } from '../../lib/models';
import {
  exportTranscript,
  getSessionDetail,
  openInEditor,
} from '../../lib/tauri';
import type { FileChanged } from '../../lib/types';
import { DiffModal } from '../../views/DiffModal';
import { ErrorBoundary } from '../shell/ErrorBoundary';
import { AgentIcon } from './AgentIcon';
import { ExportControl } from './ExportControl';
import {
  cacheHitRateDisplay,
  parseTags,
  statusDotClass,
} from './sessionDisplay';
import { Pill, PillButton } from '@/ui/ai/pill';
import { EmptyState, SectionLabel } from '@/ui/chrome';
import { StatTile } from '@/ui/chrome/StatTile';
import {
  Dialog,
  DialogBody,
  DialogChrome,
  DialogContent,
  DialogTitle,
} from '@/ui/dialog';
import { Skeleton } from '@/ui/skeleton';

interface GroupedFileChange {
  file_path: string;
  lines_added: number;
  lines_removed: number;
  edit_count: number;
}

/** Collapses one row per tool-call edit into one row per file — a file touched by several
 * edits in the same session (a common pattern: write, then a couple of follow-up edits)
 * otherwise shows up as several identical-looking rows. Lines are summed across every edit;
 * "View diff" then shows the cumulative before/after span (see `DiffModal`). Order is
 * first-touched-first, matching `files_changed`'s existing `occurred_at ASC` ordering. */
function groupFilesChanged(files: FileChanged[]): GroupedFileChange[] {
  const order: string[] = [];
  const byPath = new Map<string, GroupedFileChange>();

  for (const file of files) {
    const existing = byPath.get(file.file_path);
    if (existing) {
      existing.lines_added += file.lines_added;
      existing.lines_removed += file.lines_removed;
      existing.edit_count += 1;
    } else {
      byPath.set(file.file_path, {
        file_path: file.file_path,
        lines_added: file.lines_added,
        lines_removed: file.lines_removed,
        edit_count: 1,
      });
      order.push(file.file_path);
    }
  }

  return order.map((path) => byPath.get(path));
}

interface SessionDetailModalProps {
  sessionId: string | null;
  onClose: () => void;
}

function handleOpenInEditor(path: string) {
  openInEditor(path).catch((err) => {
    console.error(`Failed to open ${path} in editor:`, err);
  });
}

/**
 * Full session detail dialog — status/agent/model, an export-transcript action, the stat
 * grid (duration/cost/tokens/lines), tags, summary, and the per-file change list (each file
 * openable in the editor or as a diff via `DiffModal`). Used by the Sessions hub
 * (`SessionsHubView`), which just passes through a `sessionId` and lets this own the
 * fetch/loading/error states.
 */
export function SessionDetailModal({
  sessionId,
  onClose,
}: SessionDetailModalProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['session-detail', sessionId],
    queryFn: () => getSessionDetail(sessionId),
    enabled: sessionId !== null,
  });

  const title = data
    ? sessionDisplayName(data.session.title, data.session.summary)
    : 'Session detail';

  return (
    <Dialog
      open={sessionId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[85vh] sm:max-w-2xl"
        // Base UI never marks its modal dialogs. Opened from the Usage page in Settings, this
        // one must read as a modal surface to the app's keyboard (isAnyModalOpen), or the
        // app's Escape would also close Settings under it and its bare-key shortcuts would
        // fire behind it. Only while open, so the exit animation no longer mutes shortcuts.
        aria-modal={sessionId !== null ? true : undefined}
      >
        <ErrorBoundary label="this dialog">
          <DialogChrome>Sessions › Session</DialogChrome>
          <DialogBody className="min-h-0 overflow-y-auto pt-0 pb-4">
            <DialogTitle>{title}</DialogTitle>

            {isLoading && (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-6 w-1/3" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}
            {isError && (
              <EmptyState
                icon={OctagonAlert}
                heading="Couldn’t load this session"
              />
            )}
            {!isLoading && !isError && !data && (
              <EmptyState heading="This session no longer exists" />
            )}
            {data && <SessionDetailContent detail={data} />}
          </DialogBody>
        </ErrorBoundary>
      </DialogContent>
    </Dialog>
  );
}

function SessionDetailContent({
  detail,
}: {
  detail: NonNullable<Awaited<ReturnType<typeof getSessionDetail>>>;
}) {
  const { session, files_changed } = detail;
  const tags = parseTags(session.tags);
  const groupedFiles = groupFilesChanged(files_changed);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const agent = agentMeta(session.agent);
  const sessionLabel = `${agent.label} · ${session.id.slice(0, 8)}`;

  const durationDisplay =
    session.status === 'ended' && session.duration_seconds !== null
      ? `${session.duration_seconds}s`
      : '—';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground font-book flex items-center gap-1.5 text-[12px]">
          <span
            className={`size-1.5 rounded-full ${statusDotClass(session.status)}`}
            aria-hidden="true"
          />
          {session.status === 'active' ? 'Active' : 'Ended'}
        </span>
        <Pill>
          <AgentIcon agentId={session.agent} className="size-3" />
          {agent.label}
        </Pill>
        <span className="text-muted-foreground font-book text-[12px]">
          {modelDisplayName(session.model) ?? 'unknown model'}
        </span>
        <div className="ml-auto">
          <ExportControl
            label="Export transcript"
            onExport={() => exportTranscript(session.id)}
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatTile value={durationDisplay} label="Duration" />
        <StatTile value={`$${session.cost_usd.toFixed(2)}`} label="Cost" />
        <StatTile value={session.prompt_tokens} label="Prompt tokens" />
        <StatTile value={session.completion_tokens} label="Completion tokens" />
        <StatTile
          value={session.prompt_tokens + session.completion_tokens}
          label="Total tokens"
        />
        <StatTile value={session.cache_read_tokens} label="Cache read tokens" />
        <StatTile
          value={session.cache_creation_tokens}
          label="Cache creation tokens"
        />
        <StatTile value={cacheHitRateDisplay(session)} label="Cache hit rate" />
        <StatTile value={session.lines_added} label="Lines added" />
        <StatTile value={session.lines_removed} label="Lines removed" />
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Pill key={tag}>{tag}</Pill>
          ))}
        </div>
      )}

      <p className="text-muted-foreground font-book text-[13px]">
        {session.summary ?? 'No summary yet'}
      </p>

      <div className="flex flex-col gap-2">
        <SectionLabel count={groupedFiles.length}>Files changed</SectionLabel>
        {groupedFiles.length === 0 ? (
          <p className="text-muted-foreground font-book text-[13px]">
            No file changes recorded.
          </p>
        ) : (
          <ul className="rounded-card bg-surface-quaternary shadow-card [&>*+*]:shadow-hairline-top flex flex-col overflow-hidden">
            {groupedFiles.map((file) => (
              <li
                key={file.file_path}
                className="flex min-h-9 items-center justify-between gap-3 px-3 py-1.5"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground truncate font-mono text-[12px]">
                    {file.file_path}
                  </span>
                  <span className="text-muted-foreground font-book text-[12px] tabular-nums">
                    {file.edit_count > 1
                      ? `${String(file.edit_count)} edits`
                      : '1 edit'}{' '}
                    · +{file.lines_added} / -{file.lines_removed}
                  </span>
                </div>
                <div className="flex flex-shrink-0 gap-2">
                  <PillButton onClick={() => setDiffPath(file.file_path)}>
                    <GitCompare className="size-3.5" />
                    View diff
                  </PillButton>
                  <PillButton
                    onClick={() => handleOpenInEditor(file.file_path)}
                  >
                    <SquareArrowOutUpRight className="size-3.5" />
                    Open
                  </PillButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <DiffModal
        sessionId={session.id}
        sessionLabel={sessionLabel}
        filePath={diffPath}
        onClose={() => setDiffPath(null)}
      />
    </div>
  );
}
