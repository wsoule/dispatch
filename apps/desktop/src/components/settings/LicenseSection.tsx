import type { LicenseStatus } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

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
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = license.data;
  if (status === undefined) return null;
  const canInstall = myTier === 'operator';

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
            <SettingsHint className="text-(--state-waiting-fg)">
              The license for {status.org} expired on{' '}
              {status.expiresAt?.slice(0, 10)}. The free plan applies until you
              add a new key; the people invited first keep their seats.
            </SettingsHint>
          )}
          {status.kind === 'invalid' && status.reason !== null && (
            <SettingsHint className="text-(--state-waiting-fg)">
              The installed key was not accepted: {status.reason}.
            </SettingsHint>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="License key" keywords="install" requires="none">
        {canInstall ? (
          <SettingsRow title="Paste a key" htmlFor="license-key" stacked>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void install();
              }}
            >
              <Input
                id="license-key"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="dispatch1.…"
                spellCheck={false}
                autoComplete="off"
                className="min-w-[260px] flex-1 font-mono"
              />
              <Button type="submit" disabled={draft.trim() === '' || pending}>
                <KeyRound />
                {pending ? 'Checking…' : 'Install'}
              </Button>
            </form>
            <SettingsHint className="mt-1.5">
              Checked on this machine; nothing is sent anywhere. An invalid key
              is refused and the current one stays.
            </SettingsHint>
            {error !== null && (
              <p role="alert" className="text-state-failed mt-1.5 text-[13px]">
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
