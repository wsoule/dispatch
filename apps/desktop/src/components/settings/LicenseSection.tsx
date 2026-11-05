import type { LicenseStatus, TeamKeys } from '@dispatch/client';
import { Button, cx, TextField } from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useTeamOn } from '../../hooks/useTeamOn';
import styles from './LicenseSection.module.css';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';

interface LicenseSectionProps {
  data: DispatchProjectData;
}

/** The plan in one line: who it covers, and until when. */
export function planLine(status: LicenseStatus): string {
  if (status.kind === 'licensed') {
    const until =
      status.expiresAt === null
        ? ''
        : `, until ${status.expiresAt.slice(0, 10)}`;
    return `Licensed to ${status.org ?? 'your organization'} for ${status.seats} people${until}`;
  }
  return `Free plan: up to ${status.seats} people`;
}

/**
 * Settings → License: how many people may use Dispatch together on this
 * project, how many seats are taken, and where to install a key for more.
 * Solo and small teams never need one; the page is here so the limit is
 * never a surprise and adding seats never needs a terminal.
 */
export function LicenseSection({ data }: LicenseSectionProps) {
  const { client, myTier } = data;
  const queryClient = useQueryClient();
  const key = ['dispatch-license', client?.baseUrl];
  const license = useQuery({
    queryKey: key,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchLicense();
    },
    enabled: client !== null,
  });
  // A founded team shares one key (Task 13). The keys route answers 409
  // while board sync is off (or on a daemon without federation), so the
  // team status says first whether there is a team to ask about; until it
  // does, the team rows stay away. Unlike MachinesGroup, a status that
  // could not be read does not go on to ask for the keys: Machines shows a
  // keys failure and its reason, this section only ever hides its team
  // rows on one, and every daemon serving the keys route serves the status
  // route too, so asking could only add the refused request.
  const teamOn = useTeamOn(client);
  const team = useQuery({
    queryKey: ['team-keys', client?.baseUrl],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getTeamKeys();
    },
    enabled: client !== null && teamOn,
    retry: false,
  });
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = license.data;
  if (status === undefined) return null;
  const canInstall = myTier === 'operator';

  async function share() {
    if (client === null || sharing) return;
    setSharing(true);
    setShareError(null);
    try {
      await client.shareTeamLicense();
      await queryClient.invalidateQueries({
        queryKey: ['team-keys', client.baseUrl],
      });
    } catch (err) {
      setShareError(err instanceof Error ? err.message : String(err));
    } finally {
      setSharing(false);
    }
  }

  async function install() {
    const trimmed = draft.trim();
    if (client === null || trimmed === '' || pending) return;
    setPending(true);
    setError(null);
    try {
      queryClient.setQueryData(key, await client.installLicense(trimmed));
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <SettingsGroup
        title="Plan"
        requires="none"
        hint="Free for up to three people, with every feature. More people need a license key."
        keywords="seats billing"
      >
        <SettingsRow
          title={planLine(status)}
          subtitle={`${status.used} of ${status.seats} seats used: you and everyone with an active invite.`}
        >
          {status.kind === 'expired' && (
            <SettingsHint tone="warning">
              The license for {status.org} expired on{' '}
              {status.expiresAt?.slice(0, 10)}. The free plan applies until you
              add a new key; the people invited first keep their seats.
            </SettingsHint>
          )}
          {status.kind === 'invalid' && status.reason !== null && (
            <SettingsHint tone="warning">
              The installed key was not accepted: {status.reason}.
            </SettingsHint>
          )}
        </SettingsRow>
      </SettingsGroup>

      {team.data?.team != null && (
        <TeamLicenseGroup
          keys={team.data}
          licensed={status.kind === 'licensed'}
          canShare={canInstall}
          sharing={sharing}
          error={shareError}
          onShare={() => void share()}
        />
      )}

      <SettingsGroup title="License key" keywords="install" requires="none">
        {canInstall ? (
          <SettingsRow title="Paste a key" htmlFor="license-key" stacked>
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                void install();
              }}
            >
              <TextField
                id="license-key"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="dispatch1.…"
                spellCheck={false}
                autoComplete="off"
                className={styles.key}
              />
              <Button
                type="submit"
                variant="primary"
                icon={<KeyRound size={14} strokeWidth={1.8} />}
                disabled={draft.trim() === '' || pending}
              >
                {pending ? 'Checking…' : 'Install'}
              </Button>
            </form>
            <SettingsHint className={styles.spaced}>
              Checked on this machine; nothing is sent anywhere. An invalid key
              is refused and the current one stays.
            </SettingsHint>
            {error !== null && (
              <p
                role="alert"
                className={cx('toneText', styles.error)}
                data-tone="danger"
              >
                {error}
              </p>
            )}
          </SettingsRow>
        ) : (
          <SettingsRow
            title="Add a key"
            subtitle="Ask the person running Dispatch for this project to add it here, or with dispatch license set."
            locked
          />
        )}
      </SettingsGroup>
    </>
  );
}

interface TeamLicenseGroupProps {
  keys: TeamKeys;
  licensed: boolean;
  canShare: boolean;
  sharing: boolean;
  error: string | null;
  onShare: () => void;
}

/** The team's key: whose the team uses, and Share with the team on an
 *  admin's machine that holds a licensed key. */
function TeamLicenseGroup({
  keys,
  licensed,
  canShare,
  sharing,
  error,
  onShare,
}: TeamLicenseGroupProps) {
  const mine = keys.roster.find((m) => m.replica === keys.machine.replica);
  const shared = keys.license;
  return (
    <SettingsGroup title="Team" keywords="share license team" requires="none">
      {shared !== null && shared.sharedBy !== null && (
        <SettingsRow
          title={`Your team uses ${shared.sharedBy}'s key: ${shared.org ?? 'a license'}, ${shared.seats} people`}
        />
      )}
      {licensed && mine?.role === 'admin' && (
        <SettingsRow
          title="Share this key with the team"
          subtitle="Every machine on the team then counts seats by it."
          locked={!canShare}
          control={
            canShare ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={sharing}
                onClick={onShare}
              >
                Share with the team
              </Button>
            ) : undefined
          }
        >
          {error !== null && (
            <p
              role="alert"
              className={cx('toneText', styles.error)}
              data-tone="danger"
            >
              {error}
            </p>
          )}
        </SettingsRow>
      )}
      {licensed && mine?.role === 'member' && (
        <SettingsRow title="Ask an admin to share this key with your team" />
      )}
    </SettingsGroup>
  );
}
