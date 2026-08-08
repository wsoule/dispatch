import { useEffect, useState } from 'react';

import { MainSection } from './MainSection';
import { Textarea } from '@/ui/textarea';

// An inline-editable body section (Description, Acceptance Criteria): renders
// as borderless prose until focused, auto-grows to its content, and commits on
// blur only when the text actually changed — so reading the task costs nothing
// and editing is one click into the text. `value` is the section's current
// persisted text; the local draft resets whenever it (or the task) changes.
export function EditableBodySection({
  title,
  value,
  placeholder,
  onSave,
}: {
  title: string;
  value: string;
  placeholder: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <MainSection title={title}>
      <Textarea
        className="text-foreground/90 hover:bg-muted/30 focus-visible:bg-muted/40 -mx-2 min-h-[2.25rem] resize-none rounded-md border-transparent bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed shadow-none transition-colors duration-150 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onSave(draft);
        }}
      />
    </MainSection>
  );
}
