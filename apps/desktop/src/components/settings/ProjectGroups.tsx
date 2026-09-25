import type {
  ConfigPatch,
  DispatchConfig,
  VerifyStep,
} from '@dispatch/core/browser';
import { statusLabel } from '@dispatch/core/browser';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { OPERATOR_ONLY, TextSetting } from './fields';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

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
            <span className="flex gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${status} up`}
                disabled={i === 0}
                onClick={() =>
                  void onSave({ statuses: moved(statuses, i, -1) })
                }
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Move ${status} down`}
                disabled={i === statuses.length - 1}
                onClick={() => void onSave({ statuses: moved(statuses, i, 1) })}
              >
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${status}`}
                disabled={statuses.length === 1}
                onClick={() =>
                  void onSave({
                    statuses: statuses.filter((s) => s !== status),
                  })
                }
              >
                <Trash2 />
              </Button>
            </span>
          }
        />
      ))}
      <SettingsRow
        title="Add a column"
        htmlFor="status-new"
        control={
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input
              id="status-new"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="qa"
              className="w-32"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={draft.trim() === ''}
            >
              <Plus />
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
          subtitle={<span className="font-mono">{step.command}</span>}
          keywords="check step verify"
          locked={!canOperate}
          control={
            canOperate ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${step.name}`}
                onClick={() => void save(steps.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
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
            className="flex flex-wrap gap-2"
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
            <Input
              id="verify-step-name"
              aria-label="Check name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="tests"
              className="w-32"
            />
            <Input
              aria-label="Command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="pnpm test"
              className="min-w-[200px] flex-1 font-mono"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={name.trim() === '' || command.trim() === ''}
            >
              <Plus />
              Add
            </Button>
          </form>
        )}
      </SettingsRow>
    </>
  );
}
