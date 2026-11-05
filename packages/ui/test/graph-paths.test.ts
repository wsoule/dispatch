import { describe, expect, test } from 'bun:test';

import { downstreamChain, waiterIndex } from '../src/graph/chain';
import {
  chainPhrase,
  defaultGraphPathWords,
  describePaths,
  longestChain,
  longestChains,
  nameList,
  nodePaths,
  PATH_NAME_BUDGET,
  pathContext,
  pathNameCounts,
  pathNamePhrase,
  type PathNode,
  pathNodeName,
  readoutText,
  resolvePathWords,
  sccGroups,
} from '../src/graph/paths';
import type {
  GraphEdgeData,
  GraphNodeReadiness,
  GraphPathWords,
} from '../src/graph/types';
import {
  ISSUE_EDGES,
  ISSUES,
  MILESTONE_EDGES,
  MILESTONES,
} from './graph-fixture';

const e = (
  from: string,
  to: string,
  kind: GraphEdgeData['kind'] = 'default'
): GraphEdgeData => ({ from, to, kind });

const ready = (unblocks = 0, label = 'Ready'): GraphNodeReadiness => ({
  state: 'ready',
  label,
  tone: 'success',
  blockedBy: 0,
  unblocks,
});

const blocked = (
  blockedBy: number,
  unblocks = 0,
  label = `Blocked by ${blockedBy}`
): GraphNodeReadiness => ({
  state: 'blocked',
  label,
  tone: 'warning',
  blockedBy,
  unblocks,
});

const DONE: GraphNodeReadiness = {
  state: 'done',
  label: '',
  tone: 'muted',
  blockedBy: 0,
  unblocks: 0,
};

/** An issue named by its key, as the planner's readout names issues. */
const issue = (
  key: string,
  readiness?: GraphNodeReadiness,
  extra: Partial<PathNode> = {}
): PathNode => ({
  id: key,
  label: `Title of ${key}`,
  key,
  readiness,
  ...extra,
});

/** A box (milestone) named by its label. */
const box = (label: string, readiness: GraphNodeReadiness): PathNode => ({
  id: label.toLowerCase().replaceAll(' ', '-'),
  label,
  readiness,
});

/** The planner's aggregate-level words (spec §4.5 overrides). */
const BOX_WORDS: Partial<GraphPathWords> = {
  unit: ['milestone', 'milestones'],
  waitsOn: 'Waits on {n}',
  waitsOnNone: 'Nothing outside it holds it up',
  unblock: 'Finishing it would clear {n}: {names}',
  next: 'Clear next',
  done: 'Complete',
};

const ISSUE_WORDS: Partial<GraphPathWords> = { unit: ['issue', 'issues'] };

/** The demo's chain ENG-12 → ENG-23 → OPS-20. */
const CHAIN = pathContext(
  [
    issue('ENG-12', ready(1)),
    issue('ENG-23', blocked(1, 1)),
    issue('OPS-20', blocked(1)),
  ],
  [e('ENG-12', 'ENG-23', 'risk'), e('ENG-23', 'OPS-20', 'risk')]
);

/** The core CROSS fixture in miniature: H-1 waits on the undrawn H-4. */
const CROSS = pathContext(
  [
    issue('H-1', blocked(1, 1)),
    issue('O-1', blocked(1, 1)),
    issue('N-1', blocked(1)),
  ],
  [e('H-1', 'O-1', 'cross'), e('O-1', 'N-1')]
);

/** The demo's workspace milestones. */
const BOXES = pathContext(
  [
    box('Dual-write', ready(2, 'Clear')),
    box('Search v2 beta', blocked(1, 1, 'Waiting on 1')),
    box('Read path switch', blocked(1, 0, 'Waiting on 1')),
    box('Tokens and type', {
      ...blocked(1, 0, 'Waiting on 1'),
      canStart: false,
    }),
  ],
  [
    e('dual-write', 'search-v2-beta'),
    e('dual-write', 'read-path-switch'),
    e('search-v2-beta', 'tokens-and-type'),
  ]
);

const line = (
  id: string,
  ctx: Parameters<typeof describePaths>[1],
  words: Partial<GraphPathWords> = {},
  highlight: Parameters<typeof describePaths>[3] = 'status'
): string | null => {
  const readout = describePaths(id, ctx, words, highlight);
  return readout === null ? null : readoutText(readout);
};

