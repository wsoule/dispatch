import type { DiffResult, NormalizedEntry, RunMeta } from '@dispatch/client';

import { isTerminalRunState } from '../../lib/runState';
import { Modal } from '../ui/Modal';
import { RunLogView } from './RunLogView';
import { RunReviewView } from './RunReviewView';

interface RunModalProps {
  meta: RunMeta;
  entries: NormalizedEntry[];
  pendingApproval: { requestId: string; toolName: string } | null;
  diff: DiffResult | undefined;
  diffLoading: boolean;
  diffError: string | null;
  prCapability: boolean;
  onApprove: (requestId: string, allow: boolean) => Promise<void>;
  onSendMessage: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  onMerge: () => Promise<void>;
  onDiscard: () => Promise<void>;
  onRequestChanges: (text: string) => Promise<void>;
  onOpenPr: () => Promise<void>;
  onClose: () => void;
}

/** Opens either RunLogView (any non-terminal run) or RunReviewView (finished/failed/cancelled)
 * for one run, keyed on `meta.state` — the same run id can flip between the two across its
 * lifetime as this modal stays open, e.g. the moment a live run finishes. */
export function RunModal({
  meta,
  entries,
  pendingApproval,
  diff,
  diffLoading,
  diffError,
  prCapability,
  onApprove,
  onSendMessage,
  onCancel,
  onMerge,
  onDiscard,
  onRequestChanges,
  onOpenPr,
  onClose,
}: RunModalProps) {
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${meta.taskTitle} — ${meta.id}`}
      wide
    >
      {isTerminalRunState(meta.state) ? (
        <RunReviewView
          meta={meta}
          diff={diff}
          diffLoading={diffLoading}
          diffError={diffError}
          prCapability={prCapability}
          onMerge={onMerge}
          onDiscard={onDiscard}
          onRequestChanges={onRequestChanges}
          onOpenPr={onOpenPr}
        />
      ) : (
        <RunLogView
          meta={meta}
          entries={entries}
          pendingApproval={pendingApproval}
          onApprove={onApprove}
          onSendMessage={onSendMessage}
          onCancel={onCancel}
        />
      )}
    </Modal>
  );
}
