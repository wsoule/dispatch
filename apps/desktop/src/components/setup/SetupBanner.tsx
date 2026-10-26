import type { SetupReport } from '@dispatch-foo/core/browser';
import { CircleAlert } from 'lucide-react';

import { Button } from '@/ui/button';

/** The first setup step that wants a person, or undefined when the report is clean. The
 * shell mounts the banner only when this is defined: its banner slot is a styled strip, so
 * handing it an element that renders nothing would still draw an empty band. */
export function setupProblem(
  report: SetupReport | undefined
): SetupReport['steps'][number] | undefined {
  return report?.steps.find(
    (s) => s.status === 'missing' || s.status === 'needs-action'
  );
}

/** A slim app-wide strip when a setup check fails after first launch (e.g. signed out). */
export function SetupBanner({
  report,
  onOpen,
}: {
  report: SetupReport | undefined;
  onOpen: () => void;
}) {
  const problem = setupProblem(report);
  if (problem === undefined) return null;
  return (
    <div
      className="border-border bg-muted flex items-center gap-2 border-b px-3 py-1.5 text-sm"
      role="status"
    >
      <CircleAlert className="size-4 text-(--state-waiting-fg)" />
      <span className="flex-1">{problem.message}</span>
      <Button size="sm" variant="outline" onClick={onOpen}>
        Fix it
      </Button>
    </div>
  );
}