describe('downstreamChain', () => {
  test('is transitive and nearest first', () => {
    const chain = downstreamChain('atlas-m3', waiterIndex(MILESTONE_EDGES));
    expect(chain.nodeIds).toEqual(['atlas-m4', 'billing-m1', 'billing-m2']);
    expect([...chain.edgeKeys].sort()).toEqual([
      'atlas-m3->atlas-m4',
      'atlas-m3->billing-m1',
      'billing-m1->billing-m2',
    ]);
  });

  test('is cycle-safe and never lists the start node', () => {
    const index = waiterIndex([
      e('a', 'b', 'cycle'),
      e('b', 'a', 'cycle'),
      e('b', 'c'),
      e('a', 'a', 'cycle'),
    ]);
    const chain = downstreamChain('a', index);
    expect(chain.nodeIds).toEqual(['b', 'c']);
    expect(chain.edgeKeys.has('b->a')).toBe(true);
    expect(chain.edgeKeys.has('a->a')).toBe(true);
  });

  test('skips the resolved kind unless asked', () => {
    const edges = [e('a', 'done', 'resolved'), e('a', 'open')];
    expect(downstreamChain('a', waiterIndex(edges)).nodeIds).toEqual(['open']);
    expect(
      downstreamChain('a', waiterIndex(edges, { includeResolved: true }))
        .nodeIds
    ).toEqual(['done', 'open']);
  });
});

describe('pathContext', () => {
  test('keeps only drawn edges, the first of a repeated pair winning', () => {
    const ctx = pathContext(
      [issue('a'), issue('b'), issue('a', undefined, { label: 'dupe' })],
      [e('a', 'b', 'resolved'), e('a', 'b'), e('a', 'gone'), e('gone', 'b')]
    );
    expect(ctx.order).toEqual(['a', 'b']);
    expect(ctx.nodes.get('a')?.label).toBe('Title of a');
    expect(ctx.blocking).toEqual([]);
    expect(ctx.resolved).toEqual([e('a', 'b', 'resolved')]);
  });
});

