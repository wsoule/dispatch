import { Button } from '@dispatch/ui';
import { ChevronRight, TriangleAlert } from 'lucide-react';
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useId,
  useState,
} from 'react';

import { contentKey } from '../../lib/cardContent';
import { RawText } from '../gr8r/RawText';
import styles from './CardErrorBoundary.module.css';

interface CardErrorBoundaryProps {
  /** The item's raw text or JSON, shown (and copyable) when it fails to draw. */
  raw: string;
  children: ReactNode;
}

interface CardErrorBoundaryState {
  error: Error | null;
  /** The content key the error happened on; a different one clears it. */
  failedOn: string | null;
}

/**
 * A crash boundary for one item in a list: a transcript row, a tool card, an
 * Overseer message. When the item throws while rendering, only that item turns
 * into a compact "Couldn't display this step" row with its raw content behind
 * a disclosure, and the rest of the list keeps rendering. ErrorBoundary still
 * guards whole views; this keeps one malformed entry from blanking them.
 *
 * The error clears on its own when `raw` changes, so a streaming update that
 * fixes the item draws it again.
 */
export class CardErrorBoundary extends Component<
  CardErrorBoundaryProps,
  CardErrorBoundaryState
> {
  state: CardErrorBoundaryState = { error: null, failedOn: null };

  static getDerivedStateFromError(
    error: Error
  ): Partial<CardErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: CardErrorBoundaryProps,
    state: CardErrorBoundaryState
  ): Partial<CardErrorBoundaryState> | null {
    if (state.error === null) return null;
    const key = contentKey(props.raw);
    if (state.failedOn === null) return { failedOn: key };
    return state.failedOn === key ? null : { error: null, failedOn: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      "CardErrorBoundary: couldn't display a step:",
      error,
      info.componentStack
    );
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return <CardErrorRow raw={this.props.raw} />;
  }
}

/** The failed item's compact row: the sentence, Show raw (which unfolds the raw content under
    it) and Copy. */
function CardErrorRow({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false);
  const rawId = useId();
  return (
    <div data-slot="card-error" role="note" className={styles.card}>
      <div className={styles.row}>
        <TriangleAlert
          className={styles.icon}
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span className={styles.sentence}>Couldn&apos;t display this step</span>
        <Button
          variant="quiet"
          size="sm"
          icon={
            <ChevronRight
              className={styles.chevron}
              size={12}
              strokeWidth={1.8}
            />
          }
          aria-expanded={open}
          aria-controls={rawId}
          onClick={() => setOpen((value) => !value)}
        >
          Show raw
        </Button>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => void navigator.clipboard?.writeText(raw)}
        >
          Copy
        </Button>
      </div>
      <div id={rawId} hidden={!open}>
        {open ? <RawText>{raw}</RawText> : null}
      </div>
    </div>
  );
}
