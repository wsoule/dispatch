import type { Update } from '@tauri-apps/plugin-updater';
import { Download, Loader2, X } from 'lucide-react';
import { useState } from 'react';

import { installUpdateAndRelaunch } from '@/lib/updater';
import { Button } from '@/ui/button';

interface UpdateBannerProps {
  /** The pending update discovered by `checkForUpdate()` at launch. */
  update: Update;
  /** Dismiss the banner for this session (the next launch re-checks). */
  onDismiss: () => void;
}

/**
 * A slim, dismissible banner announcing that a newer signed release is
 * available. Clicking "Restart to update" runs the standard
 * tauri-plugin-updater flow (download + install, then relaunch via
 * tauri-plugin-process) — see `installUpdateAndRelaunch`. Kept intentionally
 * minimal and styled with the app's own tokens so it reads as part of the
 * shell, not a system dialog.
 */
export function UpdateBanner({ update, onDismiss }: UpdateBannerProps) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRestart = async () => {
    setInstalling(true);
    setError(null);
    try {
      // Resolves by relaunching the app, so nothing after this normally runs —
      // the catch only fires if the download/install itself failed.
      await installUpdateAndRelaunch(update);
    } catch (err) {
      setInstalling(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="border-border bg-secondary/60 flex items-center gap-3 border-b px-4 py-2 text-[13px]">
      <Download className="text-muted-foreground size-4 shrink-0" />
      <span className="text-foreground min-w-0 flex-1 truncate">
        Dispatch {update.version} available
        {error !== null && (
          <span className="text-destructive ml-2">
            — update failed: {error}
          </span>
        )}
      </span>
      <Button size="xs" onClick={() => void onRestart()} disabled={installing}>
        {installing ? (
          <>
            <Loader2 className="size-3 animate-spin" />
            Updating…
          </>
        ) : (
          'Restart to update'
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDismiss}
        disabled={installing}
        aria-label="Dismiss update notification"
      >
        <X />
      </Button>
    </div>
  );
}
