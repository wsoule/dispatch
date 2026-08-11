import { Target } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Input } from '@/ui/input';

// The milestone editor in the rail: a pick-or-type field (native datalist) over the
// project's existing milestone names, so assigning a task to a milestone reuses a name with
// one keystroke or coins a new one — no per-project milestone setup, matching the free-form
// model. Commits on blur; clearing it unsets the milestone.
export function MilestoneRow({
  value,
  milestones,
  onChange,
}: {
  value: string | null;
  milestones: string[];
  onChange: (milestone: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  return (
    <div className="hover:bg-muted/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
      <Target className="text-muted-foreground size-3.5 shrink-0" />
      <Input
        list="dispatch-milestones"
        className="h-auto min-w-0 flex-1 border-transparent bg-transparent p-0 shadow-none outline-none focus-visible:ring-0"
        placeholder="No milestone"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== (value ?? '')) onChange(next === '' ? null : next);
        }}
      />
      <datalist id="dispatch-milestones">
        {milestones.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}
