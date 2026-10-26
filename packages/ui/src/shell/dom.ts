'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

// Browser plumbing shared by the shell family: focus management for the
// overlays, the "is the user typing?" test that gates single-key shortcuts,
// storage that tolerates private mode, and a couple of media-query hooks.

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** The elements Tab can reach inside `root`, in DOM order, skipping ones
    that are hidden, inert or not rendered at this breakpoint. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  // Array.from: iterating a NodeList directly needs lib "DOM.Iterable",
  // which a host compiling this source (Dispatch: TS 5.9, lib DOM) lacks.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))) {
    if (el.closest('[hidden],[inert]') !== null) continue;
    if (
      typeof el.checkVisibility === 'function' &&
      !el.checkVisibility({ visibilityProperty: true })
    ) {
      continue;
    }
    out.push(el);
  }
  return out;
}

/** Keeps Tab / Shift+Tab cycling inside `root`. Call from the container's
    keydown handler; other keys pass through untouched. */
export function trapTab(
  event: { key: string; shiftKey: boolean; preventDefault: () => void },
  root: HTMLElement
): void {
  if (event.key !== 'Tab') return;
  const items = focusableWithin(root);
  if (items.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && root.contains(active);
  if (event.shiftKey && (!inside || active === first || active === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Dialog focus contract: while `active`, focus moves into the container
 * (the initial-focus element, else the container itself so the dialog's
 * label is announced first); when it turns off or unmounts, focus goes back
 * to whatever had it before, if that element is still in the document.
 */
export function useDialogFocus(
  rootRef: { readonly current: HTMLElement | null },
  active: boolean,
  initialFocusRef?: { readonly current: HTMLElement | null }
): void {
  useEffect(() => {
    if (!active) return undefined;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const target = initialFocusRef?.current ?? rootRef.current;
    target?.focus({ preventScroll: true });
    return () => {
      if (previous !== null && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [active, rootRef, initialFocusRef]);
}

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

/** True when a key event comes from somewhere the user is typing text, so
    single-key shortcuts must stay out of the way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type);
  }
  return (
    target.closest('[contenteditable=""],[contenteditable="true"]') !== null
  );
}

/** True when a modal dialog (palette, phone drawer, …) is open, so global
    single-key shortcuts must not act on the page behind it. */
export function modalIsOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** localStorage read that tolerates private mode and blocked storage. */
export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** localStorage write; a failure means the choice simply does not persist. */
export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode or quota: keep going without persistence */
  }
}

/** Subscribes to a media query. Server render (and the first client render,
    to hydrate cleanly) answer false. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
    () => false
  );
}

/** The shell's phone breakpoint (matches the CSS `width <= 900px`). */
export const PHONE_QUERY = '(max-width: 900px)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function noSubscription(): () => void {
  return () => undefined;
}

function platformModLabel(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘' : 'Ctrl';
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere. The server (and hydration)
    render "Ctrl" so markup agrees; the client corrects it right after. */
export function useModKeyLabel(): string {
  return useSyncExternalStore(noSubscription, platformModLabel, () => 'Ctrl');
}

/** Stops the page behind a full-screen overlay from scrolling. */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = before;
    };
  }, [active]);
}
