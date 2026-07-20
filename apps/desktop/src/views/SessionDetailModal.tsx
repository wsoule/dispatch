import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Pill } from '../components/ui/Pill';
import { StatTile } from '../components/ui/StatTile';
import { agentMeta } from '../lib/agents';
import { sessionDisplayName } from '../lib/format';
import {
  exportTranscript,
  getSessionDetail,
  openInEditor,
  revealInFinder,
} from '../lib/tauri';
import type { FileChanged } from '../lib/types';
import { DiffModal } from './DiffModal';
import './SessionDetailModal.css';

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

  if (sessionId === null) {
    return null;
  }

  const title = data
    ? sessionDisplayName(data.session.title, data.session.summary)
    : 'Session detail';

  return (
    <Modal isOpen={sessionId !== null} onClose={onClose} title={title}>
      {isLoading && <p className="session-detail-status">Loading session…</p>}
      {isError && (
        <p className="session-detail-status">Couldn't load this session.</p>
      )}
      {!isLoading && !isError && !data && (
        <p className="session-detail-status">This session no longer exists.</p>
      )}
      {data && <SessionDetailContent detail={data} />}
    </Modal>
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
  const sessionLabel = `${agent.icon} ${session.model ?? agent.label} · ${session.id.slice(0, 8)}`;

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
    <div className="session-detail">
      <div className="session-detail-identity">
        <Pill
          variant="status"
          tone={session.status === 'active' ? 'green' : 'gray'}
        >
          {session.status}
        </Pill>
        <Pill variant="agent" tone="accent">
          {agent.icon} {agent.label}
        </Pill>
        <span className="session-detail-model">
          {session.model ?? 'unknown model'}
        </span>
      </div>

      <div className="session-detail-export-row">
        <Button
          variant="secondary"
          onClick={() => void handleExportTranscript()}
          disabled={exportState.status === 'saving'}
        >
          {exportState.status === 'saving' ? 'Exporting…' : 'Export transcript'}
        </Button>
        {exportState.status === 'saved' && (
          <span className="session-detail-export-status">
            Saved to {exportState.path}
            <button
              className="session-detail-export-reveal"
              onClick={() => void revealInFinder(exportState.path)}
            >
              Reveal in Finder
            </button>
          </span>
        )}
        {exportState.status === 'error' && (
          <span className="session-detail-export-status session-detail-export-error">
            {exportState.message}
          </span>
        )}
      </div>

      <div className="session-detail-stats">
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
        <div className="session-detail-tags">
          {tags.map((tag) => (
            <Pill key={tag} variant="tag">
              {tag}
            </Pill>
          ))}
        </div>
      )}

      <p className="session-detail-summary">
        {session.summary ?? 'No summary yet'}
      </p>

      <div className="session-detail-files">
        <h3 className="session-detail-files-title">
          Files changed ({groupedFiles.length})
        </h3>
        {groupedFiles.length === 0 ? (
          <p className="session-detail-status">No file changes recorded.</p>
        ) : (
          <ul className="session-detail-file-list">
            {groupedFiles.map((file) => (
              <li key={file.file_path} className="session-detail-file-row">
                <div className="session-detail-file-info">
                  <span className="session-detail-file-path">
                    {file.file_path}
                  </span>
                  <span className="session-detail-file-meta">
                    {file.edit_count > 1
                      ? `${file.edit_count} edits`
                      : '1 edit'}{' '}
                    · +{file.lines_added} / -{file.lines_removed}
                  </span>
                </div>
                <div className="session-detail-file-actions">
                  <Button
                    variant="secondary"
                    className="session-detail-file-open"
                    onClick={() => setDiffPath(file.file_path)}
                  >
                    View diff
                  </Button>
                  <Button
                    variant="secondary"
                    className="session-detail-file-open"
                    onClick={() => handleOpenInEditor(file.file_path)}
                  >
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
