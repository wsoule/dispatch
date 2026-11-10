import type { ConfigPatch, DispatchConfig } from '@dispatch-foo/core/browser';
import { previewSettings } from '@dispatch-foo/core/browser';

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
 * Settings → Checks → Previews: whether a run's Preview tab may start its dev
 * server (config `preview`), and how. The commands run inside the run's
 * worktree on this machine, so only whoever runs the daemon changes them.
 */
export function PreviewsGroup({ config, onSave, canOperate }: Props) {
  // The block is optional in a config; this fills in its defaults.
  const preview = previewSettings(config);
  const locked = canOperate ? undefined : OPERATOR_ONLY;
  return (
    <SettingsGroup
      title="Previews"
      hint="Pressing Start on a run's Preview tab runs its app from the run's own checkout, for you to try. Empty fields use the defaults."
      keywords="preview live previews dev server timing timeout"
    >
      <SwitchSetting
        id="preview-enabled"
        title="Allow previews"
        checked={preview.enabled}
        onSave={(enabled) => void onSave({ preview: { enabled } })}
      />
      <TextSetting
        id="preview-command"
        title="Preview start command"
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
      <NumberSetting
        id="preview-ready"
        title="Time to start"
        subtitle="The preview fails if the app hasn't answered by then."
        keywords="timeout"
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
        subtitle="An idle preview is stopped to free up the machine."
        keywords="idle timeout"
        value={preview.idleTimeoutSec}
        suffix="sec"
        allowEmpty
        onSave={(idleTimeoutSec) =>
          void onSave({ preview: { idleTimeoutSec } })
        }
      />
    </SettingsGroup>
  );
}
