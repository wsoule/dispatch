// EpicCardTile's concurrency stepper reads its value straight off a plain
// `<input type="number">`, which browsers happily let a user type a
// fraction, a negative number, or nothing at all into. Extracted as a pure
// function (rather than inline in the component) purely so this rounding
// rule is unit-testable the same way the rest of lib/ is.
export function clampConcurrencyInput(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.round(parsed));
}
