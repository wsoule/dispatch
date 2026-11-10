import type { StatusModel, StatusType } from '@dispatch-foo/core/browser';
import { hasStatusDefinition, statusType } from '@dispatch-foo/core/browser';
import { cx, PIE_DASH, pieDashOffset, type UiTone } from '@dispatch/ui';

import { useActiveStatusModel } from '../../lib/statusModel';
import { BLOCKED_TONE, statusTone } from '../../lib/statusTone';
import styles from './StatusIcon.module.css';

// Linear's status glyph, geometry read from its SVG DOM: a 14×14 viewBox, an outer ring at
// r=6 (stroke 1.5) and an inner "pie" drawn as an r=2 circle with a 4-wide stroke whose
// dasharray exposes a fraction of the circumference, rotated so it starts at 12 o'clock.
// Sized by the SVG's own width/height (the `size` prop); a caller's CSS class still wins,
// since the module never sets a size. The library StateGlyph cannot draw the 0.75 and 0.9
// pies, the backlog dash pattern or the cut-out disks, so this keeps its own geometry.
const VIEWBOX = 14;
const CENTER = 7;
const RING_RADIUS = 6;
const RING_STROKE = 1.5;
// Linear's solid ring is itself a dash pattern with no gap; the offset keeps its seam off the
// 12 o'clock mark, and the backlog ring only changes the pattern.
const RING_DASH = '3.14 0';
const RING_DASH_OFFSET = -0.7;
const BACKLOG_RING_DASH = '1.4 1.74';
const BACKLOG_RING_DASH_OFFSET = 0.65;
// The pie's dash length (the library's `PIE_DASH`, shared with `ProgressPie`) is the
// visible arc at 100%; the offset hides `1 - fraction` of it.
const PIE_RADIUS = 2;
const PIE_STROKE = 4;
const PIE_DASHARRAY = `${PIE_DASH} ${PIE_DASH * 2}`;
// The done/cancelled disk: an r=3 circle with a 6-wide stroke covers the whole ring interior.
const DISK_RADIUS = 3;
const DISK_STROKE = 6;
const DISK_DASHARRAY = '18.84955592153876 37.69911184307752';
const ROTATE_TO_NOON = `rotate(-90 ${CENTER} ${CENTER})`;

// Linear's own check and × paths, filled in the surface colour so they read as cut-outs.
const CHECK_PATH =
  'M10.951 4.24896C11.283 4.58091 11.283 5.11909 10.951 5.45104L5.95104 10.451C5.61909 10.783 5.0809 10.783 4.74896 10.451L2.74896 8.45104C2.41701 8.11909 2.41701 7.5809 2.74896 7.24896C3.0809 6.91701 3.61909 6.91701 3.95104 7.24896L5.35 8.64792L9.74896 4.24896C10.0809 3.91701 10.6191 3.91701 10.951 4.24896Z';
const X_PATH =
  'M4.396 4.396C4.723 4.068 5.253 4.068 5.581 4.396L7 5.815L8.419 4.396C8.747 4.068 9.277 4.068 9.604 4.396C9.932 4.723 9.932 5.253 9.604 5.581L8.185 7L9.604 8.419C9.932 8.747 9.932 9.277 9.604 9.604C9.277 9.932 8.747 9.932 8.419 9.604L7 8.185L5.581 9.604C5.253 9.932 4.723 9.932 4.396 9.604C4.068 9.277 4.068 8.747 4.396 8.419L5.815 7L4.396 5.581C4.068 5.253 4.068 4.723 4.396 4.396Z';
const CUTOUT_FILL = 'var(--surface)';

type StatusShape = 'backlog' | 'pie' | 'done' | 'cancelled';

interface StatusVisual {
  shape: StatusShape;
  /** Pie fill fraction (0..1) for the ring shapes; Linear draws the (empty) pie for backlog
   * and todo too, so both carry 0. */
  fraction?: number;
}

// Linear's defaults mapped onto the tracker's built-in pipeline: dashed backlog ring, empty
// todo ring, a pie that fills as the work advances (working half, review three-quarter,
// landing nine-tenths), a check disk for landed, a cancelled disk for dropped. The colour
// comes from `statusTone`, not from here.
const KNOWN_STATUS_VISUALS: Record<string, StatusVisual> = {
  draft: {
    shape: 'backlog',
    fraction: 0,
  },
  ready: {
    shape: 'pie',
    fraction: 0,
  },
  working: {
    shape: 'pie',
    fraction: 0.5,
  },
  review: {
    shape: 'pie',
    fraction: 0.75,
  },
  landing: {
    shape: 'pie',
    fraction: 0.9,
  },
  landed: {
    shape: 'done',
  },
  dropped: {
    shape: 'cancelled',
  },
};

