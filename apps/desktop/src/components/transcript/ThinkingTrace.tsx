import { Disclosure } from '@dispatch/ui';
import { Brain } from 'lucide-react';

import { ToolChip } from './ToolChip';
import styles from './transcript.module.css';

type ThinkingTraceProps = {
  /** The agent's raw reasoning, as logged. */
  text: string;
  /** The run is still thinking this thought: the label reads "Thinking" and shimmers. */
  live: boolean;
  /** Whether the reasoning is folded away; the caller holds it (collapsed by default). */
  collapsed: boolean;
  onToggle: () => void;
};

/**
 * One `thinking` entry as T3 Code's thinking row: a brain-icon ToolChip row labelled
 * "Thinking" while `live` (its label shimmers, plain under reduced motion) and "Thought"
 * after, opening in place to the agent's raw reasoning in a mono well. The open state
 * lives with the caller so a transcript re-render never folds a thought someone opened.
 * With no text there is nothing to open, so the row is a plain chip.
 */
export function ThinkingTrace({
  text,
  live,
  collapsed,
  onToggle,
}: ThinkingTraceProps) {
  const label = live ? 'Thinking' : 'Thought';
  const state = live ? 'running' : 'done';
  if (text === '') {
    return <ToolChip variant="row" icon={Brain} label={label} state={state} />;
  }
  return (
    <Disclosure
      variant="plain"
      open={!collapsed}
      onOpenChange={onToggle}
      data-slot="thinking-trace"
      trigger={({ open, props }) => (
        <ToolChip
          variant="row"
          icon={Brain}
          label={label}
          state={state}
          expandable
          expanded={open}
          aria-controls={props['aria-controls']}
          onClick={props.onClick}
        />
      )}
    >
      <div className={styles.traceBody}>
        <pre className={styles.traceWell}>{text}</pre>
      </div>
    </Disclosure>
  );
}
