import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  Asterisk,
  Bot,
  Diamond,
  Download,
  FolderOpen,
  Gem,
  GitCompare,
  SquareArrowOutUpRight,
  Triangle,
} from 'lucide-react';
import { useState } from 'react';

import { StatTile } from '../components/ui/StatTile';
import { agentMeta } from '../lib/agents';
import { sessionDisplayName } from '../lib/format';
import {
  exportTranscript,
  getSessionDetail,
  openInEditor,
  revealInFinder,
} from '../lib/tauri';
import type { FileChanged, Session } from '../lib/types';
import { DiffModal } from './DiffModal';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/ui/dialog';
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

/** `tags` is stored as a JSON array string (e.g. `["bugfix","refactor"]`); fall back to
 * treating the raw string as a single tag if it doesn't parse, rather than hiding it. */
function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
    return [tags];
  } catch {
    return [tags];
  }
}

/** Maps an agent id to a lucide icon — the legacy `agentMeta().icon` is a unicode glyph
 * (`✳`/`◆`/`◈`/`▲`) which this view replaces with an equivalent lucide icon rather than
 * rendering raw unicode, per the redesign's "no unicode glyphs" rule. Kept local to this
 * file (and duplicated in `ReportView`) rather than added to `lib/agents.ts`, which is out
 * of scope for this pass. */
function AgentIcon({
  agentId,
  className,
}: {
  agentId: string;
  className?: string;
}) {
  switch (agentId) {
    case 'claude':
      return <Asterisk className={className} />;
    case 'codex':
      return <Diamond className={className} />;
    case 'gemini':
      return <Gem className={className} />;
    case 'cursor':
      return <Triangle className={className} />;
    default:
      return <Bot className={className} />;
  }
}

function statusDotClass(status: Session['status']): string {
  return status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/50';
}

function handleOpenInEditor(path: string) {
  openInEditor(path).catch((err) => {
    console.error(`Failed to open ${path} in editor:`, err);
  });
}

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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-medium">{title}</DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
        {isError && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertCircle className="text-destructive size-5" />
            <p className="text-muted-foreground text-[13px]">
              Couldn&rsquo;t load this session.
            </p>
          </div>
        )}
        {!isLoading && !isError && !data && (
          <p className="text-muted-foreground text-[13px]">
            This session no longer exists.
          </p>
        )}
        {data && <SessionDetailContent detail={data} />}
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
  const [exportState, setExportState] = useState<
    | { status: 'idle' }
    | { status: 'saving' }
    | { status: 'saved'; path: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const agent = agentMeta(session.agent);
  const sessionLabel = `${agent.label} · ${session.id.slice(0, 8)}`;

  async function handleExportTranscript() {
    setExportState({ status: 'saving' });
    try {
      const path = await exportTranscript(session.id);
      setExportState({ status: 'saved', path });
    } catch (e) {
      setExportState({ status: 'error', message: String(e) });
    }
  }

  const durationDisplay =
    session.status === 'ended' && session.duration_seconds !== null
      ? `${session.duration_seconds}s`
      : '—';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <span
            className={`size-1.5 rounded-full ${statusDotClass(session.status)}`}
            aria-hidden="true"
          />
          {session.status}
        </span>
        <Badge variant="secondary" className="gap-1">
          <AgentIcon agentId={session.agent} className="size-3" />
          {agent.label}
        </Badge>
        <span className="text-muted-foreground font-mono text-[11px]">
          {session.model ?? 'unknown model'}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleExportTranscript()}
          disabled={exportState.status === 'saving'}
        >
          <Download className="size-3.5" />
          {exportState.status === 'saving' ? 'Exporting…' : 'Export transcript'}
        </Button>
        {exportState.status === 'saved' && (
          <span className="text-muted-foreground inline-flex items-center gap-2 text-[13px]">
            Saved to {exportState.path}
            <button
              className="text-primary inline-flex items-center gap-1 text-[11px] hover:underline"
              onClick={() => void revealInFinder(exportState.path)}
            >
              <FolderOpen className="size-3" />
              Reveal in Finder
            </button>
          </span>
        )}
        {exportState.status === 'error' && (
          <span className="text-destructive text-[13px]">
            {exportState.message}
          </span>
        )}
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatTile value={durationDisplay} label="Duration" />
        <StatTile value={`$${session.cost_usd.toFixed(2)}`} label="Cost" />
        <StatTile value={session.prompt_tokens} label="Prompt tokens" />
        <StatTile value={session.completion_tokens} label="Completion tokens" />
        <StatTile value={session.cache_read_tokens} label="Cache read tokens" />
        <StatTile
          value={session.cache_creation_tokens}
          label="Cache creation tokens"
        />
        <StatTile value={session.lines_added} label="Lines added" />
        <StatTile value={session.lines_removed} label="Lines removed" />
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <p className="text-muted-foreground text-[13px]">
        {session.summary ?? 'No summary yet'}
      </p>

      <div className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Files changed ({groupedFiles.length})
        </h3>
        {groupedFiles.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            No file changes recorded.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {groupedFiles.map((file) => (
              <li
                key={file.file_path}
                className="border-border flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground truncate font-mono text-[13px]">
                    {file.file_path}
                  </span>
                  <span className="text-muted-foreground text-[11px]">
                    {file.edit_count > 1
                      ? `${file.edit_count} edits`
                      : '1 edit'}{' '}
                    · +{file.lines_added} / -{file.lines_removed}
                  </span>
                </div>
                <div className="flex flex-shrink-0 gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setDiffPath(file.file_path)}
                  >
                    <GitCompare className="size-3.5" />
                    View diff
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleOpenInEditor(file.file_path)}
                  >
                    <SquareArrowOutUpRight className="size-3.5" />
                    Open
                  </Button>
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
