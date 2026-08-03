import type { DispatchConfig } from '@dispatch/core/browser';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

interface ProjectSettingsSectionProps {
  config: DispatchConfig | null;
  onSave: (patch: {
    verifyCommand?: string | null;
    autoCommit?: boolean;
    epicConcurrency?: number;
    permissionMode?: string;
  }) => Promise<void>;
}

/**
 * The writable half of Settings: what the project's `.dispatch/config.yml` says about verifying,
 * committing, concurrency and how much an agent may do unasked.
 *
 * Every control here persists to the repo's own config file, which is the point — these are
 * project settings, not app preferences, so they belong in the checked-in file where a teammate
 * (and the CLI, and the daemon) sees the same values. `statuses` is deliberately absent: every
 * task on disk carries one, so editing that list from a form would orphan tasks whose status
 * stopped existing. That one stays a deliberate file edit.
 */
export function ProjectSettingsSection({
  config,
  onSave,
}: ProjectSettingsSectionProps) {
  const [verify, setVerify] = useState('');
  const [concurrency, setConcurrency] = useState('3');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seeded from the loaded config, and re-seeded if it changes underneath (another window, or a
  // hand edit to the file) — but only into fields the user is not mid-edit on, which is why this
  // keys on the config values rather than running once.
  useEffect(() => {
    if (config === null) return;
    setVerify(config.verifyCommand ?? '');
    setConcurrency(String(config.orchestrator.epicConcurrency));
  }, [config]);

  if (config === null) return null;

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
    <section className="flex flex-col gap-4">
      <h2 className="dense-label">Before anything lands</h2>

      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-[12px]">
          Verify command
        </span>
        <input
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
          className="shadow-hairline rounded-md px-2 py-1.5 font-mono text-[12.5px] outline-none"
        />
        <span className="text-muted-foreground text-[11px]">
          Runs in the merge queue before a branch lands. Leave empty to skip
          verification entirely.
        </span>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={config.autoCommit}
          onChange={(e) => void save({ autoCommit: e.target.checked })}
          className="accent-accent size-3.5"
        />
        <span className="text-[13px]">
          Let an agent commit its own work as it goes
        </span>
      </label>

      <h2 className="dense-label mt-2">Agents</h2>

      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-[12px]">
          How many run at once when you dispatch an epic
        </span>
        <input
          value={concurrency}
          onChange={(e) => setConcurrency(e.target.value)}
          onBlur={() => {
            const n = Number(concurrency);
            if (
              Number.isInteger(n) &&
              n >= 1 &&
              n !== config.orchestrator.epicConcurrency
            ) {
              void save({ epicConcurrency: n });
            } else {
              // Snap a nonsense value back rather than leaving the field showing something the
              // config does not actually say.
              setConcurrency(String(config.orchestrator.epicConcurrency));
            }
          }}
          inputMode="numeric"
          className="shadow-hairline w-20 rounded-md px-2 py-1.5 font-mono text-[12.5px] outline-none"
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-[12px]">
          When an agent wants to do something consequential
        </span>
        {(
          [
            ['default', 'Always ask me first'],
            ['acceptEdits', 'Let it edit files, ask before anything else'],
            ['dontAsk', 'Never ask — let it run'],
          ] as const
        ).map(([mode, label]) => (
          <label key={mode} className="flex items-center gap-2">
            <input
              type="radio"
              name="permission-mode"
              checked={config.orchestrator.permissionMode === mode}
              onChange={() => void save({ permissionMode: mode })}
              className="accent-accent size-3.5"
            />
            <span className="text-[13px]">{label}</span>
          </label>
        ))}
        {/* The stored value can be one of six modes; the three above are the ones worth
            offering. If the file says something else, say so rather than silently showing
            none of the radios selected. */}
        {!['default', 'acceptEdits', 'dontAsk'].includes(
          config.orchestrator.permissionMode
        ) && (
          <span className="dense-meta">
            currently “{config.orchestrator.permissionMode}”, set in
            .dispatch/config.yml
          </span>
        )}
      </div>

      <div className="flex h-4 items-center gap-2">
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
      </div>
    </section>
  );
}
