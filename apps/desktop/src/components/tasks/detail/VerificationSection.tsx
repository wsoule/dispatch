import type { VerificationCheck, VerificationResult } from '@dispatch/client';
import { FlaskConical } from 'lucide-react';

import { revealInFinder } from '../../../lib/tauri';
import {
  isRevealableArtifact,
  summarizeVerification,
  verificationCheckDetail,
} from '../../../lib/verificationSummary';
import { StatusIcon } from '../StatusIcon';
import { MainSection } from './MainSection';
import { cn } from '@/lib/utils';
import { Pill, PillButton } from '@/ui/ai/pill';

// A check's pass/fail as the 14px status glyph: the done disk for a pass, the
// cancelled disk in the danger red for a failure. The glyph is decorative;
// the visually hidden word carries the meaning for a screen reader.
function CheckGlyph({ pass }: { pass: boolean }) {
  return (
    <>
      <span aria-hidden className="mt-0.5 shrink-0">
        {pass ? (
          <StatusIcon status="landed" />
        ) : (
          <StatusIcon status="dropped" tone="danger" />
        )}
      </span>
      <span className="sr-only">{pass ? 'Passed' : 'Failed'}</span>
    </>
  );
}

// One check row: glyph, name, and for a failure the expected/actual pair
// beneath it.
function CheckRow({ check }: { check: VerificationCheck }) {
  const detail = verificationCheckDetail(check);
  return (
    <li
      data-slot="verification-check"
      data-pass={check.pass || undefined}
      className="flex items-start gap-2 text-[13px]"
    >
      <CheckGlyph pass={check.pass} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-foreground font-book">{check.check}</span>
        {detail !== null && (
          <dl className="text-muted-foreground font-book grid grid-cols-[64px_1fr] gap-x-2 text-[13px]">
            <dt>Expected</dt>
            <dd className="break-words text-(--text-secondary)">
              {detail.expected}
            </dd>
            <dt>Actual</dt>
            <dd className="text-red break-words">{detail.actual}</dd>
          </dl>
        )}
      </div>
    </li>
  );
}

// Artifacts as 24px pills; a path stays mono because it is code, and an
// absolute path is a button that reveals the file in Finder.
function ArtifactPill({ path }: { path: string }) {
  if (isRevealableArtifact(path)) {
    return (
      <PillButton
        title={path}
        onClick={() => {
          revealInFinder(path).catch((err: unknown) => {
            console.error(`Failed to reveal ${path}:`, err);
          });
        }}
        className="h-6 max-w-full px-2 font-mono text-[11px] font-normal"
      >
        <span className="truncate">{path}</span>
      </PillButton>
    );
  }
  return (
    <Pill title={path} className="font-mono text-[11px] font-normal">
      <span className="truncate">{path}</span>
    </Pill>
  );
}

// `exercised` stays visually distinct from review status; self-hides when
// there is nothing to say (never exercised, no result, no error).
export function VerificationSection({
  exercised,
  result,
  error,
}: {
  exercised: boolean;
  result: VerificationResult | null;
  /** Set when the checks fetch itself failed — distinct from `result` being
   * `null` because nothing has ever run, which is not an error at all. */
  error: string | null;
}) {
  if (!exercised && result === null && error === null) return null;
  const summary = summarizeVerification(result);
  return (
    <MainSection title="Verification">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[13px]">
          <FlaskConical
            aria-hidden
            className={cn(
              'size-3.5 shrink-0',
              exercised ? 'text-state-review' : 'text-muted-foreground'
            )}
          />
          <span
            className={
              exercised
                ? 'text-state-review font-medium'
                : 'text-muted-foreground font-medium'
            }
          >
            {exercised ? 'Exercised' : 'Not exercised'}
          </span>
          {error === null ? (
            <span className="text-muted-foreground font-book text-[12px]">
              · {summary.label}
            </span>
          ) : (
            <span className="text-red font-book text-[12px]">
              · couldn&rsquo;t load checks
            </span>
          )}
        </div>
        {error !== null && (
          <div className="text-red font-book text-[12px]">{error}</div>
        )}
        {result !== null && result.checks.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {result.checks.map((check, i) => (
              <CheckRow key={i} check={check} />
            ))}
          </ul>
        )}
        {result !== null && result.artifacts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {result.artifacts.map((path) => (
              <ArtifactPill key={path} path={path} />
            ))}
          </div>
        )}
      </div>
    </MainSection>
  );
}
