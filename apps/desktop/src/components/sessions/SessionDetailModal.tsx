import {
  Button,
  Chip,
  EmptyState,
  Register,
  RegisterCell,
  RegisterRow,
  Skeleton,
  SkeletonText,
  SlideOver,
  type StatCell,
  StatsStrip,
} from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { GitCompare, OctagonAlert, SquareArrowOutUpRight } from 'lucide-react';
import { useRef, useState } from 'react';

import { agentMeta } from '../../lib/agents';
import { sessionDisplayName } from '../../lib/format';
import { modelDisplayName } from '../../lib/models';
import {
  exportTranscript,
  getSessionDetail,
  openInEditor,
} from '../../lib/tauri';
import type { FileChanged, Session } from '../../lib/types';
import { DiffModal } from '../../views/DiffModal';
import { ErrorBoundary } from '../shell/ErrorBoundary';
import { AgentIcon } from './AgentIcon';
import { ExportControl } from './ExportControl';
import styles from './SessionDetailModal.module.css';
import {
  cacheHitRateDisplay,
  parseTags,
  sessionStatusTone,
} from './sessionDisplay';

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
 * Full session detail as a modal slide-over — status/agent/model, an export-transcript
 * action, the session totals (duration/cost/tokens/lines), tags, summary, and the per-file
 * change list (each file openable in the editor or as a diff in `DiffModal`, a Dialog that
 * stacks over this panel). Used by the Usage page (`SessionsHubView`), which just passes
 * through a `sessionId` and lets this own the fetch/loading/error states. `modal` makes it
 * aria-modal and a layer of `@dispatch/ui`'s stack, so its Escape closes it alone (never the
 * Settings page under it) and the app's bare-key shortcuts stay muted while it is open.
 */
export function SessionDetailModal({
  sessionId,
  onClose,
}: SessionDetailModalProps) {
  // The SlideOver keeps its body mounted through its slide-out after `sessionId` goes null;
  // the last session shown stays on screen for that exit, instead of the panel flashing
  // "This session no longer exists" (a null id's query is disabled, so it has no data).
  const lastShownId = useRef<string | null>(null);
  if (sessionId !== null) lastShownId.current = sessionId;
  const shownId = sessionId ?? lastShownId.current;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['session-detail', shownId],
    queryFn: () => getSessionDetail(shownId),
    enabled: shownId !== null,
  });

  const title = data
    ? sessionDisplayName(data.session.title, data.session.summary)
    : 'Session detail';

  return (
    <SlideOver
      modal
      open={sessionId !== null}
      onClose={onClose}
      title={title}
      // The trail the panel sits in: the Usage page, then this session.
      breadcrumb={
        <span className={styles.crumb}>
          <span className={styles.crumbRoot}>Usage</span>
          <span aria-hidden="true">›</span>
          <span>Session</span>
        </span>
      }
      contentKey={shownId ?? undefined}
    >
      <ErrorBoundary label="this dialog">
        {/* One labelled skeleton announces the load; the other two shapes are decorative. */}
        {isLoading && (
          <div className={styles.loading}>
            <SkeletonText lines={2} label="Loading session" />
            <Skeleton height={96} className={styles.skeletonBlock} />
            <Skeleton height={120} className={styles.skeletonBlock} />
          </div>
        )}
        {isError && (
          <EmptyState
            icon={<OctagonAlert size={22} strokeWidth={1.8} aria-hidden />}
          >
            Couldn’t load this session
          </EmptyState>
        )}
        {!isLoading && !isError && !data && (
          <EmptyState>This session no longer exists</EmptyState>
        )}
        {data && <SessionDetailContent detail={data} />}
      </ErrorBoundary>
    </SlideOver>
  );
}

/** The ten session-total cells of the StatsStrip, in the order the old stat grid had them. */
function sessionTotals(session: Session): StatCell[] {
  const durationDisplay =
    session.status === 'ended' && session.duration_seconds !== null
      ? `${session.duration_seconds}s`
      : '—';
  return [
    { id: 'duration', label: 'Duration', value: durationDisplay },
    { id: 'cost', label: 'Cost', value: `$${session.cost_usd.toFixed(2)}` },
    { id: 'prompt', label: 'Prompt tokens', value: session.prompt_tokens },
    {
      id: 'completion',
      label: 'Completion tokens',
      value: session.completion_tokens,
    },
    {
      id: 'total',
      label: 'Total tokens',
      value: session.prompt_tokens + session.completion_tokens,
    },
    {
      id: 'cache-read',
      label: 'Cache read tokens',
      value: session.cache_read_tokens,
    },
    {
      id: 'cache-creation',
      label: 'Cache creation tokens',
      value: session.cache_creation_tokens,
    },
    {
      id: 'cache-hit',
      label: 'Cache hit rate',
      value: cacheHitRateDisplay(session),
    },
    { id: 'added', label: 'Lines added', value: session.lines_added },
    { id: 'removed', label: 'Lines removed', value: session.lines_removed },
  ];
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
  const statusTone = sessionStatusTone(session.status);

  return (
    <div className={styles.content}>
      <div className={styles.top}>
        <Chip tone={statusTone} dot={statusTone === 'muted'}>
          {session.status === 'active' ? 'Active' : 'Ended'}
        </Chip>
        <Chip>
          <span className={styles.agent}>
            <AgentIcon agentId={session.agent} />
            {agent.label}
          </span>
        </Chip>
        <span className={styles.model}>
          {modelDisplayName(session.model) ?? 'unknown model'}
        </span>
        <div className={styles.export}>
          <ExportControl
            label="Export transcript"
            onExport={() => exportTranscript(session.id)}
          />
        </div>
      </div>

      <StatsStrip label="Session totals" cells={sessionTotals(session)} />

      {tags.length > 0 && (
        <div className={styles.tags}>
          {tags.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>
      )}

      <p className={styles.summary}>{session.summary ?? 'No summary yet'}</p>

      <section className={styles.files}>
        <h3 className={styles.heading}>
          Files changed{' '}
          <span className={styles.count}>{groupedFiles.length}</span>
        </h3>
        {groupedFiles.length === 0 ? (
          <p className={styles.summary}>No file changes recorded.</p>
        ) : (
          <Register
            label="Files changed"
            columns="minmax(0, 1fr) auto"
            stackBelow={700}
          >
            {groupedFiles.map((file) => (
              <RegisterRow key={file.file_path}>
                <RegisterCell
                  sub={
                    <span className="num">
                      {file.edit_count > 1
                        ? `${String(file.edit_count)} edits`
                        : '1 edit'}{' '}
                      · +{file.lines_added} / -{file.lines_removed}
                    </span>
                  }
                >
                  <span className={styles.path} title={file.file_path}>
                    {file.file_path}
                  </span>
                </RegisterCell>
                <RegisterCell align="end">
                  <span className={styles.actions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={
                        <GitCompare size={14} strokeWidth={1.8} aria-hidden />
                      }
                      onClick={() => setDiffPath(file.file_path)}
                    >
                      View diff
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={
                        <SquareArrowOutUpRight
                          size={14}
                          strokeWidth={1.8}
                          aria-hidden
                        />
                      }
                      onClick={() => handleOpenInEditor(file.file_path)}
                    >
                      Open
                    </Button>
                  </span>
                </RegisterCell>
              </RegisterRow>
            ))}
          </Register>
        )}
      </section>

      <DiffModal
        sessionId={session.id}
        sessionLabel={sessionLabel}
        filePath={diffPath}
        onClose={() => setDiffPath(null)}
      />
    </div>
  );
}
