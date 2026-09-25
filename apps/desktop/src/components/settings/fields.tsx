import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { OPERATOR_ONLY, SettingsRow, useGroupLocked } from './SettingsGroup';
import { cn } from '@/lib/utils';
import type { SwitchProps } from '@/ui/ai/switch';
import { Switch } from '@/ui/ai/switch';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

// The four kinds of setting most Settings pages are made of, each saving the
// way General's fields always have: text and numbers on blur, only when the
// value actually changed, snapping back when it is not one the config could
// hold; switches and choices at once. Save feedback (and a refused save's
// reason) is shown by the Settings shell, not here.

interface FieldBase {
  id: string;
  title: string;
  subtitle?: ReactNode;
  /** Extra words search should find this setting by. */
  keywords?: string;
  /** Set when the caller may not change this (the operator-tier settings, for
   *  a teammate below it): the value shows read-only beside a lock. */
  locked?: string;
}

export function TextSetting({
  id,
  title,
  subtitle,
  keywords,
  locked,
  value,
  placeholder,
  mono = false,
  onSave,
}: FieldBase & {
  value: string | undefined;
  placeholder?: string;
  mono?: boolean;
  /** An emptied field saves `null`, which removes the key. */
  onSave: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  return (
    <SettingsRow
      title={title}
      subtitle={subtitle}
      keywords={keywords}
      locked={locked !== undefined}
      htmlFor={id}
      stacked
    >
      {locked !== undefined ? (
        <p className="font-mono text-[13px]">{value ?? '—'}</p>
      ) : (
        <Input
          id={id}
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          className={mono ? 'font-mono' : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const next = draft.trim();
            if (next === (value ?? '')) return;
            onSave(next === '' ? null : next);
          }}
        />
      )}
    </SettingsRow>
  );
}

export function NumberSetting({
  id,
  title,
  subtitle,
  keywords,
  locked,
  value,
  min = 1,
  integer = true,
  suffix,
  placeholder,
  allowEmpty = false,
  onSave,
}: FieldBase & {
  value: number | undefined;
  min?: number;
  integer?: boolean;
  suffix?: string;
  placeholder?: string;
  /** Whether emptying the field is allowed, saving `null` (the default). */
  allowEmpty?: boolean;
  onSave: (next: number | null) => void;
}) {
  const shown = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  return (
    <SettingsRow
      title={title}
      subtitle={subtitle}
      keywords={keywords}
      locked={locked !== undefined}
      htmlFor={id}
      control={
        locked !== undefined ? (
          <span className="tabular-nums">{shown || '—'}</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <Input
              id={id}
              value={draft}
              inputMode="decimal"
              placeholder={placeholder}
              className="w-24 text-right tabular-nums"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                const trimmed = draft.trim();
                if (trimmed === shown) return;
                if (trimmed === '' && allowEmpty) {
                  onSave(null);
                  return;
                }
                const n = Number(trimmed);
                const ok =
                  trimmed !== '' &&
                  Number.isFinite(n) &&
                  n >= min &&
                  (!integer || Number.isInteger(n));
                if (ok) onSave(n);
                // Snap back rather than show what the config does not say.
                else setDraft(shown);
              }}
            />
            {suffix !== undefined && (
              <span className="text-[13px] text-(--text-secondary)">
                {suffix}
              </span>
            )}
          </span>
        )
      }
    />
  );
}

/** The Switch every Settings page uses: disabled inside a locked group, which
 *  its span escapes, and dimmed when disabled (it never matches `:disabled`). */
export function SettingsSwitch({ disabled, className, ...props }: SwitchProps) {
  const groupLocked = useGroupLocked();
  return (
    <Switch
      {...props}
      disabled={groupLocked || disabled === true}
      className={cn(
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className
      )}
    />
  );
}

export function SwitchSetting({
  id,
  title,
  subtitle,
  keywords,
  locked,
  checked,
  onSave,
}: FieldBase & { checked: boolean; onSave: (next: boolean) => void }) {
  return (
    <SettingsRow
      title={title}
      subtitle={subtitle}
      keywords={keywords}
      locked={locked !== undefined}
      htmlFor={id}
      control={
        <SettingsSwitch
          id={id}
          checked={checked}
          disabled={locked !== undefined}
          onCheckedChange={onSave}
        />
      }
    />
  );
}

export function ChoiceSetting<T extends string>({
  id,
  title,
  subtitle,
  keywords,
  locked,
  value,
  choices,
  onSave,
}: FieldBase & {
  value: T;
  choices: { value: T; label: string }[];
  onSave: (next: T) => void;
}) {
  return (
    <SettingsRow
      title={title}
      subtitle={subtitle}
      keywords={keywords}
      locked={locked !== undefined}
      htmlFor={id}
      control={
        <Select
          value={value}
          disabled={locked !== undefined}
          onValueChange={(next) => onSave(next as T)}
        >
          <SelectTrigger id={id} aria-label={title} className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

export { OPERATOR_ONLY };
