import { OctagonAlert } from 'lucide-react';
import { Component, type ErrorInfo, Fragment, type ReactNode } from 'react';

import { isStaleChunkError } from './errorBoundaryUtils';
import { Button } from '@/ui/button';

interface ErrorBoundaryProps {
  /** Human-readable name for the crashed view, used in the fallback's message — e.g. "the
   * diff" or "this dialog". Defaults to "this view" so every call site doesn't have to name
   * itself. */
  label?: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Bumped by "Try again" so the remounted `children` get a fresh `key` — resetting `error`
   * alone would leave the same crashed subtree mounted with the same state that threw. */
  resetCount: number;
}

/**
 * A generic, reusable crash boundary for any subtree of the app. React only supports catching
 * render errors via `componentDidCatch`/`getDerivedStateFromError`, both class-only APIs, so
 * this stays a class component even though the rest of the app is function components. Wrap
 * any view that can independently fail (a diff renderer, a modal's content, the whole page
 * body) so its crash renders an inline fallback instead of blanking the entire app — the real
 * incident this fixes: a `<PatchDiff>` crash, and separately a stale dynamic-import failure in
 * a long-running dev webview, each took down the *entire* window because nothing anywhere
 * caught them.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, resetCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `ErrorBoundary caught an error rendering ${this.props.label ?? 'this view'}:`,
      error,
      info.componentStack
    );
  }

  private reset = (): void => {
    this.setState((s) => ({ error: null, resetCount: s.resetCount + 1 }));
  };

  render(): ReactNode {
    const { error, resetCount } = this.state;
    if (error === null) {
      // A `Fragment` (not a `div`) so this never introduces an extra DOM node between a
      // caller and its own layout-sensitive parent (flex/grid siblings, `DialogContent`'s
      // flex-col children) — keyed on `resetCount` so "Try again" still fully remounts
      // `children` (fresh component instances, not just a cleared error) rather than resuming
      // whatever state the crashed subtree was already in.
      return <Fragment key={resetCount}>{this.props.children}</Fragment>;
    }

    const staleChunk = isStaleChunkError(error.message);

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <OctagonAlert className="text-destructive size-5" />
        <p className="text-muted-foreground max-w-sm text-[13px]">
          Something went wrong rendering {this.props.label ?? 'this view'}
        </p>
        <pre className="text-muted-foreground bg-secondary/50 max-h-48 max-w-lg overflow-auto rounded-md p-3 text-left font-mono text-[11px] whitespace-pre-wrap">
          {error.message}
        </pre>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={this.reset}>
            Try again
          </Button>
          {staleChunk && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.location.reload()}
            >
              Reload app
            </Button>
          )}
        </div>
        {staleChunk && (
          <p className="text-muted-foreground/70 max-w-sm text-[11px]">
            A stale module was requested — reloading usually fixes this after an
            update.
          </p>
        )}
      </div>
    );
  }
}
