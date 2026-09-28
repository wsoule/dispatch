import { useEffect, useRef } from 'react';

import { Markdown } from '../runs/Markdown';

interface DocEditorProps {
  text: string;
  /** The textarea's accessible name. */
  label: string;
  previewing: boolean;
  readOnly: boolean;
  onChange: (text: string) => void;
  /** A line to put the caret on and scroll to; a new object places it again. */
  placeAt?: { line: number } | null;
}

// Pixels per line when the textarea's computed line height is not a length.
const FALLBACK_LINE_PX = 20;

// A doc's markdown source in a textarea, as the Files view edits (native undo,
// IME and accessibility), or the same text rendered as its preview.
export function DocEditor({
  text,
  label,
  previewing,
  readOnly,
  onChange,
  placeAt = null,
}: DocEditorProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (el === null || placeAt === null) return;
    const offset = el.value
      .split('\n', placeAt.line)
      .reduce((n, line) => n + line.length + 1, 0);
    el.setSelectionRange(offset, offset);
    const px = Number.parseFloat(getComputedStyle(el).lineHeight);
    el.scrollTop = placeAt.line * (Number.isFinite(px) ? px : FALLBACK_LINE_PX);
  }, [placeAt]);
  if (previewing) {
    return (
      <div className="h-full overflow-auto p-4">
        <Markdown content={text} variant="prose" />
      </div>
    );
  }
  return (
    <textarea
      ref={area}
      value={text}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className="h-full w-full resize-none border-0 bg-[var(--color-card)] p-3 font-mono text-xs leading-relaxed outline-none"
      aria-label={label}
    />
  );
}
