import type { DispatchConfig } from '@dispatch/core/browser';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { HintText, Panel, PanelHeader, PanelRow } from '@/ui/chrome';
import { Input } from '@/ui/input';

interface GeneralSectionProps {
  config: DispatchConfig;
  onSave: (patch: {
    verifyCommand?: string | null;
    autoCommit?: boolean;
    verifyTimeoutSec?: number;
  }) => Promise<void>;
}

/**
 * Before-anything-lands settings: the merge queue's verify command, whether an
 * agent may commit its own work, and how long one verify run gets before it's
 * treated as hung. Ported from the old `ProjectSettingsSection`, minus the
 * concurrency/permission-mode controls that move to their own section.
 */
export function GeneralSection({ config, onSave }: GeneralSectionProps) {
  const [verify, setVerify] = useState('');
  const [timeoutSec, setTimeoutSec] = useState('600');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seeded from the loaded config, and re-seeded if it changes underneath (another window, or a
  // hand edit to the file) — but only into fields the user is not mid-edit on, which is why this
  // keys on the config values rather than running once.
  useEffect(() => {
    setVerify(config.verifyCommand ?? '');
    setTimeoutSec(String(config.orchestrator.verifyTimeoutSec));
  }, [config]);

  async function save(patch: Parameters<typeof onSave>[0]) {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await onSave(patch);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel>
      <PanelHeader>Before anything lands</PanelHeader>

      <PanelRow className="flex-col items-stretch gap-1.5">
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
              void save({ verifyCommand: next === '' ? null : next });
            }
          }}
          placeholder="bun run verify"
          className="font-mono text-[12.5px]"
        />
        <HintText>
          Runs in the merge queue before a branch lands. Leave empty to skip
          verification entirely.
        </HintText>
      </PanelRow>

      <PanelRow>
        <input
          type="checkbox"
          checked={config.autoCommit}
          onChange={(e) => void save({ autoCommit: e.target.checked })}
          className="accent-accent size-3.5"
        />
        <span className="text-[13px]">
          Let an agent commit its own work as it goes
        </span>
      </PanelRow>

      <PanelRow className="flex-col items-stretch gap-1.5">
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
              void save({ verifyTimeoutSec: n });
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
          Ceiling on one verify run, in seconds. The merge queue is serial, so a
          verify that never returns holds up every entry behind it.
        </HintText>
      </PanelRow>

      <PanelRow className="h-9">
        {saving && <span className="dense-meta">Saving…</span>}
        {saved && !saving && (
          <span className="dense-meta text-state-review">
            Saved to .dispatch/config.yml
          </span>
        )}
        {error !== null && (
          <span className={cn('text-[12px]', 'text-state-failed')}>
            {error}
          </span>
        )}
      </PanelRow>
    </Panel>
  );
}
