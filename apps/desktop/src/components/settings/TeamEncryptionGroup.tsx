import type { ContentE2eStatus } from '@dispatch/client';
import { isInsufficientTier } from '@dispatch/client';
import { Button, Chip, ConfirmDialog } from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { NEEDS_DECIDE, useSettingsAccess } from './access';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import styles from './TeamEncryptionGroup.module.css';

interface TeamEncryptionGroupProps {
  data: DispatchProjectData;
}

const WHAT_IT_DOES =
  'Encrypts the board, team memory, team docs, presence and agents so the relay and the sync branch carry only ciphertext. Only the team’s machines hold the keys.';

/** What turning it on does not cover; the CLI's `team encrypt --on` says the same. */
const ENCRYPT_LIMITS = [
  'Anything the team published before stays readable on the relay. Board history is never pruned; starting a new team is the only way to purge it.',
  'A removed teammate keeps what they already received.',
  'One key covers everything until the next removal, so there is no forward secrecy within it.',
  'The relay still sees who published each change, when, its type and size, and the roster with the license.',
];

export const NOT_ADMIN = 'Only a team admin can turn this on.';
export const LEGACY_OPEN =
  'Close the window for older Dispatch builds under Machines first.';
export const NEEDS_UPDATE =
  'Every teammate needs a Dispatch build that reads encrypted content first.';

/** Why the switch is off for this viewer, or null when it can be pressed. */
function encryptBlocker(
  s: ContentE2eStatus,
  access: { canOperate: boolean; operateReason: string },
  isAdmin: boolean
): string | null {
  if (!access.canOperate) return access.operateReason;
  if (!isAdmin) return NOT_ADMIN;
  if (!s.legacyClosed) return LEGACY_OPEN;
  if (s.lacking.length > 0) return NEEDS_UPDATE;
  return null;
}

// A status chip: a coloured dot and a word.
function StatePill({
  tone,
  children,
}: {
  tone: 'good' | 'waiting';
  children: string;
}) {
  return <Chip tone={tone === 'good' ? 'success' : 'warning'}>{children}</Chip>;
}

/**
 * Settings → Members, "End-to-end encryption": whether the team's content is
 * sealed from the relay, what still blocks turning it on (older builds, a
 * teammate's build), the one-way switch behind a confirm that states its
 * limits, and once on, whether this machine holds every key.
 */
