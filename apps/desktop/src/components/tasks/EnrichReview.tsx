import { Button } from '@/ui/button';
import { Panel } from '@/ui/chrome';

/** The sections an "Add detail" pass proposes — structurally `EnrichDraft`, but
 * inline here so this component depends on neither caller's module. */
interface EnrichReviewDraft {
  description: string;
  acceptanceCriteria: string[];
}

/**
 * A drafted "Add detail" proposal, shown read-only for a yes/no before anything
 * is written. Shared by the task dialog and the brain dump row's inline panel.
 */
export function EnrichReview({
  draft,
  applying,
  onApply,
  onDiscard,
  applyLabel = 'Apply to task',
  discardLabel = 'Discard',
  note = 'Applying replaces Description and Acceptance Criteria below.',
}: {
  draft: EnrichReviewDraft;
  applying: boolean;
  onApply: () => void;
  onDiscard: () => void;
  applyLabel?: string;
  discardLabel?: string;
  note?: string;
}) {
  return (
    <Panel className="flex flex-col gap-3 p-3.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium">Proposed detail</span>
        <span className="text-muted-foreground text-[12px]">{note}</span>
      </div>

      {draft.description !== '' && (
        <div className="flex flex-col gap-1">
          <h4 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Description
          </h4>
          <p className="text-foreground/90 text-[13.5px] leading-relaxed whitespace-pre-wrap">
            {draft.description}
          </p>
        </div>
      )}

      {draft.acceptanceCriteria.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Acceptance Criteria
          </h4>
          <ul className="text-foreground/90 flex list-disc flex-col gap-1 pl-4 text-[13.5px] leading-relaxed">
            {draft.acceptanceCriteria.map((criterion, i) => (
              <li key={`${i}-${criterion}`}>{criterion}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={applying} onClick={onApply}>
          {applying ? 'Applying…' : applyLabel}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={applying}
          onClick={onDiscard}
        >
          {discardLabel}
        </Button>
      </div>
    </Panel>
  );
}