describe('nodePaths', () => {
  const milestones = pathContext(MILESTONES, MILESTONE_EDGES);

  test('is null for a node that is not drawn', () => {
    expect(nodePaths('nope', milestones)).toBeNull();
  });

  test('walks both ways and lists the edge keys of each path', () => {
    const paths = nodePaths('mobile-m1', milestones);
    expect(paths?.upstream.nodeIds).toEqual(['search-m1']);
    expect(paths?.downstream.nodeIds).toEqual(['mobile-m2']);
    expect([...(paths?.upEdgeKeys ?? [])]).toEqual(['search-m1->mobile-m1']);
    expect([...(paths?.downEdgeKeys ?? [])]).toEqual(['mobile-m1->mobile-m2']);
    expect([...(paths?.downIds ?? [])]).toEqual(['mobile-m2']);
  });

  test('a cycle partner is drawn as upstream, its edges too', () => {
    const paths = nodePaths('identity-m1', milestones);
    expect([...(paths?.upIds ?? [])]).toEqual(['identity-m2']);
    // Downstream it reaches identity-m2 too, but that one is lit upstream.
    expect(paths?.downstream.nodeIds).toContain('identity-m2');
    expect([...(paths?.downIds ?? [])].sort()).toEqual([
      'atlas-m4',
      'mobile-m2',
    ]);
    expect(paths?.downEdgeKeys.has('identity-m1->identity-m2')).toBe(false);
    expect(paths?.downEdgeKeys.has('identity-m2->identity-m1')).toBe(false);
    expect(paths?.upEdgeKeys.has('identity-m2->identity-m1')).toBe(true);
    // The "Ready next" pill still applies to a partner it alone blocks.
    expect(paths?.next).toEqual(['identity-m2']);
  });

  test('would-unblock falls back to the blocking drawn in-degree', () => {
    // atlas-m4 also waits on identity-m2, so only billing-m1 is freed.
    expect(nodePaths('atlas-m3', milestones)?.next).toEqual(['billing-m1']);
    // Offline sync's other in-edge is resolved: it does not count.
    expect(nodePaths('search-m1', milestones)?.next).toEqual([
      'mobile-m1',
      'search-m2',
    ]);
  });

  test("would-unblock reads the host's blockedBy when it has one", () => {
    const ctx = pathContext(
      [issue('a', ready(0)), issue('b', blocked(2)), issue('c', blocked(1))],
      [e('a', 'b'), e('a', 'c')]
    );
    // b has one drawn in-edge but a second open blocker the graph omits.
    const paths = nodePaths('a', ctx);
    expect(paths?.next).toEqual(['c']);
  });

  test('would-unblock skips done targets and the node itself', () => {
    // b is done although its host still counts one blocker and draws the
    // edge as blocking: finishing a never "unblocks" closed work.
    const ctx = pathContext(
      [
        issue('a', blocked(1, 1)),
        issue('b', { ...DONE, blockedBy: 1 }),
        issue('c', blocked(1)),
      ],
      [e('a', 'a', 'cycle'), e('a', 'b'), e('a', 'c')]
    );
    expect(nodePaths('a', ctx)?.next).toEqual(['c']);
    expect(nodePaths('a', ctx)?.selfLoop).toBe(true);
  });

  test('startWith picks ready heads and skips one where nothing can start', () => {
    const stuck: GraphNodeReadiness = {
      ...ready(0, 'None ready'),
      canStart: false,
    };
    const ctx = pathContext(
      [
        box('Clear head', ready(0, 'Clear')),
        box('Stuck head', stuck),
        box('Middle', blocked(2, 1, 'Waiting on 2')),
        box('Tip', blocked(1, 0, 'Waiting on 1')),
      ],
      [e('clear-head', 'middle'), e('stuck-head', 'middle'), e('middle', 'tip')]
    );
    expect(nodePaths('tip', ctx)?.startWith).toEqual(['clear-head']);
    expect(nodePaths('tip', ctx)?.startsOutside).toBe(false);
  });

  test('without readiness, a start is an upstream node with no blocking in-edge', () => {
    const ctx = pathContext(ISSUES, ISSUE_EDGES);
    // ATL-42's own in-edges are resolved: its blockers are done.
    expect(nodePaths('ATL-44', ctx)?.startWith).toEqual(['ATL-42', 'BIL-12']);
  });

  test('counts what the host knows but the graph does not draw', () => {
    const ctx = pathContext(
      [issue('x', blocked(2, 2)), issue('y', ready(1)), issue('z', blocked(1))],
      [e('y', 'x'), e('x', 'z')]
    );
    const paths = nodePaths('x', ctx);
    expect(paths?.blockersNotDrawn).toBe(1);
    expect(paths?.next).toEqual(['z']);
    expect(paths?.unblocksNotDrawn).toBe(1);
    // A start is drawn (y), so the chain does not start outside.
    expect(paths?.startsOutside).toBe(false);
  });

  test('a chain whose heads are blocked outside starts outside', () => {
    expect(nodePaths('O-1', CROSS)?.startWith).toEqual([]);
    expect(nodePaths('O-1', CROSS)?.startsOutside).toBe(true);
    expect(nodePaths('H-1', CROSS)?.startsOutside).toBe(true);
    expect(nodePaths('H-1', CROSS)?.blockersNotDrawn).toBe(1);
  });

  test('blockersDone for an open subject, none for a done one', () => {
    expect(nodePaths('atlas-m3', milestones)?.blockersDone).toEqual([
      'atlas-m2',
    ]);
    expect(nodePaths('atlas-m2', milestones)?.noLongerBlocks).toEqual([
      'atlas-m3',
    ]);
    // A done issue whose open blocker's edge reads resolved (one end done).
    const ctx = pathContext(
      [issue('open', ready(0)), issue('closed', DONE)],
      [e('open', 'closed', 'resolved')]
    );
    expect(nodePaths('closed', ctx)?.blockersDone).toEqual([]);
    expect(nodePaths('open', ctx)?.noLongerBlocks).toEqual(['closed']);
  });
});

