'use client';

import { CircleAlert, Info, X } from 'lucide-react';
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useBulkBarHeight } from '../tasks/bulk-bar-height';
import { cx } from './render';
import styles from './toast.module.css';
import type {
  ToastApi,
  ToastInput,
  ToastKind,
  ToastProviderProps,
} from './types';

// Toasts: a bottom-right stack (full width above the tab bar on phones) of
// Gr8r's inverted cards, each an icon, a lead-in word and one sentence
// (an error's icon is red). Auto-dismiss after
// 4s, paused while hovered or focused; at most three on screen. Screen
// readers hear infos politely and errors assertively through two live
// regions that mirror the stack.

const DEFAULT_DURATION = 4000;
const MAX_VISIBLE = 3;
const DEFAULT_LABEL: Record<ToastKind, string> = {
  info: 'Info',
  error: 'Error',
};

interface ToastRecord {
  id: string;
  kind: ToastKind;
  message: string;
  label: string;
  action?: ToastInput['action'];
  duration: number;
  announce?: string;
  onClose?: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** The toast API; throws outside a ToastProvider so a missing provider is
    found in development rather than silently swallowing messages. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error('useToast() must be used inside <ToastProvider>.');
  }
  return api;
}

/* One toast. Owns its timer so hover/focus can pause it: the remaining time
   is banked when paused and the countdown resumes from there. */
function ToastItem({
  record,
  onDismiss,
}: {
  record: ToastRecord;
  onDismiss: (id: string) => void;
}): ReactNode {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remaining = useRef(record.duration);

  useEffect(() => {
    if (paused || !Number.isFinite(remaining.current)) return undefined;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(record.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [paused, onDismiss, record.id]);

  const timed = Number.isFinite(record.duration);
  const style = { '--toast-duration': `${record.duration}ms` } as CSSProperties;

  return (
    <li
      className={cx(styles.toast, record.kind === 'error' && styles.error)}
      data-paused={paused ? 'true' : undefined}
      style={timed ? style : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      <span className={styles.icon} aria-hidden="true">
        {record.kind === 'error' ? (
          <CircleAlert size={15} strokeWidth={1.8} />
        ) : (
          <Info size={15} strokeWidth={1.8} />
        )}
      </span>
      <p className={styles.message}>
        <span className={styles.label}>{record.label}</span> {record.message}
      </p>
      {record.action !== undefined ? (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            record.action?.onClick();
            onDismiss(record.id);
          }}
        >
          {record.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className={styles.dismiss}
        aria-label="Dismiss notification"
        onClick={() => onDismiss(record.id)}
      >
        <X size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {timed ? <span className={styles.timer} aria-hidden="true" /> : null}
    </li>
  );
}

/** Provides useToast() and renders the stack. Mount once near the root. */
export function ToastProvider({
  children,
  label = 'Notifications',
}: ToastProviderProps): ReactNode {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const counter = useRef(0);
  const viewportRef = useRef<HTMLElement>(null);
  // Where keyboard focus was before it entered the stack, and whether a
  // dismissal just removed the toast holding focus.
  const returnFocus = useRef<HTMLElement | null>(null);
  const refocus = useRef(false);

  const dismiss = useCallback((id: string) => {
    const viewport = viewportRef.current;
    if (viewport !== null && viewport.contains(document.activeElement)) {
      refocus.current = true;
    }
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  // A toast that held focus is gone: focus would fall to <body>, so hand it
  // to the next toast, else back to where the user was. If the toast's
  // action already moved focus somewhere real, leave it there.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const current = document.activeElement;
    if (current !== null && current !== document.body && current.isConnected) {
      return;
    }
    const next = viewportRef.current?.querySelector('button');
    if (next != null) {
      next.focus();
    } else if (returnFocus.current?.isConnected === true) {
      returnFocus.current.focus();
    }
  }, [toasts]);

  const toast = useCallback((input: ToastInput): string => {
    counter.current += 1;
    const record: ToastRecord = {
      id: `toast-${counter.current}`,
      kind: input.kind,
      message: input.message,
      label: input.label ?? DEFAULT_LABEL[input.kind],
      action: input.action,
      duration: input.duration ?? DEFAULT_DURATION,
      announce: input.announce,
      onClose: input.onClose,
    };
    // Newest last; the oldest falls off once three are showing.
    setToasts((list) => [...list, record].slice(-MAX_VISIBLE));
    return record.id;
  }, []);

  // Each toast that left the stack since the last render hears onClose
  // once (timed out, dismissed, its action used, or pushed off).
  const shownBefore = useRef<ToastRecord[]>([]);
  useEffect(() => {
    const now = new Set(toasts.map((t) => t.id));
    for (const record of shownBefore.current) {
      if (!now.has(record.id)) record.onClose?.();
    }
    shownBefore.current = toasts;
  }, [toasts]);

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  // A bulk bar's height, on the stack's own element (toast.module.css
  // lifts the stack above the bar by it): a custom property on <html>
  // would restyle every element of the page each time a bar comes or goes.
  const barHeight = useBulkBarHeight();
  const viewportStyle =
    barHeight === null
      ? undefined
      : ({ '--bulk-bar-h': `${barHeight}px` } as CSSProperties);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* A named region (landmark) only while it holds toasts, so screen
          reader landmark lists never offer an empty "Notifications". */}
      <section
        ref={viewportRef}
        className={styles.viewport}
        style={viewportStyle}
        aria-label={toasts.length > 0 ? label : undefined}
        onFocus={(event) => {
          const from = event.relatedTarget;
          if (
            from instanceof HTMLElement &&
            !event.currentTarget.contains(from)
          ) {
            returnFocus.current = from;
          }
        }}
      >
        {toasts.length > 0 ? (
          <ol className={styles.stack}>
            {toasts.map((t) => (
              <ToastItem key={t.id} record={t} onDismiss={dismiss} />
            ))}
          </ol>
        ) : null}
      </section>
      <div role="status" aria-live="polite" className="srOnly">
        {toasts
          .filter((t) => t.kind === 'info')
          .map((t) => (
            <p key={t.id}>{`${t.label}: ${t.announce ?? t.message}`}</p>
          ))}
      </div>
      <div role="alert" aria-live="assertive" className="srOnly">
        {toasts
          .filter((t) => t.kind === 'error')
          .map((t) => (
            <p key={t.id}>{`${t.label}: ${t.announce ?? t.message}`}</p>
          ))}
      </div>
    </ToastContext.Provider>
  );
}
