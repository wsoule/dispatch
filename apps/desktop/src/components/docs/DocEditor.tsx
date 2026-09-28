import { Markdown } from '../runs/Markdown';

interface DocEditorProps {
  text: string;
  /** The textarea's accessible name. */
  label: string;
  previewing: boolean;
  readOnly: boolean;
  onChange: (text: string) => void;
}

// A doc's markdown source in a textarea, as the Files view edits (native undo,
// IME and accessibility), or the same text rendered as its preview.
export function DocEditor({
  text,
  label,
  previewing,
  readOnly,
  onChange,
}: DocEditorProps) {
  if (previewing) {
    return (
      <div className="h-full overflow-auto p-4">
        <Markdown content={text} variant="prose" />
      </div>
    );
  }
  return (
    <textarea
      value={text}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className="h-full w-full resize-none border-0 bg-[var(--color-card)] p-3 font-mono text-xs leading-relaxed outline-none"
      aria-label={label}
    />
  );
}
