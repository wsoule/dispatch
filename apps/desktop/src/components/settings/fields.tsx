import { SegmentedControl, Select, Switch, TextField } from '@dispatch/ui';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import styles from './settings.module.css';
import { OPERATOR_ONLY, SettingsRow, useGroupLocked } from './SettingsGroup';

// The kinds of setting most Settings pages are made of, each saving the way
// General's fields always have: text and numbers on blur, only when the
// value actually changed, snapping back when it is not one the config could
// hold; switches, choices and modes at once. Save feedback (and a refused
// save's reason) is shown by the Settings shell, not here.

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
        <p className={styles.readonly}>{value ?? '—'}</p>
      ) : (
        <TextField
          id={id}
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          className={mono ? styles.monoInput : undefined}
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
  max = Number.POSITIVE_INFINITY,
  integer = true,
  suffix,
  placeholder,
  allowEmpty = false,
  onSave,
}: FieldBase & {
  value: number | undefined;
  min?: number;
  max?: number;
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
          <span className="num">{shown || '—'}</span>
        ) : (
          <span className={styles.numberField}>
            <TextField
              id={id}
              value={draft}
              inputMode="decimal"
              placeholder={placeholder}
              className={styles.numberInput}
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
                  n <= max &&
                  (!integer || Number.isInteger(n));
                if (ok) onSave(n);
                // Snap back rather than show what the config does not say.
                else setDraft(shown);
              }}
            />
            {suffix !== undefined && (
              <span className={styles.suffix}>{suffix}</span>
            )}
          </span>
        )
      }
    />
  );
}

interface SettingsSwitchProps {
  /** The row's `<label htmlFor>` names the switch through this id. */
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  'aria-label'?: string;
}

/** The Switch every Settings page uses: just the track, named by its row's label, and
 *  disabled inside a locked group. */
export function SettingsSwitch({
  id,
  checked,
  disabled,
  onCheckedChange,
  'aria-label': ariaLabel,
}: SettingsSwitchProps) {
  const groupLocked = useGroupLocked();
  return (
    <Switch
      id={id}
      label=""
      aria-label={ariaLabel}
      checked={checked}
      disabled={groupLocked || disabled === true}
      onChange={onCheckedChange}
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
          id={id}
          label={title}
          value={value}
          options={choices}
          disabled={locked !== undefined}
          className={styles.select}
          onChange={(next) => {
            const picked = choices.find((c) => c.value === next);
            if (picked !== undefined) onSave(picked.value);
          }}
        />
      }
    />
  );
}

/** A choice of two or three short modes with every one in view: a segmented
 *  control, like the app's other mode switches, where ChoiceSetting's select
 *  would hide the rest. Pressing the current mode again saves nothing. */
export function ModeSetting<T extends string>({
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
  // The control disables option by option, so a locked group is read here too.
  const disabled = useGroupLocked() || locked !== undefined;
  return (
    <SettingsRow
      title={title}
      subtitle={subtitle}
      keywords={keywords}
      locked={locked !== undefined}
      control={
        <span id={id}>
          <SegmentedControl
            label={title}
            size="sm"
            value={value}
            options={choices.map((c) => ({
              id: c.value,
              label: c.label,
              disabled,
            }))}
            onChange={(next) => {
              const picked = choices.find((c) => c.value === next);
              if (picked !== undefined && picked.value !== value) {
                onSave(picked.value);
              }
            }}
          />
        </span>
      }
    />
  );
}

export { OPERATOR_ONLY };
