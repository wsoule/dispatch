import type { AdjudicateFindingInput, Finding } from '@dispatch/client';
import { useState } from 'react';

import {
  countOpenFindings,
  groupOpenFindingsBySeverity,
} from '../../../lib/findings';
import { MainSection } from './MainSection';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';

const SEVERITY_TONE: Record<Finding['severity'], string> = {
  critical: 'text-state-failed',
  important: 'text-state-waiting',
  minor: 'text-muted-foreground',
};

// Two explicit actions, never a bare "submit" — both disabled until a
// reason is actually typed, so the ruling requirement can't be missed.
function AdjudicateFindingForm({
  onSubmit,
}: {
  onSubmit: (input: AdjudicateFindingInput) => Promise<void>;
}) {
  const [ruling, setRuling] = useState('');
  const [pending, setPending] = useState<'parked' | 'blocked' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const empty = ruling.trim() === '';

  async function submit(verdict: 'parked' | 'blocked') {
    setPending(verdict);
    setError(null);
    try {
      await onSubmit({ verdict, ruling: ruling.trim() });
      setRuling('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="border-border mt-1.5 flex flex-col gap-1.5 rounded-md border border-dashed p-2">
      <Textarea
        value={ruling}
        onChange={(e) => setRuling(e.target.value)}
        placeholder="Ruling — required to park or block this finding"
        className="min-h-[44px] text-[12px]"
      />
      {error !== null && (
        <div className="text-destructive text-[11px]">{error}</div>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={empty || pending !== null}
          onClick={() => void submit('parked')}
        >
          {pending === 'parked' ? 'Parking…' : 'Park'}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={empty || pending !== null}
          onClick={() => void submit('blocked')}
        >
          {pending === 'blocked' ? 'Blocking…' : 'Block'}
        </Button>
      </div>
    </div>
  );
}

// The adjudication form only attaches while the fix loop is capped — that
// is the one moment a ruling actually does anything.
export function FindingsPanel({
  findings,
  needsRuling,
  onAdjudicate,
}: {
  findings: Finding[];
  needsRuling: boolean;
  onAdjudicate: (
    findingId: string,
    input: AdjudicateFindingInput
  ) => Promise<void>;
}) {
  const groups = groupOpenFindingsBySeverity(findings);
  const counts = countOpenFindings(findings);
  if (groups.length === 0) return null;
  // The header names the severity mix so it's visible without scrolling the
  // grouped body below — e.g. "3 open (1 critical, 2 minor)".
  const bySeverity = [
    counts.critical > 0 ? `${counts.critical} critical` : null,
    counts.important > 0 ? `${counts.important} important` : null,
    counts.minor > 0 ? `${counts.minor} minor` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(', ');
  const title =
    bySeverity === ''
      ? `Findings · ${counts.open} open`
      : `Findings · ${counts.open} open (${bySeverity})`;
  return (
    <MainSection title={title}>
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <div key={group.severity} className="flex flex-col gap-1.5">
            <span
              className={cn(
                'text-[11px] font-medium tracking-wide uppercase',
                SEVERITY_TONE[group.severity]
              )}
            >
              {group.severity} · {group.findings.length}
            </span>
            <ul className="flex flex-col gap-2">
              {group.findings.map((finding) => (
                <li
                  key={finding.id}
                  className="border-border/60 rounded-md border px-2.5 py-2"
                >
                  <div className="text-[13px] font-medium">{finding.title}</div>
                  {finding.file !== null && (
                    <div className="text-muted-foreground font-mono text-[11px]">
                      {finding.file}
                      {finding.line !== null ? `:${finding.line}` : ''}
                    </div>
                  )}
                  <p className="text-muted-foreground mt-1 text-[12.5px] whitespace-pre-wrap">
                    {finding.detail}
                  </p>
                  {needsRuling && (
                    <AdjudicateFindingForm
                      onSubmit={(input) => onAdjudicate(finding.id, input)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </MainSection>
  );
}