export function TeamEncryptionGroup({ data }: TeamEncryptionGroupProps) {
  const { client } = data;
  const access = useSettingsAccess();
  const queryClient = useQueryClient();
  const team = useQuery({
    queryKey: ['team-status', client?.baseUrl],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getTeamStatus();
    },
    enabled: client !== null,
    retry: false,
    refetchInterval: 15_000,
  });
  const inTeam = team.data?.state === 'member';
  const key = ['team-content-e2e', client?.baseUrl];
  const status = useQuery({
    queryKey: key,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getContentE2e();
    },
    enabled: client !== null && inTeam,
    retry: false,
    refetchInterval: 30_000,
  });
  // The relay disclosure for the team as it is now, shown once it is on.
  const keys = useQuery({
    queryKey: ['team-keys', client?.baseUrl],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getTeamKeys();
    },
    enabled: client !== null && inTeam && status.data?.on === true,
    retry: false,
    refetchInterval: 30_000,
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (client === null || !inTeam) return null;
  const api = client;

  async function turnOn() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await api.enableContentE2e();
      setPending(answer.pending === true);
      queryClient.setQueryData(key, answer);
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({
        queryKey: ['team-keys', api.baseUrl],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const group = (children: ReactNode) => (
    <SettingsGroup
      title="End-to-end encryption"
      hint={WHAT_IT_DOES}
      keywords="encrypt encryption e2e relay privacy sealed keys"
      requires="none"
    >
      {children}
    </SettingsGroup>
  );

  if (status.isError) {
    return group(
      isInsufficientTier(status.error) ? (
        <SettingsRow
          title="Encryption status"
          subtitle={NEEDS_DECIDE}
          locked={NEEDS_DECIDE}
        />
      ) : (
        <SettingsRow
          title="Couldn’t read the encryption status"
          subtitle={
            <span className={styles.error}>{status.error.message}</span>
          }
        />
      )
    );
  }
  if (status.data === undefined) return group(<SettingsRow title="Reading…" />);
  const s = status.data;

  if (s.on) {
    const held = s.epochs.filter((e) => e.held).length;
    return group(
      <>
        <SettingsRow
          title={
            s.sinceAt === null
              ? 'On'
              : `On since ${new Date(s.sinceAt).toLocaleDateString([], { dateStyle: 'medium' })}`
          }
          subtitle={
            <span data-testid="team-e2e-disclosure">
              {keys.data?.relayDisclosure ??
                'The relay carries only ciphertext for team content.'}
            </span>
          }
          control={<StatePill tone="good">On</StatePill>}
        />
        <SettingsRow
          title={
            s.missing.length === 0
              ? 'This machine holds every key'
              : 'Waiting for a key from a teammate'
          }
          subtitle={
            s.missing.length === 0
              ? `${held} of ${s.epochs.length}. A new key starts with each removal from the team.`
              : 'This machine asked for it; a teammate’s machine sends it on their next sync. Until then, team changes made here are refused.'
          }
          control={
            <StatePill tone={s.missing.length === 0 ? 'good' : 'waiting'}>
              {`${held} of ${s.epochs.length} keys`}
            </StatePill>
          }
        />
        {pending && (
          <SettingsHint className={styles.note}>
            Turned on here; it reaches the team on the next sync.
          </SettingsHint>
        )}
      </>
    );
  }

  const isAdmin = team.data?.role === 'admin';
  const blocker = encryptBlocker(s, access, isAdmin);
  return group(
    <>
      <SettingsRow
        title="Older Dispatch builds"
        subtitle={
          s.legacyClosed
            ? 'No longer sync with this team.'
            : 'Still sync with this team, and copy the board in the clear.'
        }
        control={
          <StatePill tone={s.legacyClosed ? 'good' : 'waiting'}>
            {s.legacyClosed ? 'Closed' : 'Open'}
          </StatePill>
        }
      />
      <SettingsRow
        title="Teammates’ Dispatch"
        subtitle={
          s.lacking.length === 0 ? (
            'Every teammate’s build reads encrypted content.'
          ) : (
            <span data-testid="team-e2e-lacking">
              Still need to update: {s.lacking.map((l) => l.handle).join(', ')}
            </span>
          )
        }
        control={
          <StatePill tone={s.lacking.length === 0 ? 'good' : 'waiting'}>
            {s.lacking.length === 0
              ? 'Up to date'
              : `${s.lacking.length} to update`}
          </StatePill>
        }
      />
      <SettingsRow
        title="Encrypt team content"
        subtitle={
          blocker ?? 'Turns on for the whole team. It cannot be turned off.'
        }
        locked={access.canOperate ? false : access.operateReason}
        control={
          <Button
            size="sm"
            data-testid="team-e2e-on"
            disabled={busy || blocker !== null}
            title={blocker ?? undefined}
            onClick={() => setConfirming(true)}
          >
            Encrypt team content
          </Button>
        }
      >
        {error !== null && (
          <span role="alert" className={styles.alert}>
            {error}
          </span>
        )}
      </SettingsRow>
      <ConfirmDialog
        open={confirming}
        title="Encrypt team content for good?"
        confirmLabel="Encrypt team content"
        data-testid="team-e2e-confirm"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void turnOn();
        }}
      >
        <div className={styles.confirm}>
          <p>
            From now on the relay carries only ciphertext for the board, team
            memory, team docs, presence and agents. It cannot be turned off.
            What it does not do:
          </p>
          <ul className={styles.limits}>
            {ENCRYPT_LIMITS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </ConfirmDialog>
    </>
  );
}
