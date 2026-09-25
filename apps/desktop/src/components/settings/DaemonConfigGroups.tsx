import type { HealthPayload, SyncStatus } from '@dispatch/client';
import type {
  CartoMode,
  ConfigPatch,
  DispatchConfig,
} from '@dispatch/core/browser';
import { DEFAULT_RECEIPTS_BRANCH } from '@dispatch/core/browser';
import { useEffect, useState } from 'react';

import {
  ChoiceSetting,
  NumberSetting,
  OPERATOR_ONLY,
  SwitchSetting,
  TextSetting,
} from './fields';
import { SettingsGroup, SettingsRow } from './SettingsGroup';

interface Props {
  config: DispatchConfig;
  onSave: (patch: ConfigPatch) => Promise<unknown>;
  canOperate: boolean;
}

type Place = 'remote' | 'repo';

/** Where a push goes, as the one choice a person makes. */
function placeOf(target: { repo?: string }): Place {
  return target.repo === undefined ? 'remote' : 'repo';
}

/**
 * What choosing where board sync goes writes right away: going back to the
 * project's repo clears a repo of its own; choosing a repo of its own writes
 * nothing yet (null), since it has no URL until one is typed.
 */
export function syncPlacePatch(
  place: Place,
  current: { repo?: string }
): NonNullable<ConfigPatch['sync']> | null {
  if (place === 'remote')
    return current.repo === undefined ? null : { repo: null };
  return null;
}

/** The same for the receipt log, which may also go nowhere. */
export function receiptsPlacePatch(
  place: Place | 'off',
  current: { remote?: string; repo?: string }
): NonNullable<ConfigPatch['receipts']> | null {
  if (place === 'off') {
    return current.remote === undefined && current.repo === undefined
      ? null
      : { remote: null, repo: null };
  }
  if (place === 'remote') {
    return current.remote !== undefined && current.repo === undefined
      ? null
      : { repo: null, remote: current.remote ?? 'origin' };
  }
  return null;
}

/** What entering a repo of its own writes: that repo, and never a remote
 *  beside it, since the two are exclusive. */
export function ownRepoPatch(repo: string | null): {
  remote?: null;
  repo: string | null;
} {
  return repo === null ? { repo } : { remote: null, repo };
}

/**
 * How this project's board is kept, or null until known. GET /api/health says
 * so; an older daemon doesn't, but its receipt log is off exactly when its
 * board is kept as files (GET /api/sync).
 */
export function boardStorage(
  health: Pick<HealthPayload, 'storageBackend'> | undefined,
  syncStatus: Pick<SyncStatus, 'receipts'> | null
): 'files' | 'sqlite' | null {
  if (health?.storageBackend !== undefined) return health.storageBackend;
  if (syncStatus === null) return null;
  return syncStatus.receipts.state === 'disabled' ? 'files' : 'sqlite';
}

/**
 * Settings → Board sync, for a board kept in Dispatch's database: sharing it
 * with teammates' copies of Dispatch through a branch of its own in git.
 * Whether and where the board is pushed is the owner's call alone: it goes
 * out on their own git credentials.
 */
