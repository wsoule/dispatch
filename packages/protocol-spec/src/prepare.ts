import type { Registry } from './registries.js';
import type { Hello, RunnableVector, Vector } from './types.js';

// The first registered gate type the implementation does not declare, which
// fail-closed vectors send as `$unimplementedGateType`; null when none is left.
export function unimplementedGateType(
  registry: Registry,
  hello: Hello
): string | null {
  const declared = new Set(hello.gateTypes);
  const found = registry['gate-types'].find(
    (g) =>
      (g.status === 'permanent' || g.status === 'provisional') &&
      !declared.has(g.value)
  );
  return found === undefined ? null : found.value;
}

// JSON-escapes a value for splicing into serialized JSON text.
function jsonText(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

// Replaces the runner-resolved symbols (`$system`, `$unimplementedGateType`)
// before the vector crosses the pipe; a vector that needs an unimplemented
// gate type when none is left is not applicable.
export function prepareVector(
  vector: Vector,
  hello: Hello,
  registry: Registry
): { vector: Vector; notApplicable: boolean } {
  const text = JSON.stringify(vector);
  const gate = unimplementedGateType(registry, hello);
  if (text.includes('$unimplementedGateType') && gate === null)
    return { vector, notApplicable: true };
  const system = jsonText(hello.systemAddress);
  const unimplemented = jsonText(gate ?? '');
  const resolved = text
    .replace(/\$system\b/g, () => system)
    .replace(/\$unimplementedGateType\b/g, () => unimplemented);
  return { vector: JSON.parse(resolved) as Vector, notApplicable: false };
}

// The vector without its expectation, which is all an adapter may see.
export function stripThen(vector: Vector): RunnableVector {
  const { then: _then, ...rest } = vector;
  return rest;
}
