import type { TeamInvite, TeamStatus } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { Button, TextField } from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useSettingsAccess } from './access';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { StartTeamRow } from './StartTeamRow';
import { TakeOverDaemon } from './TakeOverDaemon';
import { CopyButton } from './TeamSection';
import styles from './TeamSetupGroup.module.css';

interface TeamSetupGroupProps {
  data: DispatchProjectData;
}

// What the invited person does with the link, on their own machine. Shown
// with the link so whoever sends it can pass the steps along.
const JOIN_STEPS =
  'On their machine: open Dispatch, go to Settings → Members, and paste it under Join a team. Or run dispatch team join in a terminal and paste it there. When they join, their name shows above with an optional check you can read together.';

// Shown beside "Start a team" so pressing it is the confirmation the relay
// switch needs (F-D31); a new team starts unencrypted, so this is the off text.
const RELAY_DISCLOSURE =
  'Your team syncs through relay.dispatch.foo. The relay can read everything that is not sealed: the board, team memory and team docs, the roster, presence, and who messaged whom and when. It cannot read message contents. Once the team is set up, an admin can turn on end-to-end encryption below so the relay carries only ciphertext for team content.';

/**
 * Settings → Team, top: the team in one line, and the three things a person
 * does to set one up — start it, invite a teammate (one link to copy), or
 * join with a link someone sent. Every word shown comes from the daemon,
 * which cleans what it repeats from links and peers; React renders it as
 * text only.
 */
