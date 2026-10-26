import { ChevronDownIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from './lib/utils';

function NativeSelect({
  className,
  size = 'default',
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'> & { size?: 'sm' | 'default' }) {
  return (
    <div
      className="group/native-select relative w-fit has-[select:disabled]:opacity-50"
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          'h-7 w-full min-w-0 appearance-none rounded-pill border-[0.5px] border-border-chip bg-surface-control px-2.5 pr-7 text-[12px] font-medium text-(--text-secondary) transition-colors duration-100 outline-none hover:bg-surface-active selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:h-6 data-[size=sm]:text-[11px]',
          'focus-visible:ring-2 focus-visible:ring-ring',
          'aria-invalid:ring-2 aria-invalid:ring-destructive',
          className
        )}
        {...props}
      />
      <ChevronDownIcon
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 size-3 -translate-y-1/2 select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<'option'>) {
  return (
    <option
      data-slot="native-select-option"
      className={cn('bg-[Canvas] text-[CanvasText]', className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOption };
