import type { ClipboardEvent, DragEvent, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

import { docUrlTransform, imageFiles } from '../../lib/docAssets';
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
  /** Renders the preview's images (`asset:` ones through the docs API). */
  renderImage?: (props: { src?: string; alt?: string }) => ReactNode;
  /** Uploads pasted or dropped images, answering the markdown to insert at the caret. */
  onImages?: (files: File[]) => Promise<string[]>;
}

// The styles that decide where a textarea's lines wrap, copied onto its mirror.
const WRAP_STYLES = [
  'font-family',
  'font-size',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'letter-spacing',
  'line-height',
  'overflow-wrap',
  'padding-left',
  'padding-right',
  'tab-size',
  'text-indent',
  'text-transform',
  'white-space',
  'word-break',
  'word-spacing',
] as const;

// How far below the top of a textarea's text `offset` starts, measured on a
// hidden copy that wraps as the textarea does, since long lines soft-wrap.
function textTop(el: HTMLTextAreaElement, offset: number): number {
  const style = getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const name of WRAP_STYLES) {
    mirror.style.setProperty(name, style.getPropertyValue(name));
  }
  Object.assign(mirror.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    visibility: 'hidden',
    boxSizing: 'border-box',
    width: `${el.clientWidth}px`,
    border: '0',
  });
  mirror.textContent = el.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = '.';
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

// A doc's markdown source in a textarea, as the Files view edits (native undo,
// IME and accessibility), or the same text rendered as its preview.
export function DocEditor({
  text,
  label,
  previewing,
  readOnly,
  onChange,
  placeAt = null,
  renderImage,
  onImages,
}: DocEditorProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  // Uploads the images a paste or drop carried and inserts their links at the caret.
  const insertImages = (
    files: File[],
    e: ClipboardEvent<HTMLTextAreaElement> | DragEvent<HTMLTextAreaElement>
  ): void => {
    if (onImages === undefined || readOnly || files.length === 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const at = el.selectionStart;
    void onImages(files).then((links) => {
      if (links.length === 0) return;
      const current = el.value;
      onChange(
        `${current.slice(0, at)}${links.join('\n')}${current.slice(at)}`
      );
    });
  };
  useEffect(() => {
    const el = area.current;
    if (el === null || placeAt === null) return;
    const offset = el.value
      .split('\n', placeAt.line)
      .reduce((n, line) => n + line.length + 1, 0);
    el.setSelectionRange(offset, offset);
    el.scrollTop = textTop(el, offset);
  }, [placeAt]);
  if (previewing) {
    return (
      <div className="h-full overflow-auto p-4">
        <Markdown
          content={text}
          variant="prose"
          urlTransform={docUrlTransform}
          img={renderImage}
        />
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
      onPaste={(e) => insertImages(imageFiles(e.clipboardData.files), e)}
      onDrop={(e) => insertImages(imageFiles(e.dataTransfer.files), e)}
      className="h-full w-full resize-none border-0 bg-[var(--color-card)] p-3 font-mono text-xs leading-relaxed outline-none"
      aria-label={label}
    />
  );
}
