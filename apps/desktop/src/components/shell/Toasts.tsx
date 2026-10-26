import {
  type ToastInput as UiToastInput,
  ToastProvider as UiToastProvider,
  useToast,
} from '@dispatch/ui';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

import {
  toastActionFor,
  toastDurationFor,
  type ToastLink,
  type ToastTone,
} from './toastContract';

export interface ToastInput {
  /** The semibold lead-in when a `description` follows (`Save failed`); on its own it is the
   * whole sentence (`Copied link`), shown with no lead-in word. */
  title: string;
  /** The sentence after the lead-in. For a failure this should be what actually went wrong;
   * for a task, `t-8f2a — Cache the search index` (`taskToastDescription`). */
  description?: string;
  /** Picks the icon and how long the toast stays (`toastDurationFor`); `info` by default. */
  tone?: ToastTone;
  /** The toast's follow-up — `View task` (`viewTaskLink`). */
  link?: ToastLink;
  /** The same slot as `link`, for follow-ups that are not a navigation (`Restart`); `link`
   * wins when both are given. */
  action?: ToastLink;
}

interface ToastApi {
  push: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Maps a `push` onto the library's toast: the tone is the kind; a title with a description
 * reads the title as the lead-in word and the description as the sentence, a bare title is
 * the sentence alone; `link` and `action` share the one action slot; errors never time out. */
function toUiToast(input: ToastInput): UiToastInput {
  const tone = input.tone ?? 'info';
  const action = toastActionFor(input);
  return {
    kind: tone,
    ...(input.description === undefined
      ? { label: '', message: input.title }
      : { label: input.title, message: input.description }),
    ...(action !== undefined && { action }),
    duration: toastDurationFor(tone),
  };
}

/** Reads the library's `toast()` once and hands every surface one stable `push` over it, so a
 * `[toasts]` dependency never changes. */
function PushBridge({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const api = useMemo<ToastApi>(
    () => ({
      push: (input) => {
        toast(toUiToast(input));
      },
    }),
    [toast]
  );
  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}

/** Mounts @dispatch/ui's toast stack (Gr8r's inverted cards, bottom-right, at most three) and
 * hands every surface a `push`. A toast times out, or its action or dismiss button closes it;
 * an error stays until it is read. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <UiToastProvider>
      <PushBridge>{children}</PushBridge>
    </UiToastProvider>
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