describe('accessible name counts', () => {
  /** A straight chain n0 → n1 → … of `size` nodes, no readiness. */
  const straight = (size: number) => {
    const nodes = Array.from({ length: size }, (_, i) => issue(`n${i}`));
    const edges = nodes.slice(1).map((n, i) => e(`n${i}`, n.id));
    return pathContext(nodes, edges);
  };

  test('a small graph gets transitive counts', () => {
    const counts = pathNameCounts(straight(30));
    expect(counts.get('n0')).toEqual({
      transitive: true,
      waitsOn: 0,
      holdsUp: 29,
      unblocks: 1,
      outside: false,
      unblocksNotDrawn: 0,
    });
    expect(counts.get('n15')).toEqual({
      transitive: true,
      waitsOn: 15,
      holdsUp: 14,
      unblocks: 1,
      outside: false,
      unblocksNotDrawn: 0,
    });
    expect(pathNamePhrase(counts.get('n29')!)).toBe('waits on 29, holds up 0');
  });

  test('on the fixture: Index rebuild holds up three and frees two', () => {
    const counts = pathNameCounts(pathContext(MILESTONES, MILESTONE_EDGES));
    expect(pathNamePhrase(counts.get('search-m1')!)).toBe(
      'waits on 0, holds up 3; done would unblock 2'
    );
  });

  test('above PATH_NAME_BUDGET the names keep direct counts and words', () => {
    // 353 × (353 + 352) is within the budget; 354 × (354 + 353) is not.
    expect(353 * (353 + 352)).toBeLessThanOrEqual(PATH_NAME_BUDGET);
    expect(354 * (354 + 353)).toBeGreaterThan(PATH_NAME_BUDGET);
    expect(pathNameCounts(straight(353)).get('n100')?.transitive).toBe(true);
    const counts = pathNameCounts(straight(354));
    expect(counts.get('n100')).toEqual({
      transitive: false,
      waitsOn: 1,
      holdsUp: 1,
      unblocks: 1,
      outside: false,
      unblocksNotDrawn: 0,
    });
    expect(pathNamePhrase(counts.get('n100')!)).toBe(
      'waits on 1, blocks 1; done would unblock 1'
    );
  });

  test("done would unblock reads the host's count when it has one", () => {
    const ctx = pathContext([issue('a', ready(3))], []);
    expect(pathNameCounts(ctx).get('a')?.unblocks).toBe(3);
  });

  test('counts the graph does not draw scope the name to the drawn graph', () => {
    // ENG-5 frees one issue the graph does not draw: "holds up 0" is about
    // what is drawn, and the name says so instead of contradicting itself.
    const frees = pathNameCounts(pathContext([issue('ENG-5', ready(1))], []));
    expect(pathNamePhrase(frees.get('ENG-5')!)).toBe(
      'waits on 0, holds up 0 in this graph; done would unblock 1 (1 not drawn)'
    );
    // A blocker the graph does not draw scopes it too.
    const waits = pathNameCounts(pathContext([issue('W', blocked(1))], []));
    expect(pathNamePhrase(waits.get('W')!)).toBe(
      'waits on 0, holds up 0 in this graph'
    );
  });
});

describe('sccGroups', () => {
  test('a 3-cycle plus a self-loop, members in node order', () => {
    const groups = sccGroups(
      ['c', 'a', 'b', 'd', 's'],
      [e('a', 'b'), e('b', 'c'), e('c', 'a'), e('c', 'd'), e('s', 's')]
    );
    expect(groups).toHaveLength(3);
    expect(groups).toContainEqual(['c', 'a', 'b']);
    expect(groups).toContainEqual(['s']);
    // Every group comes after the groups that point into it.
    const at = (id: string) => groups.findIndex((g) => g.includes(id));
    expect(at('a')).toBeLessThan(at('d'));
  });

  test('ignores edges with an end outside the nodes', () => {
    expect(sccGroups(['a'], [e('a', 'x'), e('x', 'a')])).toEqual([['a']]);
  });
});

