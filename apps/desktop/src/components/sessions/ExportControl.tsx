import { Button, cx } from '@dispatch/ui';
import { Download, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { revealInFinder } from '../../lib/tauri';
import styles from './sessions.module.css';

type ExportState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; path: string }
  | { status: 'error'; message: string };

interface ExportControlProps {
  /** Button label while idle, e.g. "Export transcript" or "Export as Markdown". */
  label: string;
  /** Button label while the export is in flight. Defaults to "Exporting…". */
  savingLabel?: string;
  /** Runs the export and resolves to the saved file's path. */
  onExport: () => Promise<string>;
  /** `ghost` is a toolbar action (a quiet Button, no box until hover); `pill` the in-body
   * secondary button. */
  variant?: 'ghost' | 'pill';
}

/**
 * "Export … / Exporting… / Saved to <path> [Reveal in Finder] / <error>" control shared by
 * `SessionDetailModal` (exports one session's transcript) and `SessionsHubView` (exports
 * the aggregate spend report from its toolbar). Both call an async export fn and would
 * otherwise re-implement the same idle/saving/saved/error state machine around it, so this
 * owns that state. While saving, the button is disabled and reads `savingLabel` (no
 * spinner: it is a local file write). The saved path and any error appear in a polite live
 * region, truncated to one line with the full text in the title.
 */
export function ExportControl({
  label,
  savingLabel = 'Exporting…',
  onExport,
  variant = 'pill',
}: ExportControlProps) {
  const [state, setState] = useState<ExportState>({ status: 'idle' });

  async function handleExport() {
    setState({ status: 'saving' });
    try {
      const path = await onExport();
      setState({ status: 'saved', path });
    } catch (e) {
      setState({ status: 'error', message: String(e) });
    }
  }

  return (
    <div className={styles.export}>
      <span className={styles.exportStatus} aria-live="polite">
        {state.status === 'saved' && (
          <span className={styles.exportSaved} title={state.path}>
            Saved to {state.path}
          </span>
        )}
        {state.status === 'error' && (
          <span
            className={cx('toneText', styles.exportError)}
            data-tone="danger"
            title={state.message}
          >
            {state.message}
          </span>
        )}
      </span>
      {state.status === 'saved' && (
        <Button
          variant="quiet"
          size="sm"
          className={styles.exportReveal}
          icon={<FolderOpen size={14} strokeWidth={1.8} aria-hidden />}
          onClick={() => void revealInFinder(state.path)}
        >
          Reveal in Finder
        </Button>
      )}
      <Button
        variant={variant === 'ghost' ? 'quiet' : 'secondary'}
        size="sm"
        icon={<Download size={14} strokeWidth={1.8} aria-hidden />}
        busy={state.status === 'saving'}
        busyLabel={savingLabel}
        onClick={() => void handleExport()}
      >
        {label}
      </Button>
    </div>
  );
}
