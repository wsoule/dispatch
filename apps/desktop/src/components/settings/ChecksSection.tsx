import type {
  ConfigPatch,
  DispatchConfig,
  VerifyConfig,
} from '@dispatch/core/browser';
import { useEffect, useState } from 'react';

import { EscalationEditor } from './EscalationEditor';
import { NumberSetting, SwitchSetting } from './fields';
import { VerifyStepsList } from './ProjectGroups';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';

interface ChecksSectionProps {
  config: DispatchConfig;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
  canOperate: boolean;
}

/**
 * Settings → Checks: everything about proving a change works. The checks the
 * merge queue runs before a branch merges, how an agent starts the app to try
 * a change by hand, and the fix loop that sends failed work back.
 */
export function ChecksSection({
  config,
  onSave,
  canOperate,
}: ChecksSectionProps) {
  const [verify, setVerify] = useState('');
  const [runCommand, setRunCommand] = useState('');
  const [runUrl, setRunUrl] = useState('');
  const [runNotes, setRunNotes] = useState('');

  // Re-seeds when config changes underneath (another window, a hand edit) —
  // keyed on config values, so a field mid-edit isn't clobbered every render.
  useEffect(() => {
    setVerify(config.verifyCommand ?? '');
    setRunCommand(config.verify?.command ?? '');
    setRunUrl(config.verify?.url ?? '');
    setRunNotes(config.verify?.notes ?? '');
  }, [config]);

  // Shared blur handler for the three try-the-app fields. Core rejects an
  // empty string for verify.command/url/notes and offers no patch shape to
  // clear one (unlike verifyCommand's `null`), so an emptied field reverts to
  // the saved value instead of sending a string the server would 400 on.
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
      <SettingsGroup
        title="Before merging"
        hint="Every branch runs these in order before it merges. A failing check stops the merge."
        keywords="verify merge queue gate"
      >
        <VerifyStepsList
          config={config}
          onSave={onSave}
          canOperate={canOperate}
        />
        <SettingsRow
          title="Single check command"
          subtitle="Runs only when there are no named checks above. Leave empty to merge without checking."
          keywords="verify command verifyCommand"
          htmlFor="verify-command"
          locked={!canOperate}
          stacked
          control={
            <Input
              id="verify-command"
              disabled={!canOperate}
              value={verify}
              onChange={(e) => setVerify(e.target.value)}
              onBlur={() => {
                const next = verify.trim();
                if (next !== (config.verifyCommand ?? '')) {
                  // Empty clears the key rather than storing an empty command:
                  // no check and a check that runs nothing differ to the queue.
                  void onSave({ verifyCommand: next === '' ? null : next });
                }
              }}
              placeholder="bun run verify"
              className="font-mono"
            />
          }
        />
        <NumberSetting
          id="verify-timeout"
          title="Time limit per check"
          subtitle="A check that runs longer fails, so it can't hold up everything behind it."
          keywords="verify timeout"
          value={config.orchestrator.verifyTimeoutSec}
          suffix="sec"
          onSave={(n) => n !== null && void onSave({ verifyTimeoutSec: n })}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Trying the change"
        hint="How an agent starts your app and uses it to test a change by hand. Separate from the checks above."
        keywords="verify run recipe manual test"
      >
        <SettingsRow
          title="Start command"
          subtitle="Starts the app."
          htmlFor="run-command"
          locked={!canOperate}
          stacked
          control={
            <Input
              id="run-command"
              disabled={!canOperate}
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
              className="font-mono"
            />
          }
        />
        <SettingsRow
          title="Address"
          subtitle="Where the running app can be reached."
          keywords="url"
          htmlFor="url"
          stacked
          control={
            <Input
              id="url"
              value={runUrl}
              onChange={(e) => setRunUrl(e.target.value)}
              onBlur={() =>
                saveRunField('url', runUrl, config.verify?.url, setRunUrl)
              }
              placeholder="http://localhost:3000"
            />
          }
        />
        <SettingsRow
          title="Notes for the agent"
          subtitle="Logins, seed data, ports: anything else it needs to know."
          htmlFor="notes"
          stacked
          control={
            <Textarea
              id="notes"
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
              placeholder="Log in as demo@example.com / demo"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Fix loop"
        hint="When a review or check finds problems, an agent goes back and fixes them."
        keywords="retry rounds"
      >
        <SwitchSetting
          id="fix-loop-auto"
          title="Start fixing automatically"
          subtitle="Send the work back as soon as problems are found, without waiting for you."
          checked={config.fixLoop.auto}
          onSave={(auto) => void onSave({ fixLoop: { auto } })}
        />
        <NumberSetting
          id="fix-loop-round-cap"
          title="Rounds before asking you"
          subtitle="After this many attempts the fix loop stops and waits for your call."
          keywords="cap limit"
          value={config.fixLoop.cap}
          onSave={(cap) => cap !== null && void onSave({ fixLoop: { cap } })}
        />
      </SettingsGroup>

      <EscalationEditor
        steps={config.fixLoop.escalation}
        onChange={(escalation) => void onSave({ fixLoop: { escalation } })}
      />
    </>
  );
}