describe('longestChain', () => {
  const milestones = longestChains(MILESTONES, MILESTONE_EDGES);

  test('graph-wide on the fixture: the identity cycle into Decommission', () => {
    const chain = longestChain(milestones);
    expect(chain?.groups).toEqual([
      ['identity-m1', 'identity-m2'],
      ['atlas-m4'],
    ]);
    expect(chain?.nodeIds).toEqual(['identity-m1', 'identity-m2', 'atlas-m4']);
    expect(chain?.length).toBe(3);
    expect(chain?.stepCount).toBe(2);
    expect(chain?.throughCycle).toBe(true);
    // Cycle members share one step number.
    expect([...(chain?.steps ?? [])]).toEqual([
      ['identity-m1', 1],
      ['identity-m2', 1],
      ['atlas-m4', 2],
    ]);
    expect([...(chain?.edgeKeys ?? [])].sort()).toEqual([
      'identity-m1->identity-m2',
      'identity-m2->atlas-m4',
      'identity-m2->identity-m1',
    ]);
    expect(chain?.edges).toEqual([
      { from: 'identity-m1', to: 'identity-m2' },
      { from: 'identity-m2', to: 'identity-m1' },
      { from: 'identity-m2', to: 'atlas-m4' },
    ]);
  });

  test('through a node: the longest chain into it joined to the longest out', () => {
    const through = (id: string) => longestChain(milestones, id)?.nodeIds;
    expect(through('mobile-m1')).toEqual([
      'search-m1',
      'mobile-m1',
      'mobile-m2',
    ]);
    // The predecessor tie (mobile-m1 vs the identity cycle) goes to the
    // earlier node.
    expect(through('mobile-m2')).toEqual([
      'search-m1',
      'mobile-m1',
      'mobile-m2',
    ]);
    expect(through('atlas-m3')).toEqual([
      'atlas-m3',
      'billing-m1',
      'billing-m2',
    ]);
    expect(through('search-m2')).toEqual(['search-m1', 'search-m2']);
    const chain = longestChain(milestones, 'atlas-m3');
    expect(chain?.steps.get('billing-m1')).toBe(2);
    expect([...(chain?.edgeKeys ?? [])]).toEqual([
      'atlas-m3->billing-m1',
      'billing-m1->billing-m2',
    ]);
  });

  test('is null below two nodes and for a node not drawn', () => {
    expect(longestChain(milestones, 'atlas-m2')).toBeNull();
    expect(longestChain(milestones, 'nope')).toBeNull();
    expect(longestChain(longestChains([], []))).toBeNull();
    expect(longestChain(longestChains([issue('a')], [e('a', 'a')]))).toBeNull();
  });

  test('issue fixture: the tie with BIL-12 goes by node order', () => {
    const chain = longestChain(longestChains(ISSUES, ISSUE_EDGES));
    expect(chain?.nodeIds).toEqual(['ATL-42', 'ATL-43', 'ATL-44']);
    expect(chain?.throughCycle).toBe(false);
  });

  test('through a node with a back half: the edges are the ones on the path', () => {
    // S's own longest chain out runs S → B → C → D, but the chain through
    // X comes in S → A → X: S → B must not be drawn on it.
    const chains = longestChains(
      ['S', 'A', 'X', 'B', 'C', 'D'].map((id) => issue(id)),
      [e('S', 'A'), e('A', 'X'), e('S', 'B'), e('B', 'C'), e('C', 'D')]
    );
    const chain = longestChain(chains, 'X');
    expect(chain?.groups).toEqual([['S'], ['A'], ['X']]);
    expect([...(chain?.edgeKeys ?? [])].sort()).toEqual(['A->X', 'S->A']);
    expect(chain?.edges).toEqual([
      { from: 'S', to: 'A' },
      { from: 'A', to: 'X' },
    ]);
  });

  test('through a node: a cycle out weighs its member count', () => {
    // X → A (one node) against X → C1 ⇄ C2 (two): the cycle is longer.
    const chains = longestChains(
      ['X', 'A', 'C1', 'C2'].map((id) => issue(id)),
      [e('X', 'A'), e('X', 'C1'), e('C1', 'C2'), e('C2', 'C1')]
    );
    const chain = longestChain(chains, 'X');
    expect(chain?.groups).toEqual([['X'], ['C1', 'C2']]);
    expect(chain?.length).toBe(3);
    expect(chain?.stepCount).toBe(2);
    expect(chain?.throughCycle).toBe(true);
  });

  test('two edges between consecutive groups: the first in input order links them', () => {
    const chains = longestChains(
      ['P1', 'P2', 'Z'].map((id) => issue(id)),
      [e('P1', 'P2'), e('P2', 'P1'), e('P1', 'Z'), e('P2', 'Z')]
    );
    const chain = longestChain(chains);
    expect(chain?.groups).toEqual([['P1', 'P2'], ['Z']]);
    expect(chain?.edgeKeys.has('P1->Z')).toBe(true);
    expect(chain?.edgeKeys.has('P2->Z')).toBe(false);
    expect([...(chain?.edgeKeys ?? [])].sort()).toEqual([
      'P1->P2',
      'P1->Z',
      'P2->P1',
    ]);
  });

  test('a lone 2-cycle is a chain of one step', () => {
    const chain = longestChain(
      longestChains([issue('x'), issue('y')], [e('x', 'y'), e('y', 'x')])
    );
    expect(chain?.stepCount).toBe(1);
    expect(chain?.length).toBe(2);
    expect(chain?.throughCycle).toBe(true);
  });

  test('a self-loop on the chain makes it run through a cycle', () => {
    const chain = longestChain(
      longestChains([issue('s'), issue('t')], [e('s', 's'), e('s', 't')])
    );
    expect(chain?.nodeIds).toEqual(['s', 't']);
    expect(chain?.throughCycle).toBe(true);
    expect([...(chain?.edgeKeys ?? [])]).toEqual(['s->s', 's->t']);
  });

  test('the graph-wide tie ends at the earlier node (inside the container)', () => {
    const chains = longestChains(
      [issue('c'), issue('d'), issue('a'), issue('b')],
      [e('a', 'b'), e('c', 'd')]
    );
    expect(longestChain(chains)?.nodeIds).toEqual(['c', 'd']);
  });

  test('skips resolved edges and edges to nodes not drawn', () => {
    const chains = longestChains(
      [issue('a'), issue('b'), issue('c')],
      [e('a', 'b', 'resolved'), e('b', 'c'), e('c', 'gone')]
    );
    expect(longestChain(chains)?.nodeIds).toEqual(['b', 'c']);
  });

  test('a very long chain does not overflow the stack', () => {
    const size = 20_000;
    const nodes = Array.from({ length: size }, (_, i) => ({ id: `n${i}` }));
    const edges = nodes.slice(1).map((n, i) => e(`n${i}`, n.id));
    const chain = longestChain(longestChains(nodes, edges));
    expect(chain?.length).toBe(size);
    expect(chain?.steps.get(`n${size - 1}`)).toBe(size);
  });
});

