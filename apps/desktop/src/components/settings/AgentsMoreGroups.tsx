import type { ConfigPatch, DispatchConfig } from '@dispatch-foo/core/browser';
import { Button, TextArea, TextField } from '@dispatch/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import styles from './AgentsMoreGroups.module.css';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

interface Props {
  config: DispatchConfig;
  /** Resolves `false` when the save was refused; a form keeps its draft then. */
  onSave: (patch: ConfigPatch) => Promise<unknown>;
  canOperate: boolean;
}

/** One argument per line, blank lines dropped — how the command is written. */
export function argvFromLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * CLI agents: any coding agent that takes a prompt on the command line,
 * declared as the arguments to run it with. `{prompt}` and `{model}` are
 * filled in when a run starts.
 */
export function CliAgents({ config, onSave, canOperate }: Props) {
  const declared = Object.entries(config.executors ?? {}).filter(
    ([, e]) => e.command !== undefined
  );
  const [name, setName] = useState('');
  const [argv, setArgv] = useState('');
  const [model, setModel] = useState('');

  async function add() {
    const run = argvFromLines(argv);
    const id = name.trim();
    if (id === '' || run.length === 0 || model.trim() === '') return;
    const saved = await onSave({
      executors: {
        [id]: { command: { run }, models: { execute: model.trim() } },
      },
    });
    if (saved === false) return;
    setName('');
    setArgv('');
    setModel('');
  }

  return (
    <SettingsGroup
      title="Command-line agents"
      hint="Add any coding agent you run from a terminal. Claude and Codex are built in."
      keywords="cli executor gemini custom"
    >
      {declared.map(([id, e]) => (
        <SettingsRow
          key={id}
          title={id}
          subtitle={<span className="mono">{e.command?.run.join(' ')}</span>}
          locked={!canOperate}
          control={
            canOperate ? (
              <Button
                variant="quiet"
                size="sm"
                icon={<Trash2 size={14} strokeWidth={1.8} />}
                aria-label={`Remove ${id}`}
                onClick={() => void onSave({ executors: { [id]: null } })}
              />
            ) : undefined
          }
        />
      ))}
      <SettingsRow
        title="Add an agent"
        subtitle={
          declared.length === 0
            ? 'One argument per line. {prompt} and {model} are filled in when a run starts; without {prompt}, the prompt is piped in.'
            : undefined
        }
        htmlFor="cli-agent-name"
        locked={!canOperate}
        stacked={canOperate}
      >
        {canOperate && (
          <div className={styles.form}>
            <TextField
              id="cli-agent-name"
              aria-label="Agent name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name, e.g. gemini"
            />
            <TextArea
              aria-label="Command, one argument per line"
              value={argv}
              onChange={(e) => setArgv(e.target.value)}
              placeholder={'gemini\n-p\n{prompt}'}
              rows={3}
              className={styles.argv}
              spellCheck={false}
            />
            <TextField
              aria-label="Model for coding runs"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Model, e.g. gemini-2.5-pro"
            />
            <Button
              variant="secondary"
              className={styles.add}
              icon={<Plus size={14} strokeWidth={1.8} />}
              disabled={
                name.trim() === '' ||
                argvFromLines(argv).length === 0 ||
                model.trim() === ''
              }
              onClick={() => void add()}
            >
              Add agent
            </Button>
          </div>
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}
