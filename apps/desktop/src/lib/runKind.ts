import type { RunKind } from '@dispatch/client';

const RUN_KIND_LABEL: Record<RunKind, string> = {
  execute: 'Execute',
  review: 'Review',
  verify: 'Verify',
};

/** Absent `kind` predates this field and always meant an execute run. */
export function runKindLabel(kind: RunKind | undefined): string {
  return RUN_KIND_LABEL[kind ?? 'execute'];
}
