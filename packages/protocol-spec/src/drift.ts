import type { RegistryEntry } from './registries.js';

// The registry drift rule: permanent ⊆ export ⊆ permanent ∪ provisional, so a
// sub-project may implement a pre-listed provisional value with no edit here.
export function driftProblems(
  name: string,
  entries: readonly RegistryEntry[],
  exported: readonly string[]
): string[] {
  const problems: string[] = [];
  const out = new Set(exported);
  const allowed = new Set(
    entries
      .filter((e) => e.status === 'permanent' || e.status === 'provisional')
      .map((e) => e.value)
  );
  for (const e of entries) {
    if (e.status === 'permanent' && !out.has(e.value))
      problems.push(`${name}: ${e.value} is permanent but not exported`);
  }
  for (const v of exported) {
    if (!allowed.has(v))
      problems.push(
        `${name}: ${v} is exported but has no permanent or provisional entry`
      );
  }
  return problems;
}
