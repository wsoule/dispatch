import type { TeamKeys } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useSettingsAccess } from './access';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { Pill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

interface MachinesGroupProps {
  data: DispatchProjectData;
}

// The daemon's answer while board sync is off: there is no team to show.
const SYNC_OFF = 'board sync is not on';
// Notes a person may acknowledge; mirrors the server's list in routes.ts.
const ACKNOWLEDGEABLE = [
  'team:race:',
  'team:cut:',
  'transport:merge',
  'team:route',
];

/** A fingerprint as typed: case and dashes do not matter. */
function sameFingerprint(typed: string, fingerprint: string): boolean {
  const norm = (s: string) => s.replace(/[^0-9a-z]/gi, '').toUpperCase();
  return norm(typed) !== '' && norm(typed) === norm(fingerprint);
}

/** The sync branch's size: GiB with one decimal, or MiB below 1 GiB. */
function branchSize(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 1
    ? `${gib.toFixed(1)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

/**
 * Settings → Team → Machines: the signed team of machines that sync this
 * board (`dispatch team keys` for someone who does not live in a terminal).
 * The decide tier sees every fact; only the operator gets the controls, as
 * every roster change signs with this machine's key.
 */
export function MachinesGroup({ data }: MachinesGroupProps) {
  const { client } = data;
  const { canOperate } = useSettingsAccess();
  const queryClient = useQueryClient();
  const key = ['team-keys', client?.baseUrl];
  const keys = useQuery({
    queryKey: key,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getTeamKeys();
    },
    enabled: client !== null,
    refetchInterval: 30_000,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<{
    replica: string;
    handle: string;
    reason: string;
  } | null>(null);

  // Runs one roster change, then reads the team again.
  async function act(change: () => Promise<unknown>) {
    if (client === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await change();
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (keys.isPending) {
    return (
      <SettingsGroup title="Machines" keywords="team keys" requires="none">
        <SettingsRow title="Reading the team…" />
      </SettingsGroup>
    );
  }
  if (keys.isError) {
    const message = keys.error.message;
    if (message.includes(SYNC_OFF)) return null;
    return (
      <SettingsGroup title="Machines" keywords="team keys" requires="none">
        <SettingsRow
          title="Couldn’t read the team"
          subtitle={<span className="text-state-failed">{message}</span>}
        />
      </SettingsGroup>
    );
  }
  const k: TeamKeys = keys.data;
  const api = client;
  if (api === null) return null;

  return (
    <SettingsGroup
      title="Machines"
      keywords="team keys fingerprint admit revoke found"
      hint="The machines that sync this board, each with its own key. Compare a fingerprint out loud before admitting anyone."
      requires="none"
    >
      <SettingsRow
        title="This machine"
        subtitle={`${k.machine.handle} on ${k.machine.device} (${k.machine.replica})`}
        control={
          <span className="font-mono text-[12px]">{k.machine.fingerprint}</span>
        }
      />
      {k.team !== null && (
        <SettingsRow
          title={`Team ${k.team.name}`}
          subtitle={`Founder ${k.team.founder.handle}: verify this with ${k.team.founder.handle}`}
          control={
            <span className="font-mono text-[12px]">
              {k.team.founder.fingerprint}
            </span>
          }
        />
      )}
      {canOperate && k.team === null && k.foundings.length === 0 && (
        <SettingsRow
          title="No team yet"
          subtitle="Founding makes this machine the team's first admin."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const founded = await api.foundTeam();
                  setRecoveryCode(founded.recoveryCode);
                })
              }
            >
              Found a team
            </Button>
          }
        />
      )}
      {recoveryCode !== null && (
        <SettingsRow
          title="Recovery code"
          subtitle="Store this where you keep other recovery codes; it is the only way back in if every admin machine is lost. It is shown once."
          stacked
          control={
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px]">{recoveryCode}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRecoveryCode(null)}
              >
                I stored it
              </Button>
            </div>
          }
        />
      )}
      {k.foundings.length > 1 &&
        k.foundings.map((f) => (
          <SettingsRow
            key={`${f.replica}-${f.fingerprint}`}
            title={`Founding by ${f.replica}`}
            subtitle="Two or more teams were founded on this branch. Trust the one whose founder you can verify."
            control={
              <span className="flex items-center gap-2">
                <span className="font-mono text-[12px]">{f.fingerprint}</span>
                {canOperate && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Trust ${f.fingerprint}`}
                    disabled={busy}
                    onClick={() =>
                      void act(() => api.trustFounder(f.fingerprint))
                    }
                  >
                    Trust
                  </Button>
                )}
              </span>
            }
          />
        ))}
      {k.roster.map((m) => (
        <SettingsRow
          key={m.replica}
          title={
            <span className="flex items-center gap-1.5">
              {m.handle} on {m.device}
              <Pill>{m.observer ? 'observer' : m.role}</Pill>
              {m.recovered && <Pill>recovered</Pill>}
            </span>
          }
          subtitle={[
            m.replica,
            `build ${m.build}`,
            m.lastSeen === null
              ? 'not seen yet'
              : `seen ${m.lastSeen.slice(0, 10)}`,
            ...(m.skewMs !== null && Math.abs(m.skewMs) > 60_000
              ? [`clock ${Math.round(m.skewMs / 60_000)} min off`]
              : []),
            ...(m.hosts.length > 0 ? [`hosts ${m.hosts.join(', ')}`] : []),
          ].join(' · ')}
          control={
            <span className="flex items-center gap-2">
              <span className="font-mono text-[12px]">{m.fingerprint}</span>
              {canOperate && m.replica !== k.machine.replica && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api.setReplicaRole(
                          m.replica,
                          m.role === 'admin' ? 'member' : 'admin'
                        )
                      )
                    }
                  >
                    {m.role === 'admin' ? 'Make member' : 'Make admin'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setConfirming({
                        replica: m.replica,
                        handle: m.handle,
                        reason: 'revoked',
                      })
                    }
                  >
                    Revoke
                  </Button>
                </>
              )}
            </span>
          }
        />
      ))}
      {k.waiting.map((w) => {
        const value = typed[w.replica] ?? '';
        const matches = sameFingerprint(value, w.fingerprint);
        return (
          <SettingsRow
            key={w.replica}
            title={`Waiting: ${w.handle} on ${w.device}`}
            subtitle={
              <span className="flex flex-col gap-0.5">
                <span>
                  {w.replica} ·{' '}
                  <span className="font-mono">{w.fingerprint}</span>
                </span>
                {w.invitedBy !== null && <span>invited by {w.invitedBy}</span>}
              </span>
            }
            control={
              canOperate ? (
                <span className="flex items-center gap-2">
                  <Input
                    aria-label={`Fingerprint for ${w.handle}`}
                    placeholder="Fingerprint they read out"
                    className="h-7 w-56 font-mono text-[12px]"
                    value={value}
                    onChange={(e) =>
                      setTyped((t) => ({ ...t, [w.replica]: e.target.value }))
                    }
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Admit ${w.handle}`}
                    disabled={!matches || busy}
                    onClick={() =>
                      void act(() =>
                        api.admitReplica(w.replica, {
                          fingerprint: w.fingerprint,
                        })
                      )
                    }
                  >
                    Admit
                  </Button>
                </span>
              ) : undefined
            }
          />
        );
      })}
      {k.invites.map((i) => (
        <SettingsRow
          key={`${i.handle}-${i.expires}`}
          title={`Invite for ${i.handle}`}
          subtitle={`from ${i.by}, until ${i.expires.slice(0, 10)}`}
        />
      ))}
      {k.legacy.until !== null && !k.legacy.closed && (
        <SettingsRow
          title={`Older Dispatch builds sync until ${k.legacy.until.slice(0, 10)}`}
          subtitle={
            k.legacy.olderBuilds.length > 0
              ? `Still on an older build: ${k.legacy.olderBuilds.join(', ')}`
              : 'Every machine has upgraded.'
          }
        />
      )}
      {k.transport.sizeBytes !== null && (
        <SettingsRow
          title={`Sync branch: ${branchSize(k.transport.sizeBytes)}`}
        />
      )}
      {k.pruningBlockers.map((b) => (
        <SettingsRow
          key={b.replica}
          title={`${b.handle} has not acknowledged since ${b.lastAck === null ? 'it was admitted' : b.lastAck.slice(0, 10)}; it blocks pruning.`}
          control={
            canOperate ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setConfirming({
                    replica: b.replica,
                    handle: b.handle,
                    reason: 'blocked pruning',
                  })
                }
              >
                Revoke {b.handle}?
              </Button>
            ) : undefined
          }
        />
      ))}
      {confirming !== null && (
        <SettingsRow
          title={`Revoke ${confirming.handle} for good?`}
          subtitle="Its key can never rejoin; the person joins again from a new machine."
          control={
            <span className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  const c = confirming;
                  setConfirming(null);
                  void act(() => api.revokeReplica(c.replica, c.reason));
                }}
              >
                Confirm revoke
              </Button>
            </span>
          }
        />
      )}
      {k.pause !== null && canOperate && (
        <SettingsRow
          title="Paused on a roster change this build cannot read"
          subtitle="Upgrade Dispatch here, or, as an admin, dismiss the op so no build applies it."
          control={
            <Button
              size="sm"
              variant="outline"
              aria-label={`Dismiss ${k.pause.replica}'s op`}
              disabled={busy}
              onClick={() => {
                const p = k.pause;
                if (p !== null)
                  void act(() => api.dismissRosterOp(p.replica, p.seq, p.hash));
              }}
            >
              Dismiss
            </Button>
          }
        />
      )}
      {[
        ...k.warnings,
        ...(k.originWarning === null ? [] : [k.originWarning]),
      ].map((w) => (
        <SettingsRow
          key={w}
          title={<span className="text-(--state-waiting-fg)">{w}</span>}
        />
      ))}
      {k.problems.map((p) => (
        <SettingsRow
          key={p.subject}
          title={p.subject}
          subtitle={p.message}
          control={
            // Acknowledging is decide-tier, which every viewer here holds.
            ACKNOWLEDGEABLE.some((a) => p.subject.startsWith(a)) ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Acknowledge ${p.subject}`}
                disabled={busy}
                onClick={() => void act(() => api.ackProblem(p.subject))}
              >
                Acknowledge
              </Button>
            ) : undefined
          }
        />
      ))}
      {error !== null && (
        <SettingsRow
          title="That change didn’t go through"
          subtitle={<span className="text-state-failed">{error}</span>}
        />
      )}
      {k.team === null && k.foundings.length === 0 && !canOperate && (
        <SettingsHint>No team is founded on this branch yet.</SettingsHint>
      )}
    </SettingsGroup>
  );
}
