import type {
  SubagentNode,
  SubagentTreeNode,
} from '@dispatch-foo/core/browser';
import { flattenSubagentTree, nestSubagents } from '@dispatch-foo/core/browser';
import { cx, Disclosure } from '@dispatch/ui';
import { Bot, ChevronRight } from 'lucide-react';
import { type ComponentProps, useMemo, useState } from 'react';

import { formatElapsed } from '../../hooks/useElapsed';
import { StateMark } from '../status/StateMark';
import styles from './SubagentTree.module.css';

/** How a sub-agent's status reads as a state mark, so its dot matches every other run's:
 * running is in flight, failed or stopped is the failure mark, and a finished one is the
 * filled neutral "done" disc (never green beside a red failure). */
function dotState(
  status: SubagentNode['status']
): ComponentProps<typeof StateMark>['state'] {
  switch (status) {
    case 'running':
      return 'working';
    case 'failed':
    case 'stopped':
      return 'failed';
    default:
      return 'done';
  }
}

function statusWord(status: SubagentNode['status']): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'done';
  }
}

/** The header's one-line account: "3 of 12 running · 2 failed", or "10 done · 2 failed". */
export function subagentHeadline(nodes: readonly SubagentNode[]): string {
  const running = nodes.filter((n) => n.status === 'running').length;
  const broken = nodes.filter(
    (n) => n.status === 'failed' || n.status === 'stopped'
  ).length;
  const head =
    running > 0
      ? `${running} of ${nodes.length} running`
      : `${nodes.length - broken} done`;
  return broken > 0 ? `${head} · ${broken} failed` : head;
}

/** A sub-agent's elapsed time: its reported duration, else its own clock while it runs. */
function elapsedFor(node: SubagentNode, now: number): string | null {
  if (node.durationMs !== undefined) return formatElapsed(node.durationMs);
  const start = Date.parse(node.startedAt);
  if (Number.isNaN(start)) return null;
  const end = node.finishedAt !== undefined ? Date.parse(node.finishedAt) : now;
  return formatElapsed(end - start);
}

/**
 * The sub-agents a run's agent fanned out into, as an indented tree above the
 * transcript. One row per sub-agent: status dot, what it was asked to do, its
 * type, how many tool calls it has made, how long it has run, and either what
 * it is doing right now (a progress summary or its last tool) or how it
 * ended. Collapsible because a run with thirty sub-agents would otherwise
 * push its own transcript below the fold; it opens with the run and remembers
 * the toggle for the view's life.
 */
export function SubagentTree({
  nodes,
  className,
}: {
  nodes: readonly SubagentNode[];
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const rows = useMemo(
    () => flattenSubagentTree(nestSubagents(nodes)),
    [nodes]
  );
  if (nodes.length === 0) return null;
  const now = Date.now();
  const anyRunning = nodes.some((n) => n.status === 'running');

  return (
    <div className={cx(styles.tree, className)}>
      <Disclosure
        variant="plain"
        open={open}
        onOpenChange={setOpen}
        data-testid="subagent-tree"
        trigger={({ open: shown, props }) => (
          <button
            {...props}
            className={styles.header}
            aria-label={`Sub-agents: ${subagentHeadline(nodes)}`}
          >
            <ChevronRight
              className={cx(styles.icon, shown ? styles.open : undefined)}
              size={14}
              strokeWidth={1.8}
              aria-hidden
            />
            <Bot
              className={styles.icon}
              size={14}
              strokeWidth={1.8}
              aria-hidden
            />
            <span className={styles.title}>Sub-agents · {nodes.length}</span>
            <span
              className={cx(
                styles.headline,
                'num',
                anyRunning ? styles.headlineLive : undefined
              )}
            >
              {subagentHeadline(nodes)}
            </span>
          </button>
        )}
      >
        <ul role="tree" aria-label="Sub-agents" className={styles.list}>
          {rows.map((row) => (
            <SubagentRow key={row.id} node={row} now={now} />
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

function SubagentRow({ node, now }: { node: SubagentTreeNode; now: number }) {
  const state = dotState(node.status);
  const elapsed = elapsedFor(node, now);
  // What the row says after the facts: the live summary while running (or the
  // last tool as a stand-in), the report once it ended.
  const tail =
    node.status === 'running'
      ? (node.summary ??
        (node.lastTool !== undefined ? `using ${node.lastTool}` : null))
      : node.summary;
  const broken = node.status === 'failed' || node.status === 'stopped';
  return (
    <li
      role="treeitem"
      aria-level={node.depth + 1}
      aria-label={`${node.label}, ${statusWord(node.status)}`}
      className={styles.row}
      // Each level of nesting steps the row in by 16px past the 10px edge.
      style={{ paddingInlineStart: `${10 + node.depth * 16}px` }}
    >
      <span className={styles.lead}>
        <StateMark
          state={state}
          variant="dot"
          pulse={node.status === 'running'}
        />
        <span className={styles.label} title={node.label}>
          {node.label}
        </span>
        {node.type !== undefined && (
          <span className={styles.type}>{node.type}</span>
        )}
      </span>
      <span className={cx(styles.facts, 'num')}>
        <span>
          {node.toolUses} {node.toolUses === 1 ? 'call' : 'calls'}
        </span>
        {elapsed !== null && <span>{elapsed}</span>}
        <span
          className={cx(styles.status, broken ? 'toneText' : undefined)}
          data-tone={broken ? 'danger' : undefined}
        >
          {statusWord(node.status)}
        </span>
      </span>
      {tail !== undefined && tail !== null && tail !== '' && (
        <span className={styles.tail} title={tail}>
          {tail}
        </span>
      )}
    </li>
  );
}
