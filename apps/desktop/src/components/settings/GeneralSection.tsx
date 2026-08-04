import type { DispatchConfig, VerifyConfig } from '@dispatch/core/browser';
import { useEffect, useState } from 'react';

import { HintText, Panel, PanelHeader, PanelRow } from '@/ui/chrome';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';

interface GeneralSectionProps {
  config: DispatchConfig;
  onSave: (patch: {
    verifyCommand?: string | null;
    autoCommit?: boolean;
    verifyTimeoutSec?: number;
    verify?: Partial<VerifyConfig>;
  }) => Promise<void>;
}

/** Before-anything-lands settings: verify command, auto-commit, verify timeout.
 *  Save feedback lives in the shell, not here — this only calls `onSave`. */
export function GeneralSection({ config, onSave }: GeneralSectionProps) {
  const [verify, setVerify] = useState('');
  const [timeoutSec, setTimeoutSec] = useState('600');
  const [runCommand, setRunCommand] = useState('');
  const [runUrl, setRunUrl] = useState('');
  const [runNotes, setRunNotes] = useState('');

  // Re-seeds when config changes underneath (another window, a hand edit) —
  // keyed on config values, so a field mid-edit isn't clobbered every render.
  useEffect(() => {
    setVerify(config.verifyCommand ?? '');
    setTimeoutSec(String(config.orchestrator.verifyTimeoutSec));
    setRunCommand(config.verify?.command ?? '');
    setRunUrl(config.verify?.url ?? '');
    setRunNotes(config.verify?.notes ?? '');
  }, [config]);

  // Shared blur handler for the three verify-recipe fields. Core rejects an empty
  // string for verify.command/url/notes and offers no patch shape to clear one
  // (unlike verifyCommand's `null`), so an emptied field reverts to the saved
  // value instead of sending a string the server would 400 on.
  function saveRunField(
    field: keyof VerifyConfig,
    raw: string,
    current: string | undefined,
    setDraft: (value: string) => void
  ) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      setDraft(current ?? '');
      return;
    }
    if (trimmed !== (current ?? '')) {
      void onSave({ verify: { [field]: trimmed } });
    }
  }

  return (
    <>
      <Panel>
        <PanelHeader>Before anything lands</PanelHeader>

        <PanelRow className="flex-col items-stretch gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px]">Verify command</span>
            <Input
              aria-label="Verify command"
              value={verify}
              onChange={(e) => setVerify(e.target.value)}
              onBlur={() => {
                const next = verify.trim();
                if (next !== (config.verifyCommand ?? '')) {
                  // Empty clears the key rather than storing an empty command — no verify and a
                  // verify that runs nothing are different things to the merge queue.
                  void onSave({ verifyCommand: next === '' ? null : next });
                }
              }}
              placeholder="bun run verify"
              className="font-mono text-[12.5px]"
            />
            <HintText>
              Runs in the merge queue before a branch lands. Leave empty to skip
              verification entirely.
            </HintText>
          </label>
        </PanelRow>

        <PanelRow>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.autoCommit}
              onChange={(e) => void onSave({ autoCommit: e.target.checked })}
              className="accent-accent size-3.5"
            />
            <span className="text-[13px]">
              Let an agent commit its own work as it goes
            </span>
          </label>
        </PanelRow>

        <PanelRow className="flex-col items-stretch gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px]">Verify timeout</span>
            <Input
              aria-label="Verify timeout"
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(e.target.value)}
              onBlur={() => {
                const n = Number(timeoutSec);
                if (
                  Number.isInteger(n) &&
                  n >= 1 &&
                  n !== config.orchestrator.verifyTimeoutSec
                ) {
                  void onSave({ verifyTimeoutSec: n });
                } else {
                  // Snap a nonsense value back rather than leaving the field showing something the
                  // config does not actually say.
                  setTimeoutSec(String(config.orchestrator.verifyTimeoutSec));
                }
              }}
              inputMode="numeric"
              className="w-20 font-mono text-[12.5px]"
            />
            <HintText>
              Ceiling on one verify run, in seconds. The merge queue is serial,
              so a verify that never returns holds up every entry behind it.
            </HintText>
          </label>
        </PanelRow>
      </Panel>

      <Panel>
        <PanelHeader>How to run this project</PanelHeader>

        <PanelRow>
          <HintText>
            The recipe a <span className="font-mono">verify</span> run follows
            to exercise the project by hand — separate from &ldquo;Verify
            command&rdquo; above, which the merge queue runs automatically
            before a branch lands.
          </HintText>
        </PanelRow>

        <PanelRow className="flex-col items-stretch gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px]">Run command</span>
            <Input
              aria-label="Run command"
              value={runCommand}
              onChange={(e) => setRunCommand(e.target.value)}
              onBlur={() =>
                saveRunField(
                  'command',
                  runCommand,
                  config.verify?.command,
                  setRunCommand
                )
              }
              placeholder="bun run dev"
              className="font-mono text-[12.5px]"
            />
            <HintText>
              Starts the project so a verify run has something to exercise. Not
              the merge-queue gate above.
            </HintText>
          </label>
        </PanelRow>

        <PanelRow className="flex-col items-stretch gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px]">URL</span>
            <Input
              aria-label="URL"
              value={runUrl}
              onChange={(e) => setRunUrl(e.target.value)}
              onBlur={() =>
                saveRunField('url', runUrl, config.verify?.url, setRunUrl)
              }
              placeholder="http://localhost:3000"
              className="font-mono text-[12.5px]"
            />
            <HintText>
              Where a verify run should look once the project is running.
            </HintText>
          </label>
        </PanelRow>

        <PanelRow className="flex-col items-stretch gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px]">Notes</span>
            <Textarea
              aria-label="Notes"
              value={runNotes}
              onChange={(e) => setRunNotes(e.target.value)}
              onBlur={() =>
                saveRunField(
                  'notes',
                  runNotes,
                  config.verify?.notes,
                  setRunNotes
                )
              }
              placeholder="Login steps, seed data, ports…"
              className="text-[12.5px]"
            />
            <HintText>
              Anything else a verify run needs to know to exercise the project.
            </HintText>
          </label>
        </PanelRow>
      </Panel>
    </>
  );
}
