import type { ApiClient, TerminalInfo } from '@dispatch/client';
import { cx } from '@dispatch/ui';
import { useCallback, useRef } from 'react';

import type { TerminalSubscribe } from '../../hooks/useTerminalOutput';
import type { LayoutNode, SplitDirection } from '../../lib/terminalSplits';
import { MAX_RATIO, MIN_RATIO } from '../../lib/terminalSplits';
import { TerminalPane } from './TerminalPane';
import styles from './TerminalSplitView.module.css';

/**
 * Lays the split tree out, one nested flex box per split.
 *
 * Flex with an explicit basis rather than a grid: the tree nests to any depth,
 * and a grid would need a track computed across the whole layout, while a flex
 * pair only has to know its own ratio.
 */

interface TerminalSplitViewProps {
  node: LayoutNode;
  client: ApiClient | null;
  terminals: TerminalInfo[];
  focusedPaneId: string | null;
  subscribe: TerminalSubscribe | null;
  onFocusPane: (paneId: string) => void;
  onAttach: (paneId: string, terminalId: string | null) => void;
  onOpenSession: (paneId: string) => void;
  onSplit: (paneId: string, direction: SplitDirection) => void;
  onClosePane: (paneId: string) => void;
  onRemoveSession: (terminalId: string) => void;
  onResize: (splitId: string, ratio: number) => void;
}

// How far one arrow key moves a divider: a twentieth of the split's box.
const KEY_STEP = 0.05;

// The ratio a divider key asks for, or null for a key the divider ignores.
// Left and Up shrink the first pane and Right and Down grow it, whatever the
// split's orientation, so either pair works on either divider. Home and End
// jump to the bounds setRatio clamps to. The result is rounded to two places
// so repeated steps land on 0.55, 0.6… rather than drifting in binary.
function ratioForKey(key: string, ratio: number): number | null {
  let next: number;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      next = ratio - KEY_STEP;
      break;
    case 'ArrowRight':
    case 'ArrowDown':
      next = ratio + KEY_STEP;
      break;
    case 'Home':
      return MIN_RATIO;
    case 'End':
      return MAX_RATIO;
    default:
      return null;
  }
  const rounded = Math.round(next * 100) / 100;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, rounded));
}

// The grab handle between two children, a focusable separator with a value.
// Dragging it reports a ratio measured against the split's own box, so
// nesting needs no coordinate translation; the keys step it (see ratioForKey).
function Divider({
  direction,
  ratio,
  onResize,
}: {
  direction: SplitDirection;
  ratio: number;
  onResize: (ratio: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const container = ref.current?.parentElement;
      if (container == null) return;
      event.preventDefault();
      const box = container.getBoundingClientRect();
      const move = (moveEvent: PointerEvent) => {
        const next =
          direction === 'row'
            ? (moveEvent.clientX - box.left) / box.width
            : (moveEvent.clientY - box.top) / box.height;
        if (Number.isFinite(next)) onResize(next);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [direction, onResize]
  );

  // Handled keys stop here: an arrow must move the divider, not scroll the
  // page, and Home or End must not reach the app's own shortcuts.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const next = ratioForKey(event.key, ratio);
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      onResize(next);
    },
    [ratio, onResize]
  );

  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={0}
      aria-label="Resize panes"
      aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={MIN_RATIO * 100}
      aria-valuemax={MAX_RATIO * 100}
      className={cx(
        styles.divider,
        direction === 'row' ? styles.dividerRow : styles.dividerColumn
      )}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

export function TerminalSplitView(props: TerminalSplitViewProps) {
  const { node } = props;

  if (node.kind === 'pane') {
    return (
      <TerminalPane
        client={props.client}
        paneId={node.id}
        terminalId={node.terminalId}
        terminals={props.terminals}
        focused={props.focusedPaneId === node.id}
        subscribe={props.subscribe}
        onFocus={() => props.onFocusPane(node.id)}
        onAttach={(terminalId) => props.onAttach(node.id, terminalId)}
        onOpenSession={() => props.onOpenSession(node.id)}
        onSplit={(direction) => props.onSplit(node.id, direction)}
        onClose={() => props.onClosePane(node.id)}
        onRemoveSession={props.onRemoveSession}
      />
    );
  }

  const [first, second] = node.children;
  return (
    <div
      className={cx(
        styles.split,
        node.direction === 'row' ? styles.row : styles.column
      )}
    >
      {/* The first child's share is the split's ratio; the second takes the
          rest. Inline because the ratio is per split and changes on drag. */}
      <div
        className={styles.child}
        style={{
          flexBasis: `${node.ratio * 100}%`,
          flexGrow: 0,
          flexShrink: 1,
        }}
      >
        <TerminalSplitView {...props} node={first} />
      </div>
      <Divider
        direction={node.direction}
        ratio={node.ratio}
        onResize={(ratio) => props.onResize(node.id, ratio)}
      />
      <div className={cx(styles.child, styles.rest)}>
        <TerminalSplitView {...props} node={second} />
      </div>
    </div>
  );
}