export function TeamSetupGroup({ data }: TeamSetupGroupProps) {
  const { client } = data;
  const { canOperate, operateReason } = useSettingsAccess();
  const queryClient = useQueryClient();
  const key = ['team-status', client?.baseUrl];
  const status = useQuery({
    queryKey: key,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getTeamStatus();
    },
    enabled: client !== null,
    retry: false,
    refetchInterval: 15_000,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [inviteFor, setInviteFor] = useState('');
  const [invite, setInvite] = useState<TeamInvite | null>(null);
  const [link, setLink] = useState('');
  const [check, setCheck] = useState<string | null>(null);
  // An invite whose board repo is local or private waits here, with the
  // daemon's warning, until the person joins anyway or cancels.
  const [repoWarning, setRepoWarning] = useState<{
    code: string;
    message: string;
  } | null>(null);

  // Runs one team action, then reads the status (and the details) again.
  async function act(change: () => Promise<void>) {
    if (client === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await change();
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({
        queryKey: ['team-keys', client.baseUrl],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Joins with a pasted link; `confirm_repo` is held for the person to decide.
  function join(code: string, confirmRepo = false) {
    if (client === null) return;
    const api = client;
    void act(async () => {
      try {
        const joined = confirmRepo
          ? await api.joinTeam(code, { confirmRepo: true })
          : await api.joinTeam(code);
        setLink('');
        setRepoWarning(null);
        setCheck(joined.check ?? null);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'confirm_repo') {
          setRepoWarning({ code, message: err.message });
          return;
        }
        throw err;
      }
    });
  }

  if (client === null || status.data === undefined) return null;
  const s: TeamStatus = status.data;
  const api = client;
  const isAdmin = s.role === 'admin';
  const canInvite = canOperate && s.state === 'member' && s.role !== 'observer';
  // The owner's own window, attached to a daemon it did not start: offer the
  // restart that unlocks these rows rather than hiding them without a word.
  const locked =
    !canOperate &&
    data.takeover !== null &&
    (s.state !== 'member' || s.role !== 'observer');

  return (
    <SettingsGroup
      title="Your team"
      keywords="team start invite join link relay status"
      requires="none"
    >
      <SettingsRow
        title={<span data-testid="team-status-line">{s.line}</span>}
        subtitle={
          s.check !== null
            ? `Optional check: read “${s.check}” with whoever invited you; their Dispatch shows the same.`
            : undefined
        }
      />
      {s.teammates
        .filter((t) => !t.you && t.check !== null)
        .map((t) => (
          <SettingsRow
            key={`${t.handle}-${t.device}`}
            title={`${t.handle}${t.device === '' ? '' : ` on ${t.device}`}`}
            subtitle={`${t.role} · optional check ${t.check ?? ''}`}
          />
        ))}
      {s.problems.map((p) => (
        <SettingsRow
          key={p.message}
          title={
            <span data-tone="warning" className={styles.warning}>
              {p.message}
            </span>
          }
          subtitle={
            p.fix === null ? undefined : <span className="mono">{p.fix}</span>
          }
        />
      ))}

      {locked && data.takeover !== null && (
        <SettingsRow
          title={
            s.state === 'member' ? 'Invite teammate' : 'Start or join a team'
          }
          subtitle={operateReason}
          stacked
        >
          <TakeOverDaemon
            takeover={data.takeover}
            onRestart={data.handleRestartDaemon}
          />
        </SettingsRow>
      )}
      {canOperate && (s.state === 'none' || s.state === 'off') && (
        <StartTeamRow
          sync={data.config?.sync}
          disclosure={RELAY_DISCLOSURE}
          busy={busy}
          onStart={(input) =>
            void act(async () => {
              const started = await api.startTeam(input);
              setRecovery(started.recoveryCode);
              setNotice(started.notice);
            })
          }
        />
      )}
      {recovery !== null && (
        <SettingsRow
          title="Recovery code"
          subtitle="Store this where you keep other recovery codes; it is the only way back in if every admin machine is lost. It is shown once."
          stacked
          control={
            <div className={styles.line}>
              <code data-testid="team-recovery-code" className={styles.secret}>
                {recovery}
              </code>
              <Button
                size="sm"
                variant="quiet"
                onClick={() => setRecovery(null)}
              >
                Done
              </Button>
            </div>
          }
        />
      )}
      {notice !== null && (
        <SettingsHint className={styles.note}>{notice}</SettingsHint>
      )}

      {canInvite && (
        <SettingsRow
          title="Invite teammate"
          subtitle="Makes a link to send them. It works once, for 7 days."
          htmlFor="team-invite-link-for"
          control={
            <form
              className={styles.line}
              onSubmit={(e) => {
                e.preventDefault();
                const who = inviteFor.trim();
                if (who === '') return;
                void act(async () => {
                  setInvite(await api.inviteToTeam(who));
                  setInviteFor('');
                });
              }}
            >
              <TextField
                id="team-invite-link-for"
                size="sm"
                aria-label="Email or handle to invite"
                placeholder="email or handle"
                className={styles.inviteInput}
                value={inviteFor}
                onChange={(e) => setInviteFor(e.target.value)}
              />
              {/* Gr8r's Button takes no data-*, so the test hook wraps it. */}
              <span data-testid="team-invite" className={styles.hook}>
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || inviteFor.trim() === ''}
                >
                  Invite teammate
                </Button>
              </span>
            </form>
          }
        />
      )}
      {invite !== null && (
        <SettingsRow
          title={`Send this privately: anyone holding it can join as ${invite.handle} until ${invite.expires.slice(0, 10)}`}
          subtitle={JOIN_STEPS}
          stacked
        >
          <div className={styles.line}>
            <code data-testid="team-invite-link" className={styles.code}>
              {invite.link ?? invite.code}
            </code>
            <CopyButton
              value={invite.link ?? invite.code}
              label="invite link"
            />
          </div>
        </SettingsRow>
      )}

      {canOperate && (s.state === 'none' || s.state === 'off') && (
        <SettingsRow
          title="Join a team"
          subtitle="Paste the link a teammate sent you."
          htmlFor="team-join-link"
          control={
            <form
              className={styles.line}
              onSubmit={(e) => {
                e.preventDefault();
                const pasted = link.trim();
                if (pasted === '') return;
                join(pasted);
              }}
            >
              <TextField
                id="team-join-link"
                size="sm"
                type="password"
                autoComplete="off"
                aria-label="Invite link"
                placeholder="dispatch-team:…"
                className={styles.joinInput}
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
              <span data-testid="team-join" className={styles.hook}>
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || link.trim() === ''}
                >
                  Join
                </Button>
              </span>
            </form>
          }
        />
      )}
      {repoWarning !== null && (
        <SettingsRow
          title="Check where this team keeps its board"
          subtitle={
            <span data-testid="team-join-repo-warning">
              {repoWarning.message}
            </span>
          }
          control={
            <div className={styles.line}>
              <Button
                size="sm"
                variant="quiet"
                disabled={busy}
                onClick={() => setRepoWarning(null)}
              >
                Cancel
              </Button>
              <span
                data-testid="team-join-confirm-repo"
                className={styles.hook}
              >
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => join(repoWarning.code, true)}
                >
                  Join anyway
                </Button>
              </span>
            </div>
          }
        />
      )}
      {check !== null && s.state !== 'member' && (
        <SettingsHint className={styles.note}>
          <span data-testid="team-join-check">
            Joined. Optional check: read “{check}” with whoever invited you.
          </span>
        </SettingsHint>
      )}
      {isAdmin && s.problems.length === 0 && s.seats !== null && (
        <SettingsHint className={styles.note}>
          You are an admin: you can admit and remove machines under Machines
          below.
        </SettingsHint>
      )}
      {error !== null && (
        <SettingsRow
          title="That didn’t go through"
          subtitle={
            <span role="alert" className={styles.error}>
              {error}
            </span>
          }
        />
      )}
    </SettingsGroup>
  );
}