export function BoardSyncSettings({ config, onSave, canOperate }: Props) {
  const locked = canOperate ? undefined : OPERATOR_ONLY;
  const sync = config.sync ?? {
    enabled: false,
    remote: 'origin',
    branch: 'dispatch-sync',
    intervalSec: 30,
  };
  // The choice is held here, not read back from config, until it can be
  // saved: picking "a repo of its own" has nothing to write until a URL is
  // typed, and writing an empty one would snap the choice straight back.
  const savedSyncPlace = placeOf(sync);
  const [syncPlace, setSyncPlace] = useState<Place>(savedSyncPlace);
  // Follows the config when it changes underneath (a save, another window).
  useEffect(() => setSyncPlace(savedSyncPlace), [savedSyncPlace]);

  return (
    <>
      <SettingsGroup
        title="Sharing"
        hint="Changes to these take effect the next time Dispatch restarts for this project."
        keywords="sync restart"
      >
        <SwitchSetting
          id="sync-enabled"
          title="Share this board with teammates"
          subtitle="Everyone who turns this on with the same repo and branch shares one board."
          keywords="sync enabled"
          checked={sync.enabled}
          locked={locked}
          onSave={(enabled) => void onSave({ sync: { enabled } })}
        />
        <ChoiceSetting
          id="sync-place"
          title="Where the board is kept"
          value={syncPlace}
          locked={locked}
          choices={[
            { value: 'remote', label: "This project's repo" },
            { value: 'repo', label: 'A separate repo' },
          ]}
          onSave={(place) => {
            setSyncPlace(place);
            const patch = syncPlacePatch(place, sync);
            if (patch !== null) void onSave({ sync: patch });
          }}
        />
        {syncPlace === 'remote' ? (
          <TextSetting
            id="sync-remote"
            title="Remote"
            subtitle="The name of one of this project's git remotes."
            value={sync.remote}
            placeholder="origin"
            mono
            locked={locked}
            onSave={(remote) => void onSave({ sync: { remote } })}
          />
        ) : (
          <TextSetting
            id="sync-repo"
            title="Repo"
            subtitle="A git URL, or a path relative to this project."
            value={sync.repo}
            placeholder="git@github.com:acme/dispatch-board.git"
            mono
            locked={locked}
            onSave={(repo) => void onSave({ sync: ownRepoPatch(repo) })}
          />
        )}
        <TextSetting
          id="sync-branch"
          title="Branch"
          subtitle="Only the board is written here. Give each project its own if they share a repo."
          value={sync.branch}
          placeholder="dispatch-sync"
          mono
          locked={locked}
          onSave={(branch) => void onSave({ sync: { branch } })}
        />
        <NumberSetting
          id="sync-interval"
          title="Check for teammates' changes every"
          value={sync.intervalSec}
          min={5}
          suffix="sec"
          allowEmpty
          onSave={(intervalSec) => void onSave({ sync: { intervalSec } })}
        />
      </SettingsGroup>
    </>
  );
}

/**
 * Settings → Board sync, for a board kept as task files in the repo, which
 * sharing cannot carry: committing those files to the main branch instead.
 * Pushing to that branch uses the owner's git credentials, so it's theirs.
 */
export function CommitTaskFilesGroup({
  config,
  onSave,
  syncStatus,
  canOperate,
}: Props & {
  /** GET /api/sync; `disabled` on this backend means no branch resolved at boot. */
  syncStatus: SyncStatus | null;
}) {
  return (
    <SettingsGroup
      title="Task files"
      hint="This board is kept as files in the repo, not in Dispatch's database."
      keywords="board sync files git"
    >
      <SwitchSetting
        id="auto-commit"
        title="Commit task files to the main branch"
        subtitle="Commits your task edits from a private checkout, pushes them to the repo's main branch, and brings teammates' edits back in."
        keywords="autoCommit auto-commit git commit push"
        checked={config.autoCommit}
        locked={canOperate ? undefined : OPERATOR_ONLY}
        onSave={(autoCommit) => void onSave({ autoCommit })}
      />
      {syncStatus?.state === 'disabled' && (
        <SettingsRow
          title="No main branch to commit to"
          subtitle="This repo has no origin default branch and no local main or master branch. Add one, then restart Dispatch for this project."
          keywords="trunk"
        />
      )}
      <SettingsRow
        title="Sharing isn't available"
        subtitle="Sharing a board through a branch of its own works only for boards kept in Dispatch's database."
        keywords="sync share teammates"
      />
    </SettingsGroup>
  );
}

/**
 * Settings → Background: the receipt log (and where it is pushed), the code
 * map and the repo digest. Whether the log is kept, and where it is pushed,
 * is the owner's call: it is the audit trail, pushed on their credentials.
 */
