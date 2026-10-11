import * as React from 'react';

import { cn } from './lib/utils';

// A plain `<label>`: Base UI has no standalone label primitive (its labels
// live inside Field), and nothing radix's added beyond the element itself.
// Both ways of naming a control pass straight through: `htmlFor` pointing at
// its id, or the control nested in `children`.
function Label({
  className,
  htmlFor,
  children,
  ...props
}: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      htmlFor={htmlFor}
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className
      )}
      {...props}
    >
      {children}
    </label>
  );
}

export { Label };
