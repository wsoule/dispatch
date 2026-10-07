import type { ApiClient, JudgmentStatus } from '@dispatch/client';
import { useEffect, useState } from 'react';

import { formatRelativeTimeFromIso } from '../../lib/format';
import { SettingsRow } from './SettingsGroup';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

type Probe = NonNullable<JudgmentStatus['probe']>;

/** The one line Settings says about Jev, from its status and the last test. */
export function judgmentSummary(
  status: JudgmentStatus | undefined,
  probe: Probe | null
): { tone: 'ok' | 'off' | 'bad'; text: string } {
  if (status === undefined) return { tone: 'off', text: 'Checking…' };
  if (!status.configured) {
    return {
      tone: 'off',
      text: 'No key: judgments are off and everything falls back.',
    };
  }
  if (probe !== null) {
    if ('error' in probe) {
      return { tone: 'bad', text: `Unreachable · ${probe.error}` };
    }
    return { tone: 'ok', text: `Reachable · answered in ${probe.latencyMs}ms` };
  }
  if (status.lastFailure !== null) {
    return {
      tone: 'bad',
      text: `Last failed ${formatRelativeTimeFromIso(status.lastFailure.at)} (${status.lastFailure.feature}): ${status.lastFailure.message}`,
    };
  }
  return { tone: 'ok', text: 'Key set · no failures since the daemon started' };
}

const TONE: Record<'ok' | 'off' | 'bad', string> = {
  ok: 'connected',
  off: 'off',
  bad: 'failing',
};

/** Jev's status under Settings › Agents, with a Test that makes one tiny call. */
export function JudgmentStatusRow({
  client,
  port,
}: {
  client: Pick<ApiClient, 'judgmentStatus'> | null;
  port: number | undefined;
}) {
  // Read once per daemon; Settings needs no live updates for this line.
  const [status, setStatus] = useState<JudgmentStatus | undefined>(undefined);
  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    // An async body turns any failure, even a synchronous throw, into the catch.
    const load = async () => {
      try {
        const next = await client.judgmentStatus();
        if (!cancelled) setStatus(next);
      } catch {
        // An older daemon has no such route; the line keeps saying it is checking.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, port]);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [testing, setTesting] = useState(false);
  const summary = judgmentSummary(status, probe);

  const test = async () => {
    if (client === null) return;
    setTesting(true);
    try {
      const result = await client.judgmentStatus(true);
      setStatus(result);
      setProbe(result.probe ?? { ok: false, error: 'no answer' });
    } catch (err) {
      setProbe({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsRow
      title="Jev"
      subtitle={summary.text}
      keywords="typesafe judgments topic reachable status"
      control={
        <div className="flex items-center gap-2">
          <Badge
            variant={summary.tone === 'bad' ? 'destructive' : 'secondary'}
            data-testid="jev-status"
          >
            {TONE[summary.tone]}
          </Badge>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    client === null || testing || status?.configured !== true
                  }
                  onClick={() => void test()}
                >
                  {testing ? <Spinner className="size-3" /> : null}
                  Test
                </Button>
              }
            />
            <TooltipContent>
              Makes one tiny Jev call and times it
            </TooltipContent>
          </Tooltip>
        </div>
      }
    />
  );
}
