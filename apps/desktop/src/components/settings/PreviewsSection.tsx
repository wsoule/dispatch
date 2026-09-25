import type { ConfigPatch, DispatchConfig } from '@dispatch/core/browser';
import { previewSettings } from '@dispatch/core/browser';

import {
  NumberSetting,
  OPERATOR_ONLY,
  SwitchSetting,
  TextSetting,
} from './fields';
import { SettingsGroup } from './SettingsGroup';

interface Props {
  config: DispatchConfig;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
  canOperate: boolean;
}

/**
 * Settings → Previews: whether a task's Preview tab may start the run's dev
 * server, and how. The commands run inside the run's worktree on this
 * machine, so only whoever runs the daemon changes them.
 */
export function PreviewsSection({ config, onSave, canOperate }: Props) {
  // The block is optional in a config; this fills in its defaults.
  const preview = previewSettings(config);
  const locked = canOperate ? undefined : OPERATOR_ONLY;
  return (
    <>
      <SettingsGroup
        title="Live previews"
        hint="Pressing Start on a run's Preview tab runs its app from the run's own checkout."
        keywords="dev server"
      >
        <SwitchSetting
          id="preview-enabled"
          title="Allow previews"
          checked={preview.enabled}
          onSave={(enabled) => void onSave({ preview: { enabled } })}
        />
        <TextSetting
          id="preview-command"
          title="Start command"
          subtitle="Leave empty to use package.json's dev script, or start if there isn't one."
          keywords="dev server"
          value={preview.command}
          placeholder="pnpm dev --port $PORT"
          mono
          locked={locked}
          onSave={(command) => void onSave({ preview: { command } })}
        />
        <TextSetting
          id="preview-install"
          title="Install command"
          subtitle="Runs first when the checkout has no node_modules yet."
          value={preview.installCommand}
          placeholder="pnpm install"
          mono
          locked={locked}
          onSave={(installCommand) =>
            void onSave({ preview: { installCommand } })
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Timing" keywords="timeout">
        <NumberSetting
          id="preview-ready"
          title="Time to start"
          subtitle="The preview fails if the app hasn't answered by then. Leave empty for the default."
          value={preview.readyTimeoutSec}
          suffix="sec"
          allowEmpty
          onSave={(readyTimeoutSec) =>
            void onSave({ preview: { readyTimeoutSec } })
          }
        />
        <NumberSetting
          id="preview-idle"
          title="Stop when unused for"
          subtitle="An idle preview is stopped to free up the machine. Leave empty for the default."
          keywords="idle"
          value={preview.idleTimeoutSec}
          suffix="sec"
          allowEmpty
          onSave={(idleTimeoutSec) =>
            void onSave({ preview: { idleTimeoutSec } })
          }
        />
      </SettingsGroup>
    </>
  );
}
