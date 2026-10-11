import { Pencil } from 'lucide-react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { Textarea } from '@/ui/textarea';

// The click-to-edit wrapper the task page's prose sections share (Description, Acceptance
// criteria): at rest it shows `children` — the rendered markdown, or `placeholder` in muted
// ink when there is nothing yet — and one click swaps in a borderless textarea at the same
// metrics, so reading costs nothing and editing is one click into the text. Commits on
// blur, `⌘⏎` and Escape (every control on this page saves rather than discards), and only
// when the text actually changed. `value` is the persisted section text; the draft resets
// whenever it (or the task) changes. Rendered prose stays real prose: it can be selected
// and copied, its links and checklist boxes keep working, and assistive tech reads the
// text itself; a hover-revealed Edit button is the keyboard's way into the editor.
export function EditableBodySection({
  value,
  placeholder,
  onSave,
  label,
  children,
  className,
}: {
  value: string;
  placeholder: string;
  onSave: (next: string) => void;
  /** Accessible name for the textarea; the edit buttons read `Edit <label>`. */
  label: string;
  /** The rendered read-mode body. */
  children?: ReactNode;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  // The click that opened the editor is what the caret follows, so focus moves into the
  // field the moment it mounts (with the caret at the end, not a select-all).
  useEffect(() => {
    if (!editing) return;
    const field = fieldRef.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== value) onSave(draft);
  }

  // Escape is left to bubble (the peek dialog closes on it, after this commit); ⌘⏎ is
  // stopped so the peek's expand chord does not also fire.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.blur();
    }
  }

  if (editing) {
    return (
      <Textarea
        ref={fieldRef}
        variant="borderless"
        aria-label={label}
        data-slot="editable-body"
        data-editing
        className={cn(
          'min-h-6 resize-none text-[15px] leading-6 font-book text-foreground',
          className
        )}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    );
  }

  // Keyboard and assistive tech reach the editor through the Edit button below; a pointer
  // press anywhere in the prose is the same request, made where the eye already is. A press
  // on a link or a checklist box is that control's own, and one that ends a drag-select is a
  // copy, not an edit request.
  function onReadMouseUp(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('a, input, button') !== null) return;
    if (window.getSelection()?.isCollapsed === false) return;
    setEditing(true);
  }

  const readClass =
    'block min-h-6 w-full rounded-control text-left text-[15px] leading-6 font-book outline-none focus-visible:ring-2 focus-visible:ring-ring';

  if (value.trim() === '') {
    return (
      <button
        type="button"
        aria-label={`Edit ${label.toLowerCase()}`}
        data-slot="editable-body"
        data-empty
        onClick={() => setEditing(true)}
        className={cn(
          readClass,
          'cursor-text text-muted-foreground',
          className
        )}
      >
        {placeholder}
      </button>
    );
  }

  return (
    <div
      data-slot="editable-body"
      data-field={label}
      onMouseUp={onReadMouseUp}
      className={cn(
        'group/editable relative min-h-6 w-full cursor-text text-left text-[15px] leading-6 font-book text-foreground',
        className
      )}
    >
      {children}
      <IconButton
        label={`Edit ${label.toLowerCase()}`}
        onClick={() => setEditing(true)}
        className="absolute -top-0.5 right-0 opacity-0 group-hover/editable:opacity-100 focus-visible:opacity-100"
      >
        <Pencil />
      </IconButton>
    </div>
  );
}
