'use client';

import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

export type SwitchProps = SwitchPrimitive.Root.Props & {
  /** Puts the label on the left of the toggle, as one `<label>` row. */
  label?: ReactNode;
};

/** The 28×16 toggle: chip-grey with a muted knob off, indigo with a white knob on. The
 * checked state is `data-checked`; `onCheckedChange` receives the new boolean first. */
export function Switch({ label, className, ...props }: SwitchProps) {
  const control = (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-pill bg-border-chip p-0.5 transition-colors duration-100 outline-none data-checked:bg-primary disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="rounded-pill bg-muted-foreground block size-3 transition-transform duration-100 data-checked:translate-x-3 data-checked:bg-white"
      />
    </SwitchPrimitive.Root>
  );
  if (label === undefined) return control;
  return (
    <label
      data-slot="switch-row"
      className="font-book flex items-center justify-between gap-3 text-[13px] text-(--text-secondary)"
    >
      <span className="min-w-0 truncate">{label}</span>
      {control}
    </label>
  );
}
