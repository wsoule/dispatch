import { cn } from '@/lib/utils';

/** The 32px ghost row every rail property sits on — the same recipe as `PropertyControls`'
 * row variant, so a picker this file's editors open and a status picker read as one. An
 * `unset` row dims to muted and its label reads as the action that fills it; a `readOnly`
 * row keeps the layout but drops the hover fill, since nothing opens from it. */
export function railRowClass({
  unset = false,
  readOnly = false,
}: { unset?: boolean; readOnly?: boolean } = {}): string {
  return cn(
    'flex h-8 w-full min-w-0 items-center gap-2 rounded-control px-2 text-left text-[13px] font-medium text-(--text-secondary) [&_svg:not([class*=size-])]:size-3.5 [&_svg]:shrink-0',
    !readOnly &&
      'transition-colors duration-100 outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-surface-hover',
    unset && 'text-muted-foreground'
  );
}