describe('copy helpers', () => {
  test('names: the key, else the label cut to 32 characters', () => {
    expect(pathNodeName(issue('ENG-1'))).toBe('ENG-1');
    expect(pathNodeName({ id: 'x', label: 'Short' })).toBe('Short');
    expect(
      pathNodeName({
        id: 'x',
        label: 'Switch the read path over to the new cluster',
      })
    ).toBe('Switch the read path over to th…');
  });

  test('at most three names, then "+k more"', () => {
    expect(nameList(['A', 'B', 'C'])).toBe('A, B, C');
    expect(nameList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C +2 more');
  });

  test('chains past six groups keep the first six and the last', () => {
    const groups = (n: number) =>
      Array.from({ length: n }, (_, i) => [`n${i + 1}`]);
    expect(chainPhrase(groups(7))).toBe('n1 → n2 → n3 → n4 → n5 → n6 → n7');
    expect(chainPhrase(groups(9))).toBe('n1 → n2 → n3 → n4 → n5 → n6 → … → n9');
    expect(chainPhrase([['A', 'B'], ['C']], defaultGraphPathWords, ', ')).toBe(
      'A + B, C'
    );
  });

  test('resolvePathWords ignores undefined overrides', () => {
    const words = resolvePathWords({ next: 'Clear next', done: undefined });
    expect(words.next).toBe('Clear next');
    expect(words.done).toBe('Done');
  });
});

describe('describePaths', () => {
  test('a ready issue', () => {
    expect(line('ENG-12', CHAIN)).toBe(
      'ENG-12 · Ready · Nothing open blocks it · Holds up 2 · Done would unblock 1: ENG-23'
    );
  });

  test('a blocked issue', () => {
    expect(line('ENG-23', CHAIN)).toBe(
      'ENG-23 · Blocked by 1 · Waits on 1 open, start with ENG-12 · Holds up 1 · Done would unblock 1: OPS-20'
    );
  });

  test('a leaf', () => {
    expect(line('OPS-20', CHAIN)).toBe(
      'OPS-20 · Blocked by 1 · Waits on 2 open, start with ENG-12 · Nothing here waits on it'
    );
  });

  test('ready because its blockers are done, and the done blocker', () => {
    const ctx = pathContext(
      [
        issue('ENG-2', DONE, { statusLabel: 'Done' }),
        issue('ENG-26', ready(0)),
      ],
      [e('ENG-2', 'ENG-26', 'resolved')]
    );
    expect(line('ENG-26', ctx)).toBe(
      'ENG-26 · Ready · Blockers done: ENG-2 · Nothing here waits on it'
    );
    expect(line('ENG-2', ctx)).toBe('ENG-2 · Done · No longer blocks ENG-26');
  });

  test('a done node without a statusLabel uses the done word', () => {
    const ctx = pathContext([issue('ENG-2', DONE)], []);
    expect(line('ENG-2', ctx)).toBe('ENG-2 · Done');
    expect(line('ENG-2', ctx, BOX_WORDS)).toBe('ENG-2 · Complete');
  });

  test('something not drawn', () => {
    const ctx = pathContext(
      [
        issue('ENG-9', ready(1)),
        issue('ENG-10', blocked(2, 2)),
        issue('ENG-30', blocked(1)),
      ],
      [e('ENG-9', 'ENG-10'), e('ENG-10', 'ENG-30')]
    );
    expect(line('ENG-10', ctx)).toBe(
      'ENG-10 · Blocked by 2 (1 not drawn) · Waits on 1 open, start with ENG-9 · Holds up 1 · Done would unblock 2: ENG-30 (+1 not drawn)'
    );
  });

  test('every blocker not drawn (CROSS: H-1)', () => {
    expect(line('H-1', CROSS)).toBe(
      'H-1 · Blocked by 1 (1 not drawn) · Waits on 1 outside this graph · Holds up 2 · Done would unblock 1: O-1'
    );
  });

  test('no startable head upstream, a start outside (CROSS: O-1)', () => {
    expect(line('O-1', CROSS)).toBe(
      'O-1 · Blocked by 1 · Waits on 1 open, it starts outside this graph · Holds up 1 · Done would unblock 1: N-1'
    );
  });

  test('blocks only itself (CYCLES: S-1)', () => {
    const ctx = pathContext(
      [issue('S-1', blocked(1))],
      [e('S-1', 'S-1', 'cycle')]
    );
    expect(line('S-1', ctx)).toBe(
      'S-1 · Blocked by 1 · Blocks itself · Nothing here waits on it'
    );
  });

  test('a self-loop and a blocker not drawn: the outside blocker is named first', () => {
    // Blocked by 2: itself (drawn) and one the graph does not draw.
    const ctx = pathContext(
      [issue('S-2', blocked(2))],
      [e('S-2', 'S-2', 'cycle')]
    );
    expect(line('S-2', ctx)).toBe(
      'S-2 · Blocked by 2 (1 not drawn) · Waits on 1 outside this graph · Nothing here waits on it'
    );
  });

  test('only unblocks what is not drawn', () => {
    const ctx = pathContext([issue('ENG-5', ready(1))], []);
    expect(line('ENG-5', ctx)).toBe(
      'ENG-5 · Ready · Nothing open blocks it · Nothing here waits on it · Done would unblock 1: 1 not drawn'
    );
  });

  test('a box, with the planner words', () => {
    expect(line('search-v2-beta', BOXES, BOX_WORDS)).toBe(
      'Search v2 beta · Waiting on 1 · Waits on 1, start with Dual-write · Holds up 1 · Finishing it would clear 1: Tokens and type'
    );
    expect(line('dual-write', BOXES, BOX_WORDS)).toBe(
      'Dual-write · Clear · Nothing outside it holds it up · Holds up 3 · Finishing it would clear 2: Search v2 beta, Read path switch'
    );
  });

  test('a box behind one where nothing can start gets no start clause', () => {
    const ctx = pathContext(
      [
        box('Deadlock', { ...ready(1, 'None ready'), canStart: false }),
        box('After', blocked(1, 0, 'Waiting on 1')),
      ],
      [e('deadlock', 'after')]
    );
    expect(line('after', ctx, BOX_WORDS)).toBe(
      'After · Waiting on 1 · Waits on 1 · Nothing here waits on it'
    );
  });

  test('a host without readiness', () => {
    const ctx = pathContext(ISSUES, ISSUE_EDGES);
    expect(line('ATL-42', ctx)).toBe(
      'Dual-write shim · Blockers done: Freeze writes on legacy DB, Provision read replica · Holds up 2'
    );
    expect(line('ATL-43', ctx)).toBe(
      'Backfill orders table · Waits on 2 open, start with Dual-write shim, Invoice ID migration · Holds up 1 · Done would unblock 1: Switch the read path over to th…'
    );
  });

  test('the lock words and hints are worded for the reader', () => {
    // The graph leads a locked box's line with "Locked on" and its
    // actions; the readout's own parts never change for a lock.
    expect(defaultGraphPathWords.locked).toBe('Locked on');
    expect(defaultGraphPathWords.open).toBe('Open');
    expect(defaultGraphPathWords.openGraph).toBe('Open graph');
    expect(defaultGraphPathWords.openItsGraph).toBe('Open its graph');
    expect(defaultGraphPathWords.unlock).toBe('Unlock');
    expect(defaultGraphPathWords.hint).toContain('click it to lock');
    expect(defaultGraphPathWords.tapHint).toContain('tap it again to open it');
    const readout = describePaths('ENG-23', CHAIN);
    expect(readout === null ? '' : readoutText(readout)).toEndWith(
      'Done would unblock 1: OPS-20'
    );
  });

  test('long name lists are capped', () => {
    const ids = ['A', 'B', 'C', 'D', 'E'];
    const ctx = pathContext(
      [issue('X', ready(5)), ...ids.map((id) => issue(id, blocked(1)))],
      ids.map((id) => e('X', id))
    );
    expect(line('X', ctx)).toBe(
      'X · Ready · Nothing open blocks it · Holds up 5 · Done would unblock 5: A, B, C +2 more'
    );
  });

  test('Critical mode, on a chain', () => {
    expect(line('ENG-23', CHAIN, ISSUE_WORDS, 'critical')).toBe(
      'ENG-23 · Step 2 of 3 · Longest chain through it: 3 issues: ENG-12 → ENG-23 → OPS-20'
    );
    expect(line('ENG-12', CHAIN, {}, 'critical')).toBe(
      'ENG-12 · Step 1 of 3 · Longest chain through it: 3 boxes: ENG-12 → ENG-23 → OPS-20'
    );
  });

  test('Critical mode through a cycle joins its members with +', () => {
    const ctx = pathContext(
      [
        issue('ENG-70', blocked(1, 1)),
        issue('ENG-71', blocked(1, 1)),
        issue('ENG-72', blocked(1)),
      ],
      [
        e('ENG-70', 'ENG-71', 'cycle'),
        e('ENG-71', 'ENG-70', 'cycle'),
        e('ENG-71', 'ENG-72'),
      ]
    );
    expect(line('ENG-72', ctx, ISSUE_WORDS, 'critical')).toBe(
      'ENG-72 · Step 2 of 2 · Longest chain through it: 3 issues: ENG-70 + ENG-71 → ENG-72'
    );
  });

  test('Critical mode, off any chain', () => {
    const ctx = pathContext(
      [issue('ENG-2', DONE), issue('ENG-26', ready(0))],
      [e('ENG-2', 'ENG-26', 'resolved')]
    );
    expect(line('ENG-26', ctx, {}, 'critical')).toBe(
      'ENG-26 · Not on an open chain'
    );
  });

  test('Critical mode uses the chain it is given', () => {
    const wide = longestChain(CHAIN.chains);
    expect(describePaths('ENG-12', CHAIN, {}, 'critical', wide)?.parts[0]).toBe(
      'Step 1 of 3'
    );
    expect(describePaths('ENG-12', CHAIN, {}, 'critical', null)?.parts).toEqual(
      ['Not on an open chain']
    );
  });

  test('Status and Risk read the same; a node not drawn reads nothing', () => {
    expect(line('ENG-23', CHAIN, {}, 'risk')).toBe(line('ENG-23', CHAIN));
    expect(describePaths('nope', CHAIN)).toBeNull();
  });
});
