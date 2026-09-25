import type {
  AuthTier,
  IssuedTeamToken,
  TeamTokenHolder,
} from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useSettingsAccess } from './access';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { cn } from '@/lib/utils';
import { Pill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

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
function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Copy ${label}`}
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => setState('copied'))
          .catch(() => setState('failed'));
      }}
    >
      {state === 'copied' ? <Check /> : <Copy />}
      {state === 'copied'
        ? 'Copied'
        : state === 'failed'
          ? 'Select it'
          : 'Copy'}
    </Button>
  );
}

/**
 * Settings → Team: who can reach this daemon, at what tier, and a way to add
 * or remove someone without leaving the app — the page `dispatch team`
 * commands stood in for.
 *
 * Needs the decide tier to list or change anything. Below it the page says so
 * and who to ask, instead of rendering controls the daemon would refuse.
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
      <SettingsGroup title="Members" keywords="invite team" requires="none">
        <SettingsRow
          title="Inviting people"
          subtitle="Needs Can approve access. Ask the person running Dispatch for this project to invite them, or to raise your access."
          locked={decideReason}
        />
      </SettingsGroup>
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
      <SettingsGroup
        title="Invite someone"
        requires="none"
        hint="They get their own sign-in token, so everything they do is credited to them."
        keywords="add member token access"
      >
        <SettingsRow title="Email or handle" htmlFor="team-invite-who" stacked>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void invite();
            }}
          >
            <Input
              id="team-invite-who"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ada@example.com"
              className="min-w-[200px] flex-1"
            />
            <Select value={tier} onValueChange={(v) => setTier(v as AuthTier)}>
              <SelectTrigger aria-label="Tier" className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {grantable.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TIER_INFO[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger aria-label="Expires after" className="w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_CHOICES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" disabled={email.trim() === '' || pending}>
              <UserPlus />
              Invite
            </Button>
          </form>
          <SettingsHint className="mt-1.5">
            {TIER_INFO[tier].adds}.
          </SettingsHint>
          {error !== null && (
            <p role="alert" className="text-state-failed mt-1.5 text-[13px]">
              {error}
            </p>
          )}
        </SettingsRow>

        {issued !== null && (
          <SettingsRow
            title={`Send ${issued.handle} these privately`}
            subtitle="The token is only shown once. If it's lost, invite them again to replace it."
            stacked
          >
            <div className="flex flex-col gap-2">
              {origins.length > 0 ? (
                origins.map((origin) => (
                  <div key={origin} className="flex items-center gap-2">
                    <code className="bg-surface-quaternary rounded-control min-w-0 flex-1 truncate px-2 py-1 font-mono text-[12px]">
                      {origin}
                    </code>
                    <CopyButton value={origin} label="address" />
                  </div>
                ))
              ) : (
                <SettingsHint>
                  Dispatch only accepts connections from this machine right now.
                  To let them connect, restart it with{' '}
                  <code className="font-mono">
                    dispatch serve --host 0.0.0.0
                  </code>{' '}
                  for teammates to reach it.
                </SettingsHint>
              )}
              <div className="flex items-center gap-2">
                <code
                  data-testid="issued-token"
                  className="bg-surface-quaternary rounded-control min-w-0 flex-1 truncate px-2 py-1 font-mono text-[12px]"
                >
                  {issued.token}
                </code>
                <CopyButton value={issued.token} label="token" />
              </div>
            </div>
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsGroup title="People" keywords="members team" requires="none">
        {people.length === 0 && (
          <SettingsRow
            title="Nobody else yet"
            subtitle="People you invite show up here."
          />
        )}
        {people.map((holder) => {
          const above = !grantable.includes(holder.tier);
          return (
            <SettingsRow
              key={holder.handle}
              title={
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      online.has(holder.handle)
                        ? 'bg-state-review'
                        : 'bg-muted-foreground/40'
                    )}
                  />
                  {holder.handle}
                  <Pill>{TIER_INFO[holder.tier].label}</Pill>
                  <span className="sr-only">
                    {online.has(holder.handle) ? 'online' : 'offline'}
                  </span>
                </span>
              }
              subtitle={holderDates(holder)}
              control={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={above}
                  title={
                    above
                      ? `Their tier is above yours, so only someone at ${holder.tier} can remove them`
                      : undefined
                  }
                  aria-label={`Remove ${holder.handle}`}
                  onClick={() => void revoke(holder.handle)}
                >
                  <UserMinus />
                  Remove
                </Button>
              }
            />
          );
        })}
      </SettingsGroup>
    </>
  );
}
