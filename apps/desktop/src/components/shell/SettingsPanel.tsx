import { X } from 'lucide-react';
import type { ComponentProps } from 'react';

import { SettingsView } from '../../views/SettingsView';
import { IconButton } from '@/ui/ai/icon-button';
import { Dialog, DialogContent } from '@/ui/dialog';

export type SettingsPanelProps = Omit<
  ComponentProps<typeof SettingsView>,
  'headerActions'
> & { onClose: () => void };

/** Settings over the middle of the window: a panel, never a view, never in the stream. */
export function SettingsPanel({ onClose, ...settings }: SettingsPanelProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-label="Settings"
        data-testid="settings-panel"
        showCloseButton={false}
        className="h-[min(780px,calc(100vh-112px))] w-[min(1080px,calc(100vw-96px))] overflow-hidden sm:max-w-none"
      >
        <SettingsView
          {...settings}
          headerActions={
            <IconButton label="Close settings" onClick={onClose}>
              <X aria-hidden />
            </IconButton>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
