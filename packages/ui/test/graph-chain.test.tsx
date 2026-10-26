import { describe, expect, test } from 'bun:test';

import { blockerIndex, upstreamChain, waiterIndex } from '../src/graph/chain';
import type { GraphEdgeData } from '../src/graph/types';
import { MILESTONE_EDGES } from './graph-fixture';

const e = (
  from: string,
  to: string,
  kind: GraphEdgeData['kind'] = 'default'
): GraphEdgeData => ({ from, to, kind });

describe('upstreamChain', () => {
  test('is transitive and nearest first', () => {
    const index = blockerIndex([e('a', 'b'), e('b', 'c'), e('c', 'd')]);
    const chain = upstreamChain('d', index);
    expect(chain.nodeIds).toEqual(['c', 'b', 'a']);
    expect([...chain.edgeKeys].sort()).toEqual(['a->b', 'b->c', 'c->d']);
  });

  test('walks only against the edge direction', () => {
    const index = blockerIndex([e('a', 'b'), e('b', 'c')]);
    expect(upstreamChain('a', index).nodeIds).toEqual([]);
    expect(upstreamChain('b', index).nodeIds).toEqual(['a']);
  });

  test('visits a shared blocker once (diamond)', () => {
    const index = blockerIndex([
      e('root', 'left'),
      e('root', 'right'),
      e('left', 'tip'),
      e('right', 'tip'),
    ]);
    const chain = upstreamChain('tip', index);
    expect(chain.nodeIds).toEqual(['left', 'right', 'root']);
    expect(chain.edgeKeys.size).toBe(4);
  });

  test('is cycle-safe and never lists the start node', () => {
    const index = blockerIndex([
      e('a', 'b', 'cycle'),
      e('b', 'a', 'cycle'),
      e('c', 'a'),
    ]);
    const chain = upstreamChain('a', index);
    expect(chain.nodeIds).toEqual(['b', 'c']);
    // Both cycle edges are lit, so the loop reads as a loop.
    expect(chain.edgeKeys.has('a->b')).toBe(true);
    expect(chain.edgeKeys.has('b->a')).toBe(true);
  });

  test('handles a self-loop', () => {
    const chain = upstreamChain('a', blockerIndex([e('a', 'a', 'cycle')]));
    expect(chain.nodeIds).toEqual([]);
    expect([...chain.edgeKeys]).toEqual(['a->a']);
  });

  test('skips resolved blockers unless asked', () => {
    const edges = [e('done', 'b', 'resolved'), e('open', 'b')];
    expect(upstreamChain('b', blockerIndex(edges)).nodeIds).toEqual(['open']);
    expect(
      upstreamChain('b', blockerIndex(edges, { includeResolved: true })).nodeIds
    ).toEqual(['done', 'open']);
  });

  test('on the fixture: Store release waits on the whole risk chain', () => {
    const chain = upstreamChain('mobile-m2', blockerIndex(MILESTONE_EDGES));
    expect(chain.nodeIds).toEqual([
      'mobile-m1',
      'identity-m1',
      'search-m1',
      'identity-m2',
    ]);
    // The resolved Payments SDK edge into Offline sync is not part of it.
    expect(chain.edgeKeys.has('billing-m0->mobile-m1')).toBe(false);
  });

  test('waiterIndex lists what each node holds up', () => {
    const index = waiterIndex(MILESTONE_EDGES);
    expect((index.get('atlas-m3') ?? []).map((edge) => edge.to)).toEqual([
      'atlas-m4',
      'billing-m1',
    ]);
    expect(index.has('atlas-m2')).toBe(false);
  });
});
