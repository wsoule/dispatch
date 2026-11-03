import type { SetupReport } from '@dispatch-foo/core/browser';
import { AlertStrip } from '@dispatch/ui';

import styles from './setup.module.css';

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

/** A slim app-wide strip when a setup check fails after first launch (e.g. signed out):
    a warning AlertStrip naming the problem, with "Fix it" opening Setup. It is `plain`
    (no box of its own) because the shell's banner slot already draws the strip. The polite
    status wrapper announces it when it appears. */
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
    <div role="status" className={styles.banner}>
      <AlertStrip
        tone="warning"
        plain
        label="Setup"
        action={{ label: 'Fix it', onClick: onOpen }}
      >
        {problem.message}
      </AlertStrip>
    </div>
  );
}
