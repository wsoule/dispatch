/**
 * The split layout behind the terminal view: a binary tree of panes, nested to
 * any depth.
 *
 * A tree rather than a list of columns because that is what makes splits
 * compose — splitting a pane that is itself half of a split has to produce a
 * split inside a split, and any flat model has to special-case it. Every
 * operation here returns a new tree rather than mutating, so React state
 * updates are a plain assignment and undo would be a matter of keeping the
 * previous root.
 */

export type SplitDirection = 'row' | 'column';

export interface PaneNode {
  kind: 'pane';
  id: string;
  /** The session shown here, or null for a pane not yet attached to one. */
  terminalId: string | null;
}

interface SplitNode {
  kind: 'split';
  id: string;
  /** `row` puts children side by side; `column` stacks them. */
  direction: SplitDirection;
  children: [LayoutNode, LayoutNode];
  /** The first child's share of the axis, 0–1. */
  ratio: number;
}

export type LayoutNode = PaneNode | SplitNode;

/** The smallest share either side of a split can be dragged or stepped to. */
export const MIN_RATIO = 0.1;
/** The largest share the first side can take; the second keeps the rest. */
export const MAX_RATIO = 0.9;

export function makePane(
  id: string,
  terminalId: string | null = null
): PaneNode {
  return { kind: 'pane', id, terminalId };
}

/** Every pane in left-to-right, top-to-bottom order — which is also tab order. */
export function listPanes(node: LayoutNode): PaneNode[] {
  if (node.kind === 'pane') return [node];
  return [...listPanes(node.children[0]), ...listPanes(node.children[1])];
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  return listPanes(node).find((pane) => pane.id === paneId) ?? null;
}

/**
 * Replaces `paneId` with a split holding it and a new empty pane.
 *
 * The new pane is always the second child, so a split reads in the direction it
 * was made: splitting right puts the new pane on the right, splitting down puts
 * it below.
 */
export function splitPane(
  node: LayoutNode,
  paneId: string,
  direction: SplitDirection,
  newPaneId: string,
  newSplitId: string
): LayoutNode {
  if (node.kind === 'pane') {
    if (node.id !== paneId) return node;
    return {
      kind: 'split',
      id: newSplitId,
      direction,
      children: [node, makePane(newPaneId)],
      ratio: 0.5,
    };
  }
  return {
    ...node,
    children: [
      splitPane(node.children[0], paneId, direction, newPaneId, newSplitId),
      splitPane(node.children[1], paneId, direction, newPaneId, newSplitId),
    ],
  };
}

/**
 * Removes a pane, collapsing the split that held it.
 *
 * Returns null when `paneId` was the only pane left — the caller decides
 * whether that means "close the view" or "start a fresh pane", which is not a
 * layout question.
 */
export function closePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === 'pane') return node.id === paneId ? null : node;
  const [first, second] = node.children;
  const nextFirst = closePane(first, paneId);
  const nextSecond = closePane(second, paneId);
  // A split with one child left is no longer a split: the survivor takes its
  // place, which is what keeps the tree from filling with one-armed nodes.
  if (nextFirst === null) return nextSecond;
  if (nextSecond === null) return nextFirst;
  return { ...node, children: [nextFirst, nextSecond] };
}

/** Points a pane at a session. */
export function attachTerminal(
  node: LayoutNode,
  paneId: string,
  terminalId: string | null
): LayoutNode {
  if (node.kind === 'pane') {
    return node.id === paneId ? { ...node, terminalId } : node;
  }
  return {
    ...node,
    children: [
      attachTerminal(node.children[0], paneId, terminalId),
      attachTerminal(node.children[1], paneId, terminalId),
    ],
  };
}

/** Moves a divider, clamped so neither side can be dragged out of existence. */
export function setRatio(
  node: LayoutNode,
  splitId: string,
  ratio: number
): LayoutNode {
  if (node.kind === 'pane') return node;
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  if (node.id === splitId) return { ...node, ratio: clamped };
  return {
    ...node,
    children: [
      setRatio(node.children[0], splitId, ratio),
      setRatio(node.children[1], splitId, ratio),
    ],
  };
}

/**
 * The pane to focus after `paneId` closes — its neighbour in pane order, or
 * null when nothing is left.
 *
 * Prefers the pane before it, matching what a tab strip does: closing a pane
 * should not jump focus across the layout.
 */
export function neighbourPane(node: LayoutNode, paneId: string): string | null {
  const panes = listPanes(node);
  const index = panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) return null;
  const neighbour = panes[index - 1] ?? panes[index + 1];
  return neighbour?.id ?? null;
}

/** Whether any pane is showing this session — used to avoid double-polling. */
export function terminalIsVisible(
  node: LayoutNode,
  terminalId: string
): boolean {
  return listPanes(node).some((pane) => pane.terminalId === terminalId);
}
