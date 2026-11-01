import { Button, Disclosure, EmptyState } from '@dispatch/ui';
import { OctagonAlert } from 'lucide-react';
import { Component, type ErrorInfo, Fragment, type ReactNode } from 'react';

import styles from './ErrorBoundary.module.css';
import { errorDetails, isStaleChunkError } from './errorBoundaryUtils';

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
    const label = this.props.label ?? 'this view';

    // The fallback: the library EmptyState with a danger-toned OctagonAlert, the sentence
    // naming what failed and the reassurance under it, "Try again", "Reload app" and "Copy
    // error details" (the name, message and stack for a bug report), the stale-module hint
    // when a stale chunk threw, and the thrown message in a mono block behind "Details".
    // role="alert" so a crash that replaces a view is announced.
    return (
      <div className={styles.root} role="alert">
        <EmptyState
          icon={
            <span className={styles.icon} data-tone="danger">
              <OctagonAlert size={22} strokeWidth={1.8} aria-hidden="true" />
            </span>
          }
          label={`Dispatch couldn't display ${label}.`}
          action={
            <div className={styles.actions}>
              <div className={styles.buttons}>
                <Button variant="secondary" size="sm" onClick={this.reset}>
                  Try again
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.location.reload()}
                >
                  Reload app
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() =>
                    void navigator.clipboard?.writeText(errorDetails(error))
                  }
                >
                  Copy error details
                </Button>
              </div>
              {staleChunk && (
                <p className={styles.hint}>
                  A stale module was requested — reloading usually fixes this
                  after an update.
                </p>
              )}
              <Disclosure variant="inline" summary="Details">
                <pre className={styles.detail}>{error.message}</pre>
              </Disclosure>
            </div>
          }
        >
          Your runs and tasks are unaffected. Try again, or reload the app if it
          keeps happening.
        </EmptyState>
      </div>
    );
  }
}