export function DaemonConfigGroups({ config, onSave, canOperate }: Props) {
  const locked = canOperate ? undefined : OPERATOR_ONLY;
  const receipts = config.receipts ?? { enabled: true };
  const pushes = receipts.remote !== undefined || receipts.repo !== undefined;
  // Held here until it can be saved, for the same reason as BoardSyncSettings.
  const savedReceiptsPlace: Place | 'off' = pushes ? placeOf(receipts) : 'off';
  const [receiptsPlace, setReceiptsPlace] = useState<Place | 'off'>(
    savedReceiptsPlace
  );
  useEffect(() => setReceiptsPlace(savedReceiptsPlace), [savedReceiptsPlace]);

  return (
    <>
      <SettingsGroup
        title="Receipt log"
        hint="A record of every task, finding, decision and piece of run evidence, kept as plain files in git."
        keywords="audit trail history"
      >
        <SwitchSetting
          id="receipts-enabled"
          title="Keep a receipt log"
          checked={receipts.enabled}
          locked={locked}
          onSave={(enabled) => void onSave({ receipts: { enabled } })}
        />
        <TextSetting
          id="receipts-dir"
          title="Folder"
          subtitle="Leave empty for the default. A relative path starts from this project."
          value={receipts.dir}
          mono
          locked={locked}
          onSave={(dir) => void onSave({ receipts: { dir } })}
        />
        <ChoiceSetting
          id="receipts-place"
          title="Push it to"
          subtitle="After each change. Nowhere keeps it on this machine."
          value={receiptsPlace}
          locked={locked}
          choices={[
            { value: 'off', label: 'Nowhere' },
            { value: 'remote', label: "This project's repo" },
            { value: 'repo', label: 'A separate repo' },
          ]}
          onSave={(place) => {
            setReceiptsPlace(place);
            const patch = receiptsPlacePatch(place, receipts);
            if (patch !== null) void onSave({ receipts: patch });
          }}
        />
        {receiptsPlace === 'remote' && (
          <TextSetting
            id="receipts-remote"
            title="Remote"
            value={receipts.remote}
            placeholder="origin"
            mono
            locked={locked}
            onSave={(remote) => void onSave({ receipts: { remote } })}
          />
        )}
        {receiptsPlace === 'repo' && (
          <TextSetting
            id="receipts-repo"
            title="Repo"
            value={receipts.repo}
            placeholder="git@github.com:acme/dispatch-audit.git"
            mono
            locked={locked}
            onSave={(repo) => void onSave({ receipts: ownRepoPatch(repo) })}
          />
        )}
        {receiptsPlace !== 'off' && (
          <TextSetting
            id="receipts-branch"
            title="Branch"
            subtitle="Use one branch per machine; each keeps its own history."
            value={receipts.branch}
            placeholder={DEFAULT_RECEIPTS_BRANCH}
            mono
            locked={locked}
            onSave={(branch) => void onSave({ receipts: { branch } })}
          />
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Code understanding"
        hint="What agents are told about your codebase before they start."
      >
        <ChoiceSetting<CartoMode>
          id="carto"
          title="Code map"
          subtitle="Shows what a change affects. Uses Carto when available, a simpler built-in scan otherwise."
          keywords="carto dependency graph impact"
          value={config.carto.enabled}
          choices={[
            { value: 'detect', label: 'Carto if installed' },
            { value: 'on', label: 'Always Carto' },
            { value: 'off', label: 'Built-in only' },
          ]}
          onSave={(enabled) => void onSave({ carto: { enabled } })}
        />
        <SwitchSetting
          id="repo-digest"
          title="Repo summary"
          subtitle="A short overview of the repository, given to agents when they start."
          keywords="digest"
          checked={config.repoDigest.enabled}
          onSave={(enabled) => void onSave({ repoDigest: { enabled } })}
        />
        <NumberSetting
          id="repo-digest-cooldown"
          title="Refresh the summary at most every"
          keywords="digest cooldown"
          value={config.repoDigest.cooldownHours}
          suffix="hours"
          allowEmpty
          onSave={(cooldownHours) =>
            void onSave({ repoDigest: { cooldownHours } })
          }
        />
      </SettingsGroup>
    </>
  );
}
