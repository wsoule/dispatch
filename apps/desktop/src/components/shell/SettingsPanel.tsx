import { Button, useModalSurface } from '@dispatch/ui';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useRef } from 'react';

import { SettingsView } from '../../views/SettingsView';
import styles from './SettingsPanel.module.css';

export type SettingsPanelProps = Omit<
  ComponentProps<typeof SettingsView>,
  'headerActions'
> & { onClose: () => void };

/**
 * Settings over the middle of the window: a panel, never a view, never in the stream.
 *
 * Its behaviour is @dispatch/ui's useModalSurface, the one a modal SlideOver runs on: focus
 * moves in on open and back on close, Tab and Shift+Tab stay inside, the page behind stops
 * scrolling, and it is a modal layer of the package's overlay stack. A picker, popover,
 * tooltip or Dialog opened inside sits over it and takes Escape and outside presses first, one
 * layer per press (a press on the scrim with a picker open closes only the picker); an Escape
 * with focus fallen out of the panel closes it before any page listener sees the key; and
 * focus that drops to <body> (a focused row removed) comes back to the panel.
 *
 * It stays out of the browser's top layer (a fixed overlay at z-index 40, not a `<dialog>` or
 * `popover`) so the legacy Base UI dialogs its hosted Usage page still opens (a session's
 * detail, a diff: z-index 50, portalled to `<body>`) stack above it instead of behind. Those
 * dialogs set `aria-modal="true"` while open, which makes them modal surfaces outside the
 * stack: their Escape and presses stay theirs, and the keys React bubbles up to the panel from
 * their portals are left alone, since they come from outside its DOM.
 */
export function SettingsPanel({ onClose, ...settings }: SettingsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const surface = useModalSurface({ open: true, panelRef, scrimRef, onClose });

  return (
    <div ref={scrimRef} className={styles.scrim} {...surface.scrimProps}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        data-testid="settings-panel"
        tabIndex={-1}
        className={styles.panel}
        onKeyDown={surface.onKeyDown}
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
