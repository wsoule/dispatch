import { Button as ButtonPrimitive } from '@base-ui/react/button';

import { cn } from '../lib/utils';

type NoticePillTone = 'waiting' | 'accent';

// Spelled out because Tailwind cannot build class names at runtime.
const TONE: Record<NoticePillTone, string> = {
  waiting:
    'border-(--state-waiting-edge) bg-(--state-waiting-surface) text-(--state-waiting-fg)',
  accent: 'border-transparent bg-(--accent-tint) text-(--accent)',
};

/** A 24px tinted pill that announces something behind it and opens it on click: the
 * asks waiting on you (`waiting`, amber) or "3 new" posts held back (`accent`). */
export function NoticePill({
  tone = 'accent',
  className,
  ...props
}: ButtonPrimitive.Props & { tone?: NoticePillTone }) {
  return (
    <ButtonPrimitive
      data-slot="notice-pill"
      data-tone={tone}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-pill border-[0.5px] px-2.5 text-[12px] font-medium whitespace-nowrap underline-offset-2 transition-colors duration-100 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
        TONE[tone],
        className
      )}
      {...props}
    />
  );
}
