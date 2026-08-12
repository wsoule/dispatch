import { ChevronDownIcon, LightbulbIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/ui/button';

export type RecommendationCardAlternative = {
  id: string;
  label: string;
};

export type RecommendationCardProps = {
  title: string;
  rationale: string;
  /** 0–1; rendered as a 5-segment quintile meter plus a mono percent label. */
  confidence: number;
  alternatives?: RecommendationCardAlternative[];
  /** Initial open state of the alternatives list; expansion afterward is local state. */
  defaultExpanded?: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onPickAlternative?: (id: string) => void;
};

// Confidence arrives as a 0–1 float; the meter has 5 segments, so each one
// represents a fifth of the range. Clamp first — callers may pass slightly
// out-of-range values from noisy upstream scoring.
function confidenceSegmentCount(confidence: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  return Math.round(clamped * 5);
}

/** Five `rounded-full h-1` bars, filled left-to-right by quintile — all filled
 * segments share the accent color (never a traffic-light scale). */
function ConfidenceMeter({ confidence }: { confidence: number }) {
  const filled = confidenceSegmentCount(confidence);
  const percent = Math.round(Math.min(1, Math.max(0, confidence)) * 100);

  return (
    <div className="flex items-center gap-2">
      <div
        className="flex items-center gap-1"
        role="img"
        aria-label={`Confidence ${String(percent)}%`}
      >
        {Array.from({ length: 5 }, (_, index) => (
          <span
            key={index}
            aria-hidden
            className={`ease-out-expo h-1 w-3.5 rounded-full transition-colors duration-300 ${
              index < filled ? 'bg-primary' : 'bg-surface-inset'
            }`}
          />
        ))}
      </div>
      <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
        {percent}%
      </span>
    </div>
  );
}

/** Agent suggestion card: accent-tinted icon badge with title and muted rationale,
 * a 5-segment confidence meter, a collapsible list of alternative choices, and a
 * footer with primary Accept / ghost Dismiss actions. Matches the showcase's
 * "Recommendation Card" primitive. Alternatives visibility is local state — the
 * caller only supplies the list and a pick handler. */
export function RecommendationCard({
  title,
  rationale,
  confidence,
  alternatives = [],
  defaultExpanded = false,
  onAccept,
  onDismiss,
  onPickAlternative,
}: RecommendationCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasAlternatives = alternatives.length > 0;

  return (
    <div className="bg-card rounded-card shadow-card w-full max-w-sm overflow-hidden">
      <div className="flex items-start gap-2.5 px-4 pt-4 pb-3">
        <span className="bg-accent-tint text-primary flex size-7 shrink-0 items-center justify-center rounded-full">
          <LightbulbIcon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-foreground text-[13px] font-semibold text-pretty">
            {title}
          </p>
          <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">
            {rationale}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 px-4 pb-3">
        <ConfidenceMeter confidence={confidence} />
        {hasAlternatives && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="text-muted-foreground hover:text-foreground ease-out-expo flex shrink-0 items-center gap-1 text-[12px] font-medium transition-colors duration-100"
          >
            {alternatives.length} alternative
            {alternatives.length === 1 ? '' : 's'}
            <ChevronDownIcon
              aria-hidden
              className={`ease-out-expo size-3.5 transition-transform duration-200 motion-reduce:transition-none ${
                expanded ? 'rotate-180' : ''
              }`}
            />
          </button>
        )}
      </div>

      {hasAlternatives && (
        <div
          className="ease-out-expo grid transition-[grid-template-rows] duration-300 motion-reduce:transition-none"
          style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
        >
          <div className="overflow-hidden">
            <div className="border-border bg-surface-inset border-t px-2 py-2">
              <p className="text-muted-foreground px-1.5 pb-1 text-[11px] font-medium">
                Other options
              </p>
              {alternatives.map((alternative) => (
                <button
                  key={alternative.id}
                  type="button"
                  onClick={() => onPickAlternative?.(alternative.id)}
                  className="hover:bg-surface-hover rounded-control ease-out-expo flex w-full items-center gap-2.5 px-1.5 py-1.5 text-left transition-colors duration-100"
                >
                  <span className="text-foreground min-w-0 flex-1 truncate text-[12.5px]">
                    {alternative.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="border-border bg-surface-inset flex items-center justify-end gap-2 border-t px-4 py-2.5">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button type="button" variant="default" size="sm" onClick={onAccept}>
          Accept
        </Button>
      </div>
    </div>
  );
}
