import type {
  AuthTier,
  IssuedTeamToken,
  TeamTokenHolder,
} from '@dispatch/client';
import { Button, Chip, Select, TextField } from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { NEEDS_DECIDE, useSettingsAccess } from './access';
import { MachinesGroup } from './MachinesGroup';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { TeamEncryptionGroup } from './TeamEncryptionGroup';
import styles from './TeamSection.module.css';
import { TeamSetupGroup } from './TeamSetupGroup';

interface TeamSectionProps {
  data: DispatchProjectData;
}

// Each tier in the words someone choosing one needs: what it adds over the
// one below. Mirrors the ladder in packages/server/src/tiers.ts.
const TIER_INFO: Record<AuthTier, { label: string; adds: string }> = {
  request: {
    label: 'Can work',
    adds: 'Use the board, start runs, review and merge',
  },
  decide: {
    label: 'Can approve',
    adds: 'Also approve requests and invite people',
  },
  operator: {
    label: 'Full access',
    adds: 'Also terminals, files and git on your machine, acting as you',
  },
};

const TIERS: AuthTier[] = ['request', 'decide', 'operator'];

// Offered expiries, as the select's string values. `never` is null on the wire.
const EXPIRY_CHOICES: { value: string; label: string }[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

/** The tiers someone may hand out: their own and those below it. The daemon
 *  enforces the same cap; this only keeps the page from offering a 403. */
export function grantableTiers(mine: AuthTier | null): AuthTier[] {
  if (mine === null) return [];
  return TIERS.slice(0, TIERS.indexOf(mine) + 1);
}

/** A holder's dates as one line — what someone scanning for stale or
 *  soon-to-expire access reads. */
export function holderDates(holder: TeamTokenHolder): string {
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString([], { dateStyle: 'medium' });
  const expiry =
    holder.expiresAt === null
      ? 'Never expires'
      : holder.expired
        ? `Expired ${day(holder.expiresAt)}`
        : `Expires ${day(holder.expiresAt)}`;
  const used =
    holder.lastUsedAt === null
      ? 'never used'
      : `last used ${day(holder.lastUsedAt)}`;
  return `${expiry} · ${used}`;
}

/** A copy button that says it worked. Clipboard access can be refused (an
 *  insecure origin, a denied permission), which it reports rather than
 *  pretending — the value is still on screen to select by hand. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <Button
      size="sm"
      aria-label={`Copy ${label}`}
      icon={
        state === 'copied' ? (
          <Check size={14} strokeWidth={1.8} />
        ) : (
          <Copy size={14} strokeWidth={1.8} />
        )
      }
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => setState('copied'))
          .catch(() => setState('failed'));
      }}
    >
      {state === 'copied'
        ? 'Copied'
        : state === 'failed'
          ? 'Select it'
          : 'Copy'}
    </Button>
  );
}

/**
 * Settings → Members: the team (start, invite, join), then two folded extras
 * that are easy to mistake for it — the team's machine keys, and browser
 * sign-in tokens for using this machine's Dispatch from elsewhere.
 *
 * The browser tokens need the decide tier; below it that part says who to ask.
 */
export function TeamSection({ data }: TeamSectionProps) {
  const { client, myTier, presence } = data;
  const queryClient = useQueryClient();
  const canManage = myTier === 'decide' || myTier === 'operator';
  // Invites need decide, not operator, so the lock says so.
  const { decideReason } = useSettingsAccess();
  const holdersKey = ['dispatch-team-tokens', client?.baseUrl];

  const holders = useQuery({
    queryKey: holdersKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchTeamTokens();
    },
    enabled: client !== null && canManage,
  });
  const address = useQuery({
    queryKey: ['dispatch-team-address', client?.baseUrl],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchTeamAddress();
    },
    enabled: client !== null && canManage,
  });

  const [email, setEmail] = useState('');
  const [tier, setTier] = useState<AuthTier>('request');
  const [expiry, setExpiry] = useState('90');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedTeamToken | null>(null);

  if (!canManage) {
    return (
      <>
        <TeamSetupGroup data={data} />
        <TeamEncryptionGroup data={data} />
        <SettingsGroup
          title="Browser access"
          keywords="invite team token"
          requires="none"
        >
          <SettingsRow
            title="Giving people browser access"
            subtitle={
              decideReason === NEEDS_DECIDE
                ? 'Needs Can approve access. Ask the person running Dispatch for this project to give them access, or to raise yours.'
                : 'Restart Dispatch from this app (above) to manage browser access.'
            }
            locked={decideReason}
          />
        </SettingsGroup>
      </>
    );
  }

  async function invite() {
    const trimmed = email.trim();
    if (client === null || trimmed === '' || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await client.issueTeamToken({
        ...(trimmed.includes('@') ? { email: trimmed } : { handle: trimmed }),
        tier,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      });
      setIssued(result);
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: holdersKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  async function revoke(handle: string) {
    if (client === null) return;
    setError(null);
    try {
      await client.revokeTeamToken(handle);
      if (issued?.handle === handle) setIssued(null);
      await queryClient.invalidateQueries({ queryKey: holdersKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const online = new Set(presence.map((p) => p.handle));
  const grantable = grantableTiers(myTier);
  const origins = address.data?.origins ?? [];
  const people = (holders.data ?? []).filter((h) => !h.builtIn);

  return (
    <>
      <TeamSetupGroup data={data} />
      <TeamEncryptionGroup data={data} />
      <details data-testid="team-machines" className={styles.fold}>
        <summary className={styles.summary}>
          Machines: keys, fingerprints and admitting by hand
        </summary>
        <div className={styles.foldBody}>
          <MachinesGroup data={data} />
        </div>
      </details>
      {/* Not a team invite: a token for using this machine's Dispatch from a
          browser, with nothing installed on the other end. */}
      <details data-testid="team-browser-access" className={styles.fold}>
        <summary className={styles.summary}>
          Browser access: let someone use this machine&rsquo;s Dispatch
        </summary>
        <div className={styles.foldBody}>
          <SettingsGroup
            title="Give someone browser access"
            requires="none"
            hint="For someone without Dispatch of their own. They sign in to this machine from a browser with their own token, so everything they do is credited to them. To add a teammate who runs Dispatch, use Invite teammate above."
            keywords="add member token access invite"
          >
            <SettingsRow
              title="Email or handle"
              htmlFor="team-invite-who"
              stacked
            >
              <form
                className={styles.inviteForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  void invite();
                }}
              >
                <TextField
                  id="team-invite-who"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ada@example.com"
                  className={styles.who}
                />
                <Select
                  label="Tier"
                  value={tier}
                  options={grantable.map((t) => ({
                    value: t,
                    label: TIER_INFO[t].label,
                  }))}
                  className={styles.tier}
                  onChange={(v) => {
                    const picked = grantable.find((t) => t === v);
                    if (picked !== undefined) setTier(picked);
                  }}
                />
                <Select
                  label="Expires after"
                  value={expiry}
                  options={EXPIRY_CHOICES}
                  className={styles.expiry}
                  onChange={setExpiry}
                />
                <Button
                  type="submit"
                  variant="primary"
                  icon={<UserPlus size={14} strokeWidth={1.8} />}
                  disabled={email.trim() === '' || pending}
                >
                  Create token
                </Button>
              </form>
              <SettingsHint>{TIER_INFO[tier].adds}.</SettingsHint>
              {error !== null && (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
              )}
            </SettingsRow>

            {issued !== null && (
              <SettingsRow
                title={`Send ${issued.handle} these privately`}
                subtitle="They open the address in a browser and paste the token on the sign-in screen. The token is only shown once. If it's lost, create a new one to replace it."
                stacked
              >
                <div className={styles.stack}>
                  {origins.length > 0 ? (
                    origins.map((origin) => (
                      <div key={origin} className={styles.copyLine}>
                        <code className={styles.code}>{origin}</code>
                        <CopyButton value={origin} label="address" />
                      </div>
                    ))
                  ) : (
                    <SettingsHint>
                      Dispatch only accepts connections from this machine right
                      now. To let them connect, restart it with{' '}
                      <code className="mono">
                        dispatch serve --host 0.0.0.0
                      </code>
                      .
                    </SettingsHint>
                  )}
                  <div className={styles.copyLine}>
                    <code data-testid="issued-token" className={styles.code}>
                      {issued.token}
                    </code>
                    <CopyButton value={issued.token} label="token" />
                  </div>
                </div>
              </SettingsRow>
            )}
          </SettingsGroup>

          <SettingsGroup
            title="People with browser access"
            keywords="members team"
            requires="none"
          >
            {people.length === 0 && (
              <SettingsRow
                title="Nobody yet"
                subtitle="People you create a token for show up here."
              />
            )}
            {people.map((holder) => {
              const above = !grantable.includes(holder.tier);
              return (
                <SettingsRow
                  key={holder.handle}
                  title={
                    <span className={styles.holder}>
                      <span
                        aria-hidden
                        className={styles.dot}
                        data-tone={
                          online.has(holder.handle) ? 'success' : 'muted'
                        }
                      />
                      {holder.handle}
                      <Chip>{TIER_INFO[holder.tier].label}</Chip>
                      <span className="srOnly">
                        {online.has(holder.handle) ? 'online' : 'offline'}
                      </span>
                    </span>
                  }
                  subtitle={holderDates(holder)}
                  control={
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={<UserMinus size={14} strokeWidth={1.8} />}
                      disabled={above}
                      title={
                        above
                          ? `Their tier is above yours, so only someone at ${holder.tier} can remove them`
                          : undefined
                      }
                      aria-label={`Remove ${holder.handle}`}
                      onClick={() => void revoke(holder.handle)}
                    >
                      Remove
                    </Button>
                  }
                />
              );
            })}
          </SettingsGroup>
        </div>
      </details>
    </>
  );
}
