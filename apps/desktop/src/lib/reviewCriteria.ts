/**
 * An Acceptance Criteria section as one criterion per line: bullets, numbers and `[ ]`
 * boxes stripped, blank lines dropped. The same reading the plan and inbox specs use.
 */
export function criteriaItems(section: string): string[] {
  return section
    .split('\n')
    .map((line) =>
      line.replace(/^\s*(?:[-*]|\d+\.)\s*(?:\[[ xX]\]\s*)?/, '').trim()
    )
    .filter((line) => line !== '');
}

// Per run, so a new run of the same task starts its review unchecked.
function checksKey(runId: string): string {
  return `dispatch:review-criteria:${runId}`;
}

/** The criteria a reviewer has ticked while reading this run's diff, by index. A viewer's
 * own convenience: it lives in this browser only, and reads empty when storage is gone. */
export function readCriteriaChecks(
  runId: string,
  storage: Pick<Storage, 'getItem'> | null = safeStorage()
): Set<number> {
  try {
    const raw = storage?.getItem(checksKey(runId));
    if (raw === null || raw === undefined) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((n): n is number => typeof n === 'number')
        : []
    );
  } catch {
    return new Set();
  }
}

export function writeCriteriaChecks(
  runId: string,
  checked: ReadonlySet<number>,
  storage: Pick<Storage, 'setItem'> | null = safeStorage()
): void {
  try {
    storage?.setItem(checksKey(runId), JSON.stringify([...checked]));
  } catch {
    // A full or blocked store only loses the ticks.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
