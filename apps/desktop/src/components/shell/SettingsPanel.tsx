import { Button } from '@dispatch/ui';
import { X } from 'lucide-react';
import type {
  ComponentProps,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { SettingsView } from '../../views/SettingsView';
import styles from './SettingsPanel.module.css';

export type SettingsPanelProps = Omit<
  ComponentProps<typeof SettingsView>,
  'headerActions'
> & { onClose: () => void };

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Settings over the middle of the window: a panel, never a view, never in the stream.
 *  A fixed overlay rather than a top-layer `<dialog>`, so the legacy dialogs its hosted
 *  pages still open (a session's detail, a diff) stack above it instead of behind. */
export function SettingsPanel({ onClose, ...settings }: SettingsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // Focus moves in on open and back to where it was on close; the page behind stops scrolling.
  useLayoutEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panelRef.current?.focus({ preventScroll: true });
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = overflow;
      if (previous?.isConnected === true)
        previous.focus({ preventScroll: true });
    };
  }, []);

  // Escape with focus lost to the page still closes; keys from inside arrive through onKey.
  useEffect(() => {
    function onLooseKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (target !== document.body && target !== document.documentElement) {
        return;
      }
      event.preventDefault();
      closeRef.current();
    }
    document.addEventListener('keydown', onLooseKey);
    return () => document.removeEventListener('keydown', onLooseKey);
  }, []);

  // Escape closes unless a popup inside took it first; Tab stays inside. A legacy dialog
  // portalled out of the panel still bubbles here through React, and keeps its own keys.
  function onKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const panel = panelRef.current;
    const target = event.target;
    if (
      panel === null ||
      !(target instanceof Node) ||
      !panel.contains(target)
    ) {
      return;
    }
    if (
      event.key === 'Escape' &&
      !event.defaultPrevented &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      onClose();
      return;
    }
    trapTab(event, panel);
  }

  return (
    <div
      className={styles.scrim}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={onKey}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-testid="settings-panel"
        tabIndex={-1}
        className={styles.panel}
      >
        <SettingsView
          {...settings}
          headerActions={
            <Button
              variant="quiet"
              size="sm"
              aria-label="Close settings"
              icon={<X size={14} strokeWidth={1.8} aria-hidden />}
              onClick={onClose}
            />
          }
        />
      </div>
    </div>
  );
}

/** Keeps Tab and Shift+Tab cycling inside the panel. */
function trapTab(
  event: ReactKeyboardEvent<HTMLDivElement>,
  panel: HTMLDivElement
) {
  if (event.key !== 'Tab') return;
  const items = Array.from(
    panel.querySelectorAll<HTMLElement>(FOCUSABLE)
  ).filter((el) => el.closest('[hidden],[inert]') === null);
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
