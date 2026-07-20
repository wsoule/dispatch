import type { NormalizedEntry, RunMeta } from '@dispatch/client';
import { useState } from 'react';

import {
  groupLogEntries,
  liveCostUsd,
  toolEntryPreview,
} from '../../lib/runLog';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/TextInput';
import { ApprovalCard } from './ApprovalCard';
import { RunStatePill } from './RunStatePill';
import './RunLogView.css';

const LIVE_STATES = new Set<RunMeta['state']>([
  'provisioning',
  'running',
  'awaiting-approval',
]);

// One assistant/thinking/system entry as its own chat-style bubble. `kind`
// picks the label and lean (thinking reads as a quieter aside, system as a
// centered note rather than a message from either side).
function MessageBubble({ entry }: { entry: NormalizedEntry }) {
  const roleLabel =
    entry.kind === 'assistant'
      ? 'Agent'
      : entry.kind === 'thinking'
        ? 'Thinking'
        : 'System';
  return (
    <div className={`run-log-bubble run-log-bubble-${entry.kind}`}>
      <div className="run-log-bubble-role">{roleLabel}</div>
      <div className="run-log-bubble-text">{entry.text ?? ''}</div>
    </div>
  );
}

// A cluster of consecutive tool-call entries (see groupLogEntries) rendered
// as one collapsible block — collapsed by default so a turn with several
// tool calls doesn't dominate the log; expanding shows every call's full
// input and status.
function ToolCluster({ entries }: { entries: NormalizedEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="run-log-tools">
      <button
        type="button"
        className="run-log-tools-toggle"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="run-log-tools-caret">{expanded ? '▾' : '▸'}</span>
        {entries.length === 1
          ? toolEntryPreview(entries[0])
          : `${entries.length} tool calls`}
      </button>
      {expanded && (
        <ul className="run-log-tools-list">
          {entries.map((entry, i) => (
            <li key={i} className="run-log-tools-item">
              <div className="run-log-tools-item-header">
                <span className="run-log-tools-item-name">
                  {entry.toolName ?? 'tool'}
                </span>
                {entry.status !== undefined && (
                  <span
                    className={`run-log-tools-item-status run-log-tools-item-status-${entry.status}`}
                  >
                    {entry.status}
                  </span>
                )}
              </div>
              <pre className="run-log-tools-item-input">
                {entry.toolInput !== undefined
                  ? JSON.stringify(entry.toolInput, null, 2)
                  : '(no input)'}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface RunLogViewProps {
  meta: RunMeta;
  entries: NormalizedEntry[];
  /** The pending approval this window has seen live via the `approval.requested` WS event, or
   * `null` when there isn't one (or when `meta.state` is `awaiting-approval` because a run
   * paused before this window connected — see the banner below for that case; the daemon
   * doesn't expose a paused run's requestId over `GET /api/runs/:id`, only the live WS event
   * carries it, so there's nothing to resume approving from here without it). */
  pendingApproval: { requestId: string; toolName: string } | null;
  onApprove: (requestId: string, allow: boolean) => Promise<void>;
  onSendMessage: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
}

/** Live run view: chat-style normalized log, the approval gate when one is pending, a
 * follow-up message box while the run is actively working, and cancel. Shown inside RunModal
 * for any non-terminal run; RunReviewView takes over once a run reaches finished/failed/cancelled. */
export function RunLogView({
  meta,
  entries,
  pendingApproval,
  onApprove,
  onSendMessage,
  onCancel,
}: RunLogViewProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = groupLogEntries(entries);
  const cost = liveCostUsd(meta, entries);
  const live = LIVE_STATES.has(meta.state);

  // Finds the most recent tool-log entry with a matching name to back the
  // approval card's input preview — see the field doc comment above for why
  // this is a best-effort lookup rather than something the API hands us
  // directly.
  const pendingApprovalInput =
    pendingApproval !== null
      ? entries
          .filter(
            (e) => e.kind === 'tool' && e.toolName === pendingApproval.toolName
          )
          .at(-1)?.toolInput
      : undefined;

  async function submitFollowUp() {
    if (draft.trim() === '') return;
    setSending(true);
    setError(null);
    try {
      await onSendMessage(draft.trim());
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function submitCancel() {
    setCancelling(true);
    setError(null);
    try {
      await onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="run-log-view">
      <div className="run-log-header">
        <RunStatePill state={meta.state} />
        <span className="run-log-header-branch">{meta.branch}</span>
        {cost !== null && (
          <span className="run-log-header-cost">${cost.toFixed(2)}</span>
        )}
        {meta.turns !== undefined && (
          <span className="run-log-header-turns">{meta.turns} turns</span>
        )}
        <div className="run-log-header-spacer" />
        {live && (
          <Button
            variant="secondary"
            disabled={cancelling}
            onClick={() => void submitCancel()}
          >
            Cancel
          </Button>
        )}
      </div>

      {error !== null && <div className="run-log-error">{error}</div>}

      <div className="run-log-body">
        {groups.length === 0 && (
          <p className="run-log-empty">
            {meta.state === 'provisioning'
              ? 'Waiting for the run to start…'
              : 'No log entries yet.'}
          </p>
        )}
        {groups.map((group, i) =>
          group.kind === 'tools' ? (
            <ToolCluster key={i} entries={group.entries} />
          ) : (
            <MessageBubble key={i} entry={group.entries[0]} />
          )
        )}
      </div>

      {meta.state === 'awaiting-approval' &&
        (pendingApproval !== null ? (
          <ApprovalCard
            toolName={pendingApproval.toolName}
            toolInput={pendingApprovalInput}
            onDecide={(allow) => onApprove(pendingApproval.requestId, allow)}
          />
        ) : (
          <div className="run-log-stale-approval">
            This run is waiting on an approval this window didn&rsquo;t see live
            — reopen it from a session that was connected when the approval was
            requested, or check the run&rsquo;s process directly.
          </div>
        ))}

      {meta.state === 'running' && (
        <div className="run-log-followup">
          <TextInput
            placeholder="Send a follow-up message…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitFollowUp();
            }}
            disabled={sending}
          />
          <Button disabled={sending} onClick={() => void submitFollowUp()}>
            Send
          </Button>
        </div>
      )}
    </div>
  );
}
