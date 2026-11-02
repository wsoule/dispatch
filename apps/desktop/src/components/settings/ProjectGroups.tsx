import type {
  ConfigPatch,
  DispatchConfig,
  VerifyStep,
} from '@dispatch-foo/core/browser';
import { statusLabel } from '@dispatch-foo/core/browser';
import { Button, TextField } from '@dispatch/ui';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { OPERATOR_ONLY, TextSetting } from './fields';
import styles from './ProjectGroups.module.css';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

interface Props {
  config: DispatchConfig;
  /** Resolves `false` when the save was refused; a form keeps its draft then. */
  onSave: (patch: ConfigPatch) => Promise<unknown>;
  canOperate: boolean;
}

/** `list` with the entry at `from` moved one place up or down. */
export function moved<T>(list: T[], from: number, by: -1 | 1): T[] {
  const to = from + by;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Where reviewing someone else's pull request checks it out. */
export function PullRequestsGroup({ config, onSave, canOperate }: Props) {
  return (
    <SettingsGroup title="Pull requests">
      <TextSetting
        id="pr-worktree-dir"
        title="Checkout folder"
        subtitle="Where a pull request you review gets checked out. Leave empty for the default."
        keywords="worktree prWorktreeDir"
        value={config.prWorktreeDir}
        placeholder="../pr-worktrees"
        mono
        locked={canOperate ? undefined : OPERATOR_ONLY}
        onSave={(prWorktreeDir) => void onSave({ prWorktreeDir })}
      />
    </SettingsGroup>
  );
}

/** The board's columns, in order, with add, reorder and remove. */
export function StatusesGroup({ config, onSave }: Omit<Props, 'canOperate'>) {
  const [draft, setDraft] = useState('');
  const statuses = config.statuses;
  const add = () => {
    const name = draft.trim().toLowerCase();
    if (name === '' || statuses.includes(name)) return;
    // New ones go before the last, which is where work ends.
    void onSave({
      statuses: [...statuses.slice(0, -1), name, ...statuses.slice(-1)],
    }).then((saved) => {
      if (saved !== false) setDraft('');
    });
  };
  return (
    <SettingsGroup
      title="Board columns"
      hint="Tasks move through these from left to right. A column with tasks in it can't be removed."
      keywords="statuses"
    >
      {statuses.map((status, i) => (
        <SettingsRow
          key={status}
          title={statusLabel(status)}
          control={
            <span className={styles.rowActions}>
              <Button
                variant="quiet"
                size="sm"
                icon={<ArrowUp size={14} strokeWidth={1.8} />}
                aria-label={`Move ${status} up`}
                disabled={i === 0}
                onClick={() =>
                  void onSave({ statuses: moved(statuses, i, -1) })
                }
              />
              <Button
                variant="quiet"
                size="sm"
                icon={<ArrowDown size={14} strokeWidth={1.8} />}
                aria-label={`Move ${status} down`}
                disabled={i === statuses.length - 1}
                onClick={() => void onSave({ statuses: moved(statuses, i, 1) })}
              />
              <Button
                variant="quiet"
                size="sm"
                icon={<Trash2 size={14} strokeWidth={1.8} />}
                aria-label={`Remove ${status}`}
                disabled={statuses.length === 1}
                onClick={() =>
                  void onSave({
                    statuses: statuses.filter((s) => s !== status),
                  })
                }
              />
            </span>
          }
        />
      ))}
      <SettingsRow
        title="Add a column"
        htmlFor="status-new"
        control={
          <form
            className={styles.addForm}
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <TextField
              id="status-new"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="qa"
              className={styles.short}
            />
            <Button
              type="submit"
              variant="secondary"
              icon={<Plus size={14} strokeWidth={1.8} />}
              disabled={draft.trim() === ''}
            >
              Add
            </Button>
          </form>
        }
      />
    </SettingsGroup>
  );
}

/** Named checks a branch must pass before it merges, run in order. */
export function VerifyStepsList({ config, onSave, canOperate }: Props) {
  const steps = config.verifySteps ?? [];
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const save = (next: VerifyStep[]) =>
    onSave({ verifySteps: next.length === 0 ? null : next });
  return (
    <>
      {steps.map((step, i) => (
        <SettingsRow
          key={`${step.name}-${i}`}
          title={step.name}
          subtitle={<span className="mono">{step.command}</span>}
          keywords="check step verify"
          locked={!canOperate}
          control={
            canOperate ? (
              <Button
                variant="quiet"
                size="sm"
                icon={<Trash2 size={14} strokeWidth={1.8} />}
                aria-label={`Remove ${step.name}`}
                onClick={() => void save(steps.filter((_, j) => j !== i))}
              />
            ) : undefined
          }
        />
      ))}
      <SettingsRow
        title="Add a check"
        subtitle={
          steps.length === 0
            ? 'None yet, so only the single command below runs.'
            : undefined
        }
        htmlFor="verify-step-name"
        keywords="verify step test lint typecheck"
        locked={!canOperate}
        stacked={canOperate}
      >
        {canOperate && (
          <form
            className={styles.addForm}
            data-wrap=""
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() === '' || command.trim() === '') return;
              void save([
                ...steps,
                { name: name.trim(), command: command.trim() },
              ]).then((saved) => {
                if (saved === false) return;
                setName('');
                setCommand('');
              });
            }}
          >
            <TextField
              id="verify-step-name"
              aria-label="Check name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="tests"
              className={styles.short}
            />
            <TextField
              aria-label="Command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="pnpm test"
              className={styles.command}
            />
            <Button
              type="submit"
              variant="secondary"
              icon={<Plus size={14} strokeWidth={1.8} />}
              disabled={name.trim() === '' || command.trim() === ''}
            >
              Add
            </Button>
          </form>
        )}
      </SettingsRow>
    </>
  );
}
