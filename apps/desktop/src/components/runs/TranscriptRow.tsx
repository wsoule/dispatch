import type { NormalizedEntry } from '@dispatch/client';

import type { GutterTone } from '@/lib/transcriptGutter';
import { gutterTag, gutterTone } from '@/lib/transcriptGutter';
import { cn } from '@/lib/utils';

const TONE: Record<GutterTone, string> = {
  muted: 'text-muted-foreground',
  normal: 'text-foreground',
  accent: 'text-accent-foreground',
  good: 'text-state-review',
  bad: 'text-state-failed',
};

/** A one-line summary of a tool call, so the row says what happened without unfolding it. */
function toolSummary(entry: NormalizedEntry): string {
  const input = entry.toolInput;
  if (input !== null && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    // The field that identifies *what* the tool acted on, in the order tools tend to name it.
    for (const key of [
      'file_path',
      'path',
      'pattern',
      'command',
      'url',
      'query',
    ]) {
      const value = obj[key];
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return entry.toolName ?? '';
}

/**
 * One line of the transcript: a fixed-width tag, then the content.
 *
 * The fixed width is the whole design. It turns the transcript into a scannable spine — you can
 * see five reads, a think, two edits and a test run without reading any of it — which a
 * variable-width chat bubble layout cannot do however it is styled.
 */
export function TranscriptRow({ entry }: { entry: NormalizedEntry }) {
  const tag = gutterTag(entry);
  const tone = gutterTone(entry);
  const text = entry.kind === 'tool' ? toolSummary(entry) : (entry.text ?? '');

  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-3 py-0.5">
      <span
        className={cn(
          'dense-label pt-0.5 text-right',
          tone === 'accent' && 'text-accent-foreground',
          tone === 'bad' && 'text-state-failed',
          tone === 'good' && 'text-state-review'
        )}
      >
        {tag}
      </span>
      <span
        className={cn(
          'font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap',
          TONE[tone]
        )}
      >
        {text}
      </span>
    </div>
  );
}
