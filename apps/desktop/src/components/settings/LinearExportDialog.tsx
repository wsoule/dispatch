import type {
  LinearBulkStart,
  LinearCapacity,
  LinearExportPreview,
  LinearExportScope,
} from '@dispatch/client';
import { useEffect, useId, useState } from 'react';

import { describeError } from '../../lib/actionFeedback';
import { exportActiveCount, exportScopeCount } from '../../lib/linearSettings';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Label } from '@/ui/label';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';

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
  const id = useId();
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export to Linear</DialogTitle>
          <DialogDescription>
            Creates a Linear record for each task here that has none. Linking
            only mirrors changes made after it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <RadioGroup
            aria-label="What to export"
            value={scope}
            onValueChange={(value) => setScope(value as LinearExportScope)}
            className="flex flex-col gap-3"
          >
            {SCOPES.map((option) => (
              <div key={option.value} className="flex flex-col gap-0.5">
                <Label className="font-normal">
                  <RadioGroupItem
                    value={option.value}
                    aria-describedby={`${id}-${option.value}`}
                  />
                  <span className="text-[13px]">{option.label}</span>
                  {preview !== null && (
                    <span className="text-muted-foreground text-[13px] tabular-nums">
                      {n(exportScopeCount(preview, option.value))} tasks
                    </span>
                  )}
                </Label>
                <span
                  id={`${id}-${option.value}`}
                  className="text-muted-foreground pl-5.5 text-[12px]"
                >
                  {preview !== null
                    ? option.hint(preview)
                    : previewError === null
                      ? 'Counting…'
                      : `Couldn’t count: ${describeError(previewError)}`}
                </span>
              </div>
            ))}
          </RadioGroup>
          {preview !== null && fitLine(capacity, preview, scope) !== null && (
            <p className="text-muted-foreground font-book text-[12px]">
              {fitLine(capacity, preview, scope)}
            </p>
          )}
          {error !== null && (
            <p role="alert" className="text-state-failed text-[12px]">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={sending || total === null || total === 0}
            onClick={() => void start()}
          >
            {total === null
              ? 'Export'
              : `Export ${n(total)} task${total === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
