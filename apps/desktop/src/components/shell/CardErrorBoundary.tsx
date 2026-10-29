import { ChevronRight, TriangleAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { contentKey } from '../../lib/cardContent';
import { Button } from '@/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';

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
    const { raw } = this.props;
    return (
      <div
        data-slot="card-error"
        role="note"
        className="text-muted-foreground flex flex-col gap-1 rounded-md px-2 py-1 text-[12px]"
      >
        <Collapsible>
          <div className="flex items-center gap-2">
            <TriangleAlert className="text-state-failed size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Couldn&apos;t display this step
            </span>
            <CollapsibleTrigger
              render={<Button variant="ghost" size="xs" className="group" />}
            >
              <ChevronRight className="size-3 transition-transform group-data-panel-open:rotate-90" />
              Show raw
            </CollapsibleTrigger>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void navigator.clipboard?.writeText(raw)}
            >
              Copy
            </Button>
          </div>
          <CollapsibleContent>
            <pre
              data-slot="card-error-raw"
              className="bg-secondary/50 mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-[11px] break-words whitespace-pre-wrap"
            >
              {raw}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </div>
    );
  }
}
