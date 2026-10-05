import type { Priority, TaskRisk } from '@dispatch-foo/core/browser';
import { statusLabel } from '@dispatch-foo/core/browser';
import { Circle, Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { priorityLabel } from '../../lib/taskDisplay';
import { Markdown } from '../runs/Markdown';
import { EditableBodySection } from './detail/EditableBodySection';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';
import { cn } from '@/lib/utils';
import { LabelPill, Pill } from '@/ui/ai/pill';
import { Skeleton } from '@/ui/skeleton';

/**
 * The spec-shaped slice of a task: what it is and what done means, independent of any live
 * run state. Both a plan's still-unconfirmed drafts and real TaskDocs project onto this, so
 * the plan review, the inbox and the task page render the same spec.
 */
export interface TaskSpec {
  title: string;
  /** A canonical or custom status string — 'draft' for plan proposals. */
  status: string;
  priority: Priority;
  description: string;
  acceptanceCriteria: string[];
  writes: string[];
  risk?: TaskRisk;
  /** Blocking tasks by display title. `onOpenBlocker` receives the entry's `key`. */
  blockedBy: { key: string; title: string }[];
}

/** Turns the spec editable, as the task page does: the raw section text to edit, and where
 * each edit goes. `loading` holds the body's place with skeletons until it arrives. */
interface TaskSpecEditing {
  loading: boolean;
  description: string;
  /** The Acceptance Criteria section as written. */
  acceptance: string;
  onSaveDescription: (next: string) => void;
  onSaveAcceptance: (next: string) => void;
  onSaveWrites: (next: string[]) => void;
}

// The risk pill's dot: amber for elevated, red for critical.
const RISK_DOT: Record<'elevated' | 'critical', string> = {
  elevated: 'var(--state-waiting-fg)',
  critical: 'var(--state-failed-fg)',
};

/** One section under a sentence-case 12px/500 heading, opened by a half-pixel hairline —
 * whitespace and a rule, no inset fill. */
export function SpecSection({
  label,
  trailing,
  children,
  id,
}: {
  label: string;
  trailing?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <div
      id={id}
      data-slot="spec-section"
      className="shadow-hairline-top flex flex-col gap-2 px-4 py-3"
    >
      <div className="flex min-h-4 items-center gap-2">
        <p className="text-muted-foreground text-[12px] font-medium">{label}</p>
        {trailing !== undefined && (
          <div className="ml-auto flex items-center gap-1">{trailing}</div>
        )}
      </div>
      {children}
    </div>
  );
}

function CriteriaList({ criteria }: { criteria: string[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {criteria.map((criterion, i) => (
        <li
          key={i}
          className="font-book flex items-start gap-2 text-[13px] leading-5"
        >
          <Circle className="text-muted-foreground/50 mt-1 size-3 shrink-0" />
          <span>{criterion}</span>
        </li>
      ))}
    </ul>
  );
}

function ProseSkeleton() {
  return (
    <div aria-label="Loading" className="flex flex-col gap-2 py-1">
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-2/5" />
    </div>
  );
}

/** The declared write set as mono pills, each removable, with a field that adds a path or
 * glob on Enter. The fan-out schedules around these, so they are worth keeping exact. */
function WritesEditor({
  writes,
  onChange,
}: {
  writes: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const glob = draft.trim();
    setDraft('');
    if (glob === '' || writes.includes(glob)) return;
    onChange([...writes, glob]);
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {writes.map((glob) => (
        <Pill key={glob} className="font-mono font-normal">
          {glob}
          <button
            type="button"
            aria-label={`Remove ${glob}`}
            className="text-muted-foreground hover:text-foreground rounded-pill focus-visible:ring-ring -mr-1 flex size-4 items-center justify-center outline-none focus-visible:ring-2"
            onClick={() => onChange(writes.filter((w) => w !== glob))}
          >
            <X className="size-3" />
          </button>
        </Pill>
      ))}
      <label className="text-muted-foreground focus-within:text-foreground flex h-6 min-w-40 flex-1 items-center gap-1 text-[12px]">
        <Plus aria-hidden className="size-3 shrink-0" />
        <input
          aria-label="Add a write path"
          placeholder={writes.length === 0 ? 'Add a path or glob…' : 'Add…'}
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent font-mono outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
      </label>
    </div>
  );
}

export interface TaskSpecViewProps {
  spec: TaskSpec;
  /** Jumps to a blocking task (dialog swap on the plan page; navigation on the task page). */
  onOpenBlocker?: (key: string) => void;
  /** Replaces the title/status/pills block; `null` drops it (the task page draws its own). */
  header?: ReactNode | null;
  /** Makes the description, criteria and writes editable in place. */
  editing?: TaskSpecEditing;
  /** Replaces the read-only Blocked by section (the task page's relations editor). */
  dependencies?: ReactNode;
  /** More sections after the spec's own (attachments, amendments). */
  children?: ReactNode;
  className?: string;
}

/**
 * One task's spec — status, priority, description, acceptance criteria, declared writes,
 * risk, and blockers — on the task page's own grammar: the 14px status glyph inline with a
 * 24px/600 title, the description as 15px/450 prose, property pills, then hairline-separated
 * sections. Read-only by default, for the plan page's draft dialog and the inbox's right
 * pane; with `editing` it is the task page's Spec mode, every section editable in place.
 * Takes only the `TaskSpec` projection, never a live TaskDoc, so it stays free of run,
 * ledger, and fix-loop concerns by construction. Expects a zero-padding container
 * (sections carry their own edge-to-edge padding).
 */
export function TaskSpecView({
  spec,
  onOpenBlocker,
  header,
  editing,
  dependencies,
  children,
  className,
}: TaskSpecViewProps) {
  // 'routine' is the default risk everywhere — only the two elevated tiers earn a pill.
  const riskPill =
    spec.risk === 'elevated' || spec.risk === 'critical' ? spec.risk : null;

  const defaultHeader = (
    <div className="flex flex-col gap-3 px-4 pt-4 pb-3">
      <div className="flex items-start gap-2">
        <StatusIcon status={spec.status} className="mt-[9px]" />
        <h2 className="text-foreground min-w-0 flex-1 text-[24px] leading-8 font-semibold tracking-[-0.16px] text-pretty">
          {spec.title}
        </h2>
      </div>
      {editing === undefined && spec.description.trim() !== '' && (
        <Markdown content={spec.description} variant="prose" />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill>
          <StatusIcon status={spec.status} />
          {statusLabel(spec.status)}
        </Pill>
        <Pill>
          <PriorityIcon priority={spec.priority} />
          {priorityLabel(spec.priority)}
        </Pill>
        {riskPill !== null && (
          <LabelPill color={RISK_DOT[riskPill]} className="capitalize">
            {riskPill} risk
          </LabelPill>
        )}
      </div>
    </div>
  );

  return (
    <div data-slot="task-spec" className={cn('flex flex-col', className)}>
      {header === undefined ? defaultHeader : header}

      {editing !== undefined && (
        <div data-slot="spec-description" className="px-4 pt-1 pb-4">
          {editing.loading ? (
            <ProseSkeleton />
          ) : (
            <EditableBodySection
              label="Description"
              value={editing.description}
              placeholder="Add description…"
              onSave={editing.onSaveDescription}
            >
              <Markdown content={editing.description} variant="prose" />
            </EditableBodySection>
          )}
        </div>
      )}

      {(editing !== undefined || spec.acceptanceCriteria.length > 0) && (
        <SpecSection
          label="Acceptance criteria"
          trailing={
            spec.acceptanceCriteria.length > 0 ? (
              <span className="text-muted-foreground font-book text-[12px] tabular-nums">
                {spec.acceptanceCriteria.length}
              </span>
            ) : undefined
          }
        >
          {editing === undefined ? (
            <CriteriaList criteria={spec.acceptanceCriteria} />
          ) : editing.loading ? (
            <ProseSkeleton />
          ) : (
            <EditableBodySection
              label="Acceptance criteria"
              value={editing.acceptance}
              placeholder="Add acceptance criteria, one per line…"
              onSave={editing.onSaveAcceptance}
            >
              <CriteriaList criteria={spec.acceptanceCriteria} />
            </EditableBodySection>
          )}
        </SpecSection>
      )}

      {(editing !== undefined || spec.writes.length > 0) && (
        <SpecSection label="Writes" id="task-spec-writes">
          {editing === undefined ? (
            <div className="flex flex-wrap gap-1.5">
              {spec.writes.map((glob) => (
                <Pill key={glob} className="font-mono font-normal">
                  {glob}
                </Pill>
              ))}
            </div>
          ) : (
            <WritesEditor
              writes={spec.writes}
              onChange={editing.onSaveWrites}
            />
          )}
        </SpecSection>
      )}

      {dependencies ??
        (spec.blockedBy.length > 0 && (
          <SpecSection label="Blocked by">
            {/* Full-width hover rows, not chips — a blocker is a task you can jump to. */}
            <div className="-mx-2 flex flex-col">
              {spec.blockedBy.map((blocker) =>
                onOpenBlocker !== undefined ? (
                  <button
                    key={blocker.key}
                    type="button"
                    onClick={() => onOpenBlocker(blocker.key)}
                    className="hover:bg-surface-hover rounded-control focus-visible:ring-ring flex h-8 w-full items-center gap-2 px-2 text-left transition-colors duration-100 outline-none focus-visible:ring-2"
                  >
                    <span className="text-foreground min-w-0 flex-1 truncate text-[13px] font-medium">
                      {blocker.title}
                    </span>
                  </button>
                ) : (
                  <span
                    key={blocker.key}
                    className="text-foreground flex h-8 w-full items-center px-2 text-[13px] font-medium"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {blocker.title}
                    </span>
                  </span>
                )
              )}
            </div>
          </SpecSection>
        ))}

      {children}
    </div>
  );
}
