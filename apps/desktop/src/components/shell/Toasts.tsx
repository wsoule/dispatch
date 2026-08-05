import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

type ToastTone = 'error' | 'success' | 'info';

export interface ToastInput {
  title: string;
  /** The detail line. For a failure this should be what actually went wrong. */
  description?: string;
  tone?: ToastTone;
}

interface Toast extends ToastInput {
  id: number;
  tone: ToastTone;
}

interface ToastApi {
  push: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** How long each tone sticks around. Errors do not auto-dismiss: a failure you
 * did not manage to read is the same as a failure that was never reported. */
const DISMISS_MS: Record<ToastTone, number | null> = {
  success: 3500,
  info: 4500,
  error: null,
};

const MAX_VISIBLE = 4;

/**
 * In-app feedback.
 *
 * Until now the app had exactly two kinds of feedback: an OS notification for a
 * few run transitions, and nothing at all for everything else. Forty-five
 * mutation handlers had two `catch` blocks between them, so a failed merge, a
 * failed dispatch or a failed archive looked identical to a successful one —
 * the button did nothing and no one told you why.
 *
 * Deliberately not a dependency. A queue, a timer and a live region is the
 * whole feature, and this way it inherits the app's own tokens instead of
 * shipping a second design system to style around.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const tone = input.tone ?? 'info';
      setToasts((current) =>
        [...current, { ...input, id, tone }].slice(-MAX_VISIBLE)
      );
      const ms = DISMISS_MS[tone];
      if (ms !== null) setTimeout(() => dismiss(id), ms);
    },
    [dismiss]
  );

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // Polite, not assertive: these announce alongside what you were doing
        // rather than interrupting it. Errors carry role="alert" individually.
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2"
      >
        {toasts.map((toast) => (
          <Row
            key={toast.id}
            toast={toast}
            onDismiss={() => dismiss(toast.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TONE_ICON: Record<ToastTone, typeof Info> = {
  error: CircleAlert,
  success: CircleCheck,
  info: Info,
};

function Row({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = TONE_ICON[toast.tone];
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg',
        'animate-in fade-in-0 slide-in-from-bottom-2 duration-150',
        toast.tone === 'error'
          ? 'border-destructive/40 bg-destructive/10 text-foreground'
          : 'border-border bg-card text-foreground'
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          toast.tone === 'error' && 'text-destructive',
          toast.tone === 'success' && 'text-state-review'
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium">{toast.title}</p>
        {toast.description !== undefined && toast.description !== '' && (
          // Wraps rather than truncates: the detail line is usually the daemon's
          // own error text, and half of that is no more useful than none.
          <p className="text-muted-foreground mt-0.5 text-[12px] break-words">
            {toast.description}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground shrink-0"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Throws outside the provider rather than no-opping — feedback that silently
 * does nothing is the exact problem this exists to fix. */
export function useToasts(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error('useToasts must be used inside <ToastProvider>');
  }
  return api;
}
