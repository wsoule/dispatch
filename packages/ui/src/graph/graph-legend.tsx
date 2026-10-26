import type { ReactNode } from 'react';

import { cx } from '../tasks/class-names';
import styles from './graph-legend.module.css';
import type {
  GraphLegendItem,
  GraphLegendMark,
  GraphLegendProps,
} from './types';

/** Every mark DependencyGraph draws under its default (Risk) highlight,
    in the order a reader meets them, then what pointing at a node lights. */
export const defaultGraphLegend: GraphLegendItem[] = [
  {
    mark: 'node',
    label: 'Node',
    note: 'in a frame, blockers sit left of what waits',
  },
  { mark: 'node-overdue', label: 'Overdue', note: 'past its date' },
  {
    mark: 'node-warning',
    label: 'Needs action',
    note: 'unassigned or at risk',
  },
  { mark: 'node-cycle', label: 'In a cycle', note: 'waits on itself' },
  { mark: 'node-external', label: 'External', note: 'outside this scope' },
  { mark: 'edge-default', label: 'Blocks', note: 'blocker → waiting' },
  {
    mark: 'edge-risk',
    label: 'Risk chain',
    note: 'ends in an unassigned or overdue blocker',
  },
  { mark: 'edge-cycle', label: 'Cycle', note: 'both ends wait' },
  { mark: 'edge-cross', label: 'Cross-project', note: 'leaves its project' },
  {
    mark: 'edge-resolved',
    label: 'Unblocked',
    note: 'one end is done: no longer blocking',
  },
  { mark: 'weight', label: 'Count', note: 'relations on one edge' },
  {
    mark: 'path-locked',
    label: 'Locked',
    note: 'the box you clicked: its paths stay lit',
  },
  {
    mark: 'path-up',
    label: 'Waits on',
    note: 'what the box you point at waits on',
  },
  { mark: 'path-down', label: 'Holds up', note: 'what waits on it' },
  { mark: 'path-next', label: 'Ready next', note: 'ready once it is done' },
];

const EDGE_SWATCH: Partial<Record<GraphLegendMark, string | undefined>> = {
  'edge-default': styles.edgeDefault,
  'edge-risk': styles.edgeRisk,
  'edge-cycle': styles.edgeCycle,
  'edge-cross': styles.edgeCross,
  'edge-resolved': styles.edgeResolved,
  'edge-unblocked': styles.edgeUnblocked,
  'edge-chain': styles.edgeChain,
};

const NODE_SWATCH: Partial<Record<GraphLegendMark, string | undefined>> = {
  node: undefined,
  'node-accent': styles.nodeAccent,
  'node-warning': styles.nodeWarning,
  'node-overdue': styles.nodeOverdue,
  'node-external': styles.nodeExternal,
  'node-cycle': styles.nodeCycle,
  'node-muted': styles.nodeMuted,
  'node-focus': styles.nodeFocus,
  'node-ready': styles.nodeReady,
  'node-blocked': styles.nodeBlocked,
  'node-stuck': styles.nodeStuck,
  'node-chain': styles.nodeChain,
  'node-faded': styles.nodeFaded,
  'path-active': styles.pathActive,
  'path-locked': styles.pathLocked,
  'path-up': styles.pathUp,
  'path-down': styles.pathDown,
  'path-next': styles.pathNext,
  'path-chain': styles.pathChain,
  cluster: styles.cluster,
  'cluster-muted': styles.clusterMuted,
};

/** Swatches that carry a small mark of their own: the step disc of a box
    on the critical path, the "Ready next" pill riding a box (as its green
    dot). */
const BADGE: Partial<Record<GraphLegendMark, 'step' | 'next'>> = {
  'node-chain': 'step',
  'path-chain': 'step',
  'path-next': 'next',
};

/** The legend row a mark belongs to: what boxes (and the frames around
    them) look like, what the lines mean, and what pointing at a box
    lights. */
function rowOf(mark: GraphLegendMark): 'Nodes' | 'Edges' | 'Paths' {
  if (mark.startsWith('path')) return 'Paths';
  return mark.startsWith('node') || mark.startsWith('cluster')
    ? 'Nodes'
    : 'Edges';
}

/** The small drawing beside a legend label, in the graph's own marks.
    `data-mark` names the mark for hosts' and tests' queries. Hidden from
    assistive tech: the label beside it says what it means. */
function Swatch({ mark }: { mark: GraphLegendMark }): ReactNode {
  if (mark === 'weight') {
    return (
      <span className={styles.weight} data-mark={mark} aria-hidden="true">
        3
      </span>
    );
  }
  if (mark in EDGE_SWATCH) {
    return (
      <svg
        className={cx(styles.edge, EDGE_SWATCH[mark])}
        width="28"
        height="10"
        viewBox="0 0 28 10"
        data-mark={mark}
        aria-hidden="true"
      >
        <path className={styles.edgeLine} d="M1,5L22,5" />
        <path className={styles.edgeArrow} d="M28,5L22,2L22,8Z" />
      </svg>
    );
  }
  const badge = BADGE[mark];
  return (
    <span
      className={cx(styles.node, NODE_SWATCH[mark])}
      data-mark={mark}
      aria-hidden="true"
    >
      {badge === 'step' ? <span className={styles.step}>1</span> : null}
      {badge === 'next' ? <span className={styles.next} /> : null}
    </span>
  );
}

/**
 * The graph's key as Gr8r-style key rows: no box, a quiet row name (Nodes,
 * Edges, Paths), then swatch + sentence-case name + quiet note per item,
 * so the box looks, the edge kinds and what pointing at a box lights never
 * mix. Notes drop away on narrower screens; the names carry the meaning.
 */
export function GraphLegend({
  items = defaultGraphLegend,
  label = 'Graph legend',
  className,
}: GraphLegendProps): ReactNode {
  const rows = (['Nodes', 'Edges', 'Paths'] as const)
    .map((key) => ({
      key,
      list: items.filter((item) => rowOf(item.mark) === key),
    }))
    .filter((row) => row.list.length > 0);
  return (
    <div
      className={cx(styles.legend, className)}
      role="group"
      aria-label={label}
    >
      {rows.map((row) => (
        <div key={row.key} className={styles.row}>
          <span className={styles.rowKey}>{row.key}</span>
          <ul className={styles.list}>
            {row.list.map((item) => (
              <li key={`${item.mark}:${item.label}`} className={styles.item}>
                <Swatch mark={item.mark} />
                <span className={styles.label}>{item.label}</span>
                {item.note !== undefined && item.note !== '' ? (
                  <span className={styles.note}>{item.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
