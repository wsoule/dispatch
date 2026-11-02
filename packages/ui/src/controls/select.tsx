'use client';

import type { ReactNode } from 'react';

import { PickerPopover } from '../edit/picker-popover';
import { dataAttributes } from '../lib/data-attributes';
import { useFieldControl } from './field';
import type { SelectProps } from './types';

/* A form select: PickerPopover as a bordered field without search, saving
   through the picker contract; inside a Field it takes the label's id. Its
   open list is a layer of the overlay stack, like any picker's, and a
   host's data-* hooks land on it. */
export function Select(props: SelectProps): ReactNode {
  const {
    label,
    value,
    options,
    onChange,
    placeholder,
    disabled,
    id,
    className,
  } = props;
  const field = useFieldControl();
  return (
    <PickerPopover
      {...dataAttributes(props)}
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
