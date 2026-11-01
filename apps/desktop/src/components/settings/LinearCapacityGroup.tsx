import { LINEAR_USAGE_LIMIT_MESSAGE } from '@dispatch/client';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { describeError } from '../../lib/actionFeedback';
import { formatRelativeTimeFromIso } from '../../lib/format';
import {
  archivableCount,
  capacityPaused,
  describeBulkOutcome,
  describeCapacity,
  describeFetchFailure,
  formatLinearProgress,
  formatUntil,
  progressFor,
} from '../../lib/linearSettings';
import { useSettingsAccess } from './access';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { PillButton } from '@/ui/ai/pill';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Checkbox } from '@/ui/checkbox';
import { Progress } from '@/ui/progress';

/** Settings → Linear → Capacity: active issues against the plan's cap, and
 *  archiving the linked teams' closed issues to make room. */
export function LinearCapacityGroup({
  data,
  configured,
}: {
  data: DispatchProjectData;
  configured: boolean;
}) {
  const { canDecide, decideReason } = useSettingsAccess();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [includeCanceled, setIncludeCanceled] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const status = data.linearStatus;
  if (status === null) return null;

  const capacity = data.linearCapacity;
  const paused = status.capacity ?? null;
  const pausedUntil = capacityPaused(paused) ? (paused?.retryAt ?? null) : null;
  const limitHitAt = capacity?.limitHitAt ?? null;
  const capacityError = data.linearCapacityError ?? null;
  const running = status.running ?? null;
  const summary = describeCapacity(capacity);
  const share =
    capacity !== null && capacity.active !== null && capacity.limit !== null
      ? capacity.active / capacity.limit
      : null;
  const archivable =
    capacity === null ? null : archivableCount(capacity, includeCanceled);
  const canceled =
    capacity === null
      ? null
      : capacity.teams.reduce((n, t) => n + t.canceled, 0);
  const plus = capacity?.truncated === true ? '+' : '';
  const teamKeys = capacity?.teams.map((t) => t.key).join(', ') ?? '';
  const progress = progressFor(status.progress, 'archive');
  const outcome = describeBulkOutcome(status.lastArchive);
  // The daemon refuses both: an archive is a write to Linear, and it needs
  // the link a first sync makes.
  const pullOnly = status.direction === 'pull';
  const unlinked = status.bootstrappedAt === null;
  // A push-only link never takes Linear's changes, its archive included.
  const pushOnly = status.direction === 'push';
  const archiveDisabled =
    !canDecide ||
    !configured ||
    pullOnly ||
    unlinked ||
    running !== null ||
    archiving ||
    archivable === 0;

  async function check() {
    setChecking(true);
    setCheckError(null);
    try {
      await data.refreshLinearCapacity();
    } catch (err) {
      setCheckError(describeFetchFailure(err));
    } finally {
      setChecking(false);
    }
  }

  async function archive() {
    setArchiving(true);
    setArchiveError(null);
    try {
      await data.handleArchiveClosedLinear({ includeCanceled });
    } catch (err) {
      setArchiveError(describeError(err));
    } finally {
      setArchiving(false);
    }
  }

  return (
    <SettingsGroup
      title="Capacity"
      hint="Linear’s Free plan holds 250 active issues across the workspace. Archived issues do not count."
      keywords="linear issue limit plan archive closed free usage"
      requires="none"
    >
      <SettingsRow
        title="Active issues"
        subtitle={
          summary ?? (capacity === null ? 'Not checked yet.' : 'Not measured.')
        }
        control={
          <IconButton
            label="Check again"
            disabled={checking || !configured}
            onClick={() => void check()}
          >
            <RefreshCw
              className={cn(
                checking && 'animate-spin motion-reduce:animate-none'
              )}
            />
          </IconButton>
        }
      >
        {share !== null && (
          <Progress
            aria-label="Active issues against the limit"
            value={Math.min(100, Math.round(share * 100))}
            className="h-1.5"
          />
        )}
        {pausedUntil !== null && (
          <>
            <span className="text-state-failed text-[12px]">
              {paused?.message ?? LINEAR_USAGE_LIMIT_MESSAGE}
            </span>
            <SettingsHint>
              {`New issues wait until there is room; Dispatch tries again ${formatUntil(pausedUntil)}.`}
            </SettingsHint>
          </>
        )}
        {pausedUntil === null && limitHitAt !== null && (
          <SettingsHint>
            {`Linear last refused a new issue ${formatRelativeTimeFromIso(limitHitAt)}.`}
          </SettingsHint>
        )}
        {capacityError !== null && (
          <span className="text-state-failed text-[12px]">
            {describeFetchFailure(capacityError)}
          </span>
        )}
        {checkError !== null && (
          <span className="text-state-failed text-[12px]">{checkError}</span>
        )}
      </SettingsRow>

      <SettingsRow
        title="Archive closed issues in Linear"
        subtitle={`Archived issues stop counting toward the limit, and you can restore them from Linear’s archive. ${
          pushOnly
            ? 'Their tasks here stay as they are: this link only sends changes to Linear.'
            : 'Their tasks here are archived too, as when Linear archives on its own.'
        }`}
        keywords="archive completed canceled done"
        locked={canDecide ? false : decideReason}
        control={
          <>
            <span className="flex items-center gap-2">
              <Checkbox
                aria-label="Include canceled"
                checked={includeCanceled}
                disabled={!canDecide}
                onCheckedChange={(checked) => setIncludeCanceled(checked)}
              />
              <span className="text-muted-foreground text-[12px]">
                {canceled === null
                  ? 'Include canceled'
                  : `Include canceled (${canceled.toLocaleString('en-US')}${plus})`}
              </span>
            </span>
            <PillButton
              disabled={archiveDisabled}
              onClick={() => setConfirming(true)}
            >
              {archivable === null
                ? 'Archive…'
                : `Archive ${archivable.toLocaleString('en-US')}${plus}…`}
            </PillButton>
          </>
        }
      >
        {configured && pullOnly && (
          <SettingsHint>
            Pull only: switch the direction to archive issues in Linear.
          </SettingsHint>
        )}
        {configured && unlinked && (
          <SettingsHint>Sync once to link the team first.</SettingsHint>
        )}
        {progress !== null && (
          <SettingsHint>{formatLinearProgress(progress)}</SettingsHint>
        )}
        {outcome !== null && <SettingsHint>{outcome}</SettingsHint>}
        {status.lastArchive?.errors.map((message) => (
          <span key={message} className="text-state-failed text-[12px]">
            {message}
          </span>
        ))}
        {archiveError !== null && (
          <span className="text-state-failed text-[12px]">{archiveError}</span>
        )}
      </SettingsRow>

      {confirming && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {archivable === null
                  ? 'Archive closed issues in Linear?'
                  : `Archive ${archivable.toLocaleString('en-US')}${plus} issues in Linear?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {`Completed${includeCanceled ? ' and canceled' : ''} issues${
                  teamKeys === '' ? ' in the linked teams' : ` in ${teamKeys}`
                } are archived in Linear${
                  pushOnly
                    ? '. The tasks here linked to them stay as they are, since this link only sends changes to Linear.'
                    : ', and the tasks here linked to them are archived too.'
                } You can restore issues from Linear’s archive.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirming(false);
                  void archive();
                }}
              >
                Archive
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </SettingsGroup>
  );
}
