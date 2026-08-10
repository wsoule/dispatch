import { Eye } from 'lucide-react';

import { Checkbox } from '@/ui/checkbox';

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
    <label
      htmlFor="task-self-review"
      className="hover:bg-muted/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]"
    >
      <Eye className="text-muted-foreground size-3.5 shrink-0" />
      <span className="flex-1">Self review</span>
      <Checkbox
        id="task-self-review"
        checked={value}
        onCheckedChange={(checked) => onChange(checked === true)}
        aria-label="Self review before finishing"
      />
    </label>
  );
}
