import { createContext, useContext, useMemo } from 'react';
import { toast } from 'sonner';

import { sonnerOptionsFor, type ToastTone } from './toastContract';
import { Toaster } from '@/ui/sonner';

interface ToastInput {
  title: string;
  /** The detail line. For a failure this should be what actually went wrong. */
  description?: string;
  tone?: ToastTone;
}

interface ToastApi {
  push: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_FN = {
  error: toast.error,
  success: toast.success,
  info: toast.info,
} as const;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const api = useMemo<ToastApi>(
    () => ({
      push: (input) => {
        const tone = input.tone ?? 'info';
        TONE_FN[tone](input.title, {
          description: input.description,
          ...sonnerOptionsFor(tone),
        });
      },
    }),
    []
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster position="bottom-right" visibleToasts={4} closeButton />
    </ToastContext.Provider>
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
