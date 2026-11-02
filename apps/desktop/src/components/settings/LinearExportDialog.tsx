import type {
  LinearBulkStart,
  LinearCapacity,
  LinearExportPreview,
  LinearExportScope,
} from '@dispatch/client';
import { Button, cx, Dialog, RadioGroup } from '@dispatch/ui';
import { useEffect, useState } from 'react';

import { describeError } from '../../lib/actionFeedback';
import { exportActiveCount, exportScopeCount } from '../../lib/linearSettings';
import styles from './LinearExportDialog.module.css';

function n(value: number): string {
  return value.toLocaleString('en-US');
}

// The three export scopes, each with what it sends.
const SCOPES: readonly {
  value: LinearExportScope;
  label: string;
  hint: (preview: LinearExportPreview) => string;
}[] = [
  {
    value: 'open',
    label: 'Open work only',
    hint: () => 'Tasks that are not finished or archived.',
  },
  {
    value: 'all',
    label: 'Everything',
    hint: (p) =>
      `Finished tasks too: ${n(p.finished)} arrive as closed issues and count toward an issue limit.`,
  },
  {
    value: 'all-archive-finished',
    label: 'Everything, finished tasks archived on arrival',
    hint: (p) =>
      `Finished and archived tasks (${n(p.archived)} archived here) are archived in Linear as they arrive, so they do not count toward an issue limit.`,
  },
];

// How the export sits against the plan's cap, when the cap is known.
function fitLine(
  capacity: LinearCapacity | null,
  preview: LinearExportPreview,
  scope: LinearExportScope
): string | null {
  if (capacity === null || capacity.active === null) return null;
  if (capacity.limit === null) return null;
  const base = `Workspace: ${n(capacity.active)} of ${n(capacity.limit)} active issues.`;
  const free = Math.max(0, capacity.limit - capacity.active);
  if (free === 0) {
    return `${base} Linear refuses every new issue, even one archived on arrival, until you archive closed issues or upgrade.`;
  }
  const adds = exportActiveCount(preview, scope);
  // An issue archived on arrival needs one free slot to land, then frees it.
  const arriving = exportScopeCount(preview, scope) - adds;
  if (adds < free || (adds === free && arriving === 0)) {
    return `${base} This export fits.`;
  }
  if (adds === free) {
    return `${base} Its ${n(adds)} open issues fill the ${n(free)} free slots, so the ${n(arriving)} archived on arrival wait in the retry queue until there is room.`;
  }
  return `${base} This export adds ${n(adds)} and ${n(free)} are free; the rest wait in the retry queue until there is room.`;
}

/** Export to Linear: pick which unlinked tasks get a Linear issue, with each
 *  scope's count from the daemon's preview. */
export function LinearExportDialog({
  open,
  onOpenChange,
  preview,
  previewError = null,
  capacity,
  onExport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: LinearExportPreview | null;
  /** Why the preview could not be fetched; null while it loads or once it has. */
  previewError?: unknown;
  capacity: LinearCapacity | null;
  onExport: (scope: LinearExportScope) => Promise<LinearBulkStart>;
}) {
  const [scope, setScope] = useState<LinearExportScope>('open');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setScope('open');
    setError(null);
  }, [open]);

  const total = preview === null ? null : exportScopeCount(preview, scope);

  async function start() {
    setSending(true);
    setError(null);
    try {
      await onExport(scope);
      onOpenChange(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title="Export to Linear"
      description="Creates a Linear record for each task here that has none. Linking only mirrors changes made after it."
      actions={
        <>
          <Button variant="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={sending || total === null || total === 0}
            onClick={() => void start()}
          >
            {total === null
              ? 'Export'
              : `Export ${n(total)} task${total === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <RadioGroup
          label="What to export"
          value={scope}
          onChange={(value) => {
            const picked = SCOPES.find((option) => option.value === value);
            if (picked !== undefined) setScope(picked.value);
          }}
          options={SCOPES.map((option) => ({
            value: option.value,
            label: (
              <>
                {option.label}
                {preview !== null && (
                  <span className={styles.count}>
                    {' '}
                    {n(exportScopeCount(preview, option.value))} tasks
                  </span>
                )}
              </>
            ),
            hint:
              preview !== null
                ? option.hint(preview)
                : previewError === null
                  ? 'Counting…'
                  : `Couldn’t count: ${describeError(previewError)}`,
          }))}
        />
        {preview !== null && fitLine(capacity, preview, scope) !== null && (
          <p className={styles.note}>{fitLine(capacity, preview, scope)}</p>
        )}
        {error !== null && (
          <p
            role="alert"
            className={cx('toneText', styles.error)}
            data-tone="danger"
          >
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
