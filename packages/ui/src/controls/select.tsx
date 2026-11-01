'use client';

import type { ReactNode } from 'react';

import { PickerPopover } from '../edit/picker-popover';
import { useFieldControl } from './field';
import type { SelectProps } from './types';

/* A form select: PickerPopover as a bordered field without search, saving
   through the picker contract; inside a Field it takes the label's id. */
export function Select({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled,
  id,
  className,
}: SelectProps): ReactNode {
  const field = useFieldControl();
  return (
    <PickerPopover
      label={label}
      value={value}
      options={options}
      onChange={(next) => (next === null ? undefined : onChange(next))}
      placeholder={placeholder}
      disabled={disabled}
      id={id ?? field?.id}
      className={className}
      appearance="field"
      searchable={false}
    />
  );
}
