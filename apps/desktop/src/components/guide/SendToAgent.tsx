import type { EffortLevel } from '@dispatch-foo/core/browser';
import { Button, Field, Popover, Spinner, TextArea } from '@dispatch/ui';
import { Send, SlidersHorizontal } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';

import {
  DEFAULT_EFFORT_ID,
  effortFromId,
  effortOptions,
  modelLabel,
  MODELS,
} from '../../lib/models';
import { FailureNotice } from '../failure/FailureNotice';
import styles from './guide.module.css';

export interface SendChoice {
  model?: string;
  effort?: EffortLevel;
  writes: string[];
}

export interface SendToAgentOptions {
  /** Offer the model and effort pickers; their lists are Claude's, so only for that agent. */
  modelChoice: boolean;
  /** What "Default" resolves to, named in its label. */
  defaultModel?: string;
  defaultEffort?: EffortLevel;
}

/** Declared files, one per line; blank lines and stray spaces dropped. */
export function parseWrites(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The guide's one Send to agent button. Model, effort and the files the agent may
 * change wait behind More options, so the first send is a single click.
 */
export function SendToAgent({
  options,
  onSend,
  disabled = false,
  extra,
}: {
  options: SendToAgentOptions;
  onSend: (choice: SendChoice) => Promise<void>;
  disabled?: boolean;
  /** More controls at the bottom of More options (the draft's "Just create the task"). */
  extra?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState('');
  const [effortId, setEffortId] = useState(DEFAULT_EFFORT_ID);
  const [writes, setWrites] = useState('');
  const [sending, setSending] = useState(false);
  // Set synchronously so a second click or retry before re-render cannot send twice.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const defaultName = modelLabel(options.defaultModel);

  async function send() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    const effort = options.modelChoice ? effortFromId(effortId) : undefined;
    try {
      await onSend({
        ...(options.modelChoice && model !== '' ? { model } : {}),
        ...(effort === undefined ? {} : { effort }),
        writes: parseWrites(writes),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <div className={styles.send}>
      <div className={styles.sendRow}>
        <Popover
          open={open}
          onOpenChange={setOpen}
          label="More options"
          align="end"
          width={288}
          trigger={
            <Button
              variant="quiet"
              size="sm"
              icon={
                <SlidersHorizontal size={14} strokeWidth={1.8} aria-hidden />
              }
            >
              More options
            </Button>
          }
        >
          <div className={styles.options}>
            {/* Native selects, not the library's picker Select: each choice
                is a short plain list inside this popover, and a native
                control keeps role combobox with every option in the DOM. */}
            {options.modelChoice && (
              <>
                <Field label="Model" id={`${id}-model`}>
                  <select
                    id={`${id}-model`}
                    className="select"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    <option value="">
                      {defaultName === undefined
                        ? 'Default'
                        : `Default (${defaultName})`}
                    </option>
                    {MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Effort" id={`${id}-effort`}>
                  <select
                    id={`${id}-effort`}
                    className="select"
                    value={effortId}
                    onChange={(e) => setEffortId(e.target.value)}
                  >
                    {effortOptions(options.defaultEffort).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            <Field label="Files it may change">
              <TextArea
                rows={3}
                value={writes}
                onChange={(e) => setWrites(e.target.value)}
                placeholder={'src/settings/**\nOne path per line'}
              />
            </Field>
            {extra}
          </div>
        </Popover>
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || sending}
          icon={
            sending ? (
              <Spinner size="xs" label="" />
            ) : (
              <Send size={14} strokeWidth={1.8} aria-hidden />
            )
          }
          onClick={() => void send()}
        >
          Send to agent
        </Button>
      </div>
      {/* The button hides its Spinner from assistive tech and keeps its
          words, so this always-mounted line says the send out loud. */}
      <span role="status" className="srOnly">
        {sending ? 'Sending to the agent…' : ''}
      </span>
      {error !== null && <FailureNotice error={error} onRetry={send} />}
    </div>
  );
}