// An untyped custom status (a bare name in `.dispatch/config.yml`) renders as the empty
// todo ring, so it always has a deliberate shape.
const CUSTOM_STATUS_VISUAL: StatusVisual = {
  shape: 'pie',
  fraction: 0,
};

// A typed custom status takes its shape from its workflow type, so a mirrored Linear
// workflow reads like Linear's own glyphs.
const TYPE_VISUALS: Record<StatusType, StatusVisual> = {
  triage: KNOWN_STATUS_VISUALS.draft,
  backlog: KNOWN_STATUS_VISUALS.draft,
  unstarted: KNOWN_STATUS_VISUALS.ready,
  started: KNOWN_STATUS_VISUALS.working,
  completed: KNOWN_STATUS_VISUALS.landed,
  canceled: KNOWN_STATUS_VISUALS.dropped,
};

/** A status's shape: a built-in by name, anything else by its workflow type. */
function resolveStatusVisual(status: string, model: StatusModel): StatusVisual {
  if (Object.hasOwn(KNOWN_STATUS_VISUALS, status)) {
    return KNOWN_STATUS_VISUALS[status] ?? CUSTOM_STATUS_VISUAL;
  }
  return hasStatusDefinition(status, model)
    ? TYPE_VISUALS[statusType(status, model)]
    : CUSTOM_STATUS_VISUAL;
}

export interface StatusIconProps {
  status: string;
  /** Paints the glyph in the blocked amber (`BLOCKED_TONE`) — a task held by an unmet
   * dependency keeps its status shape but loses its status colour. */
  blocked?: boolean;
  /** Paints the glyph in this tone instead, over `blocked` and the status's own tone — a
   * failed verification check draws the cancelled disk in `danger` (red for failed). */
  tone?: UiTone;
  /** Width and height in px (default 14). A caller's class may still size it. */
  size?: number;
  className?: string;
}

/**
 * Linear's signature status glyph at its exact geometry: a ring whose interior fills as a
 * task advances — dashed ring (backlog), empty ring (todo), a half/three-quarter pie
 * (in progress/in review), a filled disk with a check cut-out (done), or a disk with an ×
 * (cancelled). Renders identically in group headers, board columns, and next to every
 * card/row title, taking only a `status` string so every call site stays config-driven.
 * Coloured through `data-tone`: the `tone` prop, else `BLOCKED_TONE` when blocked, else
 * `statusTone` (none for done, which keeps the neutral fill).
 */
export function StatusIcon({
  status,
  blocked = false,
  tone: toneOverride,
  size = 14,
  className,
}: StatusIconProps) {
  const model = useActiveStatusModel();
  const visual = resolveStatusVisual(status, model);
  const tone =
    toneOverride ?? (blocked ? BLOCKED_TONE : statusTone(status, model));
  const backlog = visual.shape === 'backlog';

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      width={size}
      height={size}
      fill="none"
      className={cx(styles.icon, className)}
      data-tone={tone ?? undefined}
      role="img"
      aria-label={`Status: ${status}`}
      data-status-shape={visual.shape}
    >
      <circle
        cx={CENTER}
        cy={CENTER}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        strokeDasharray={backlog ? BACKLOG_RING_DASH : RING_DASH}
        strokeDashoffset={backlog ? BACKLOG_RING_DASH_OFFSET : RING_DASH_OFFSET}
      />
      {(visual.shape === 'backlog' || visual.shape === 'pie') && (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={PIE_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={PIE_STROKE}
          strokeDasharray={PIE_DASHARRAY}
          strokeDashoffset={pieDashOffset(visual.fraction ?? 0)}
          transform={ROTATE_TO_NOON}
        />
      )}
      {(visual.shape === 'done' || visual.shape === 'cancelled') && (
        <>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={DISK_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={DISK_STROKE}
            strokeDasharray={DISK_DASHARRAY}
            strokeDashoffset={0}
            transform={ROTATE_TO_NOON}
          />
          <path
            className={styles.cutout}
            fill={CUTOUT_FILL}
            d={visual.shape === 'done' ? CHECK_PATH : X_PATH}
          />
        </>
      )}
    </svg>
  );
}
