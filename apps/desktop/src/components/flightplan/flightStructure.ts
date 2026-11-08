import { dagWaves } from '../../lib/dagLayout';

// A plan's structure (ids, ages, blockers, bands) as one string, and the waves it implies.
// A status change leaves the key equal, so callers memoize the waves on it and a node
// landing never recomputes them. The header's wave counts and the critical path read them;
// the chart lays the plan out itself.

/** One node's structure: what the waves read, and nothing else. */
export interface FlightStructureNode {
  id: string;
  created: string;
  blockedBy: readonly string[];
  band: string | null;
}

type StructureTuple = [
  id: string,
  created: string,
  blockedBy: readonly string[],
  band: string | null,
];

/** The plan's structure as a string: ids, ages, blockers and bands. */
export function flightStructureKey(
  nodes: readonly FlightStructureNode[],
  bandOrder: readonly string[] | null
): string {
  const tuples = nodes.map(
    (n): StructureTuple => [n.id, n.created, n.blockedBy, n.band]
  );
  return JSON.stringify({ nodes: tuples, bands: bandOrder });
}

/** Each node's wave (its depth in the blocker graph) for a structure key. */
export function flightWaves(key: string): Map<string, number> {
  const parsed = JSON.parse(key) as { nodes: StructureTuple[] };
  return dagWaves(
    parsed.nodes.map(([id, created, blockedBy]) => ({
      id,
      created,
      blockedBy: [...blockedBy],
      title: '',
      status: '',
    }))
  );
}
