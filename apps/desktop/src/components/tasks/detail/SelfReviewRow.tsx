import { Eye } from 'lucide-react';

// The self-review toggle in the rail: when on, the orchestrator's prompt builder (see
// server's prompt.ts) appends an instruction telling the dispatched agent to re-review its
// own diff against the acceptance criteria before finishing, rather than stopping the moment
// tests pass. A plain checkbox rather than a picker (there's no "value" to choose, just
// on/off), styled like the other rail rows so it reads as one of them rather than a bolted-on
// control.
export function SelfReviewRow({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="hover:bg-muted/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
      <Eye className="text-muted-foreground size-3.5 shrink-0" />
      <span className="flex-1">Self review</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        aria-label="Self review before finishing"
        className="accent-primary size-3.5"
      />
    </label>
  );
}
