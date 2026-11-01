// The milestone lane header's concurrency picker is a `SelectPill` (`1×` … `4×`): a fixed
// menu rather than a free-text stepper, so the only parsing left is the menu value on the
// way back. Both helpers stay pure so the rounding rule is unit-testable like the rest of
// lib/.

/** The concurrency choices the picker offers: 1 up to the larger of `max` (the lane
 * header's 4, or the fan-out dialog's configured cap) and the project's configured
 * default, so a config that asks for 6 agents is still selectable. */
export function concurrencyChoices(defaultValue: number, max = 4): number[] {
  const top = Math.max(
    clampConcurrencyInput(String(max)),
    clampConcurrencyInput(String(defaultValue))
  );
  return Array.from({ length: top }, (_, i) => i + 1);
}

/** The picker's label for one choice: `3×`. */
export function concurrencyLabel(value: number): string {
  return `${value}×`;
}

/** Rounds whatever the picker (or an older free-text input) hands back to a whole number
 * of at least 1: fractions round, non-numbers and anything below 1 land on 1. */
export function clampConcurrencyInput(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.round(parsed));
}
