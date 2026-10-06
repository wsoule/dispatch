import type {
  ContainerHealth,
  ContainerStatus,
} from '../../lib/containerStatus';
import { cn } from '@/lib/utils';

export const HEALTH: Record<ContainerHealth, { label: string; tone: string }> =
  {
    attention: {
      label: 'attention',
      tone: 'bg-(--state-waiting-surface) text-(--state-waiting-fg)',
    },
    moving: {
      label: 'moving',
      tone: 'bg-(--state-working-surface) text-(--state-working-fg)',
    },
    idle: { label: 'idle', tone: 'text-muted-foreground' },
    finished: {
      label: 'finished',
      tone: 'bg-(--state-review-surface) text-(--state-review-fg)',
    },
  };

/** The four urgent counts, in the glyphs and colours the top bar uses. */
export const CELLS = [
  { key: 'asks', glyph: '●', tone: 'text-(--state-waiting-fg)', label: 'asks' },
  {
    key: 'failed',
    glyph: '✕',
    tone: 'text-(--state-failed-fg)',
    label: 'failed',
  },
  {
    key: 'working',
    glyph: '◐',
    tone: 'text-(--state-working-fg)',
    label: 'working',
  },
  {
    key: 'review',
    glyph: '◇',
    tone: 'text-(--state-review-fg)',
    label: 'in review',
  },
] as const;

export function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A milestone's folded status: urgent counts, health, done/total, due date. */
export function MilestoneStatusCells({
  status,
  dueDate,
}: {
  status: ContainerStatus;
  dueDate: string | null;
}) {
  const health = HEALTH[status.health];
  return (
    <span
      data-testid="milestone-status"
      className="flex items-center gap-2.5 text-[12px] tabular-nums"
    >
      {CELLS.map((cell) => {
        const n = status[cell.key];
        return (
          <span
            key={cell.key}
            title={`${n} ${cell.label}`}
            className={cn(
              n > 0 ? cn(cell.tone, 'font-semibold') : 'text-(--text-ghost)'
            )}
          >
            {cell.glyph} {n}
          </span>
        );
      })}
      <span className={cn('rounded-pill px-2 py-px text-[11px]', health.tone)}>
        {health.label}
      </span>
      <span className="text-muted-foreground" title="landed / total">
        ◔ {status.done}/{status.total}
      </span>
      {dueDate !== null && (
        <span className="text-muted-foreground">due {shortDate(dueDate)}</span>
      )}
    </span>
  );
}
