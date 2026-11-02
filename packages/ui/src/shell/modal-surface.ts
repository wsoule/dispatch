'use client';

import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import { useLatest } from '../edit/save-state';
import { trapTab, useDialogFocus, useScrollLock } from './dom';
import { useLayer } from './layer';
import type { ModalSurface, ModalSurfaceOptions } from './types';

/**
 * The behaviour of a panel over a scrim, shared by a modal SlideOver and a
 * host's own modal panel (Dispatch's Settings), so it lives in one place:
 *
 * - focus moves into the panel on open (or `initialFocusRef`) and back to
 *   whatever had it on close, if that is still in the document;
 * - Tab and Shift+Tab cycle inside the panel;
 * - while `modal`: the panel is a modal layer of the package's stack (a
 *   picker, popover, menu, tooltip or Dialog opened in it takes Escape and
 *   presses first, one layer per press, and an Escape with focus fallen
 *   out of the panel still closes it before any page listener sees it),
 *   the page behind does not scroll, Escape from inside closes it, a click
 *   on the scrim closes it unless the press closed a layer sitting over
 *   the panel, and focus never rests on <body> behind it.
 *
 * It renders nothing and stays out of the browser's top layer: the host
 * draws the scrim and the panel and places them (a fixed overlay with its
 * own z-index), and wires `scrimProps` and `onKeyDown` in. Keys that reach
 * `onKeyDown` from outside the panel's DOM (a React portal rendered from
 * inside it, such as a host's legacy dialog) are left to their own surface.
 */
export function useModalSurface(options: ModalSurfaceOptions): ModalSurface {
  const { open, panelRef, scrimRef, initialFocusRef, modal = true } = options;
  const latest = useLatest({ onClose: options.onClose, modal });
  const active = open && modal;

  useDialogFocus(panelRef, open, initialFocusRef);
  useScrollLock(active);

  // Presses outside never close it from the stack: the scrim's own click
  // does (a toast over the scrim stays usable).
  const layer = useLayer({
    open: active,
    kind: 'modal',
    ref: panelRef,
    closeOnOutside: false,
    onDismiss: () => latest.current.onClose(),
  });

  // A press that starts on the scrim while another layer sits over the
  // panel (a picker open in it) closes only that layer: the stack does
  // that on pointerdown, so the scrim's click must not close the panel
  // too. Read on `window` in the capture phase, which runs before the
  // stack's document listener, while that layer is still open.
  const scrimPressCovered = useRef(false);
  useEffect(() => {
    if (!active) return undefined;
    function onPress(event: PointerEvent): void {
      scrimPressCovered.current =
        event.target === scrimRef.current && !layer.isTop(true);
    }
    window.addEventListener('pointerdown', onPress, true);
    return () => window.removeEventListener('pointerdown', onPress, true);
  }, [active, layer, scrimRef]);

  // Focus never rests on <body> behind the panel. A focused control that
  // unmounts or turns disabled (a busy submit, a removed row) drops focus
  // there, where Tab would walk the page behind the scrim and page
  // listeners would take keys meant for the panel. A focusout with nowhere
  // to go is checked a tick later (after a host's own focus move, or a
  // picker handing focus back to its trigger) and, if focus is still on
  // <body> and no layer sits over the panel, the panel takes it; a Tab
  // pressed from <body> moves into the panel.
  useEffect(() => {
    const panel = panelRef.current;
    if (!active || panel === null) return undefined;
    const target: HTMLElement = panel;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function focusLost(): boolean {
      const focused = document.activeElement;
      return (
        focused === null ||
        focused === document.body ||
        focused === document.documentElement
      );
    }
    function onFocusOut(event: FocusEvent): void {
      if (event.relatedTarget !== null) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (focusLost() && target.isConnected && layer.isTop(true)) {
          target.focus({ preventScroll: true });
        }
      }, 0);
    }
    function onTab(event: globalThis.KeyboardEvent): void {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      if (!focusLost() || !layer.isTop(true)) return;
      trapTab(event, target);
      event.stopPropagation();
    }
    target.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onTab, true);
    return () => {
      clearTimeout(timer);
      target.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onTab, true);
    };
  }, [active, layer, panelRef]);

  return useMemo<ModalSurface>(
    () => ({
      scrimProps: {
        // A press on the scrim must not move focus out of the panel.
        onMouseDown: (event: MouseEvent<HTMLElement>) => {
          if (event.target === event.currentTarget) event.preventDefault();
        },
        onClick: (event: MouseEvent<HTMLElement>) => {
          if (event.target !== event.currentTarget) return;
          const covered = scrimPressCovered.current;
          scrimPressCovered.current = false;
          if (!covered) latest.current.onClose();
        },
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const panel = panelRef.current;
        const target = event.target;
        if (
          panel === null ||
          !(target instanceof Node) ||
          !panel.contains(target)
        ) {
          return;
        }
        const isModal = latest.current.modal;
        if (isModal && event.key === 'Escape') {
          // Something focused inside (a field cancelling its edit, an
          // open picker) took it first.
          if (event.nativeEvent.isComposing || event.defaultPrevented) return;
          // Stopped here, so a non-modal SlideOver underneath (whose
          // document listener came first) and the host's shortcuts never
          // see it.
          event.preventDefault();
          event.stopPropagation();
          latest.current.onClose();
          return;
        }
        trapTab(event, panel);
        // A slide-over around this modal surface traps Tab too: one trap.
        if (isModal && event.key === 'Tab') event.stopPropagation();
      },
    }),
    [latest, panelRef]
  );
}
