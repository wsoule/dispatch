import { Download, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { revealInFinder } from '../../lib/tauri';
import { Button } from '@/ui/button';

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
}

/**
 * "Export … / Exporting… / Saved to &lt;path&gt; [Reveal in Finder] / &lt;error&gt;" control
 * shared by `SessionDetailModal` (exports one session's transcript) and `ReportView` (exports
 * the current spend report) — both called the same async export fn and re-implemented the
 * same idle/saving/saved/error state machine around it. Owns that state itself so neither
 * caller has to.
 */
export function ExportControl({
  label,
  savingLabel = 'Exporting…',
  onExport,
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
    <div className="flex items-center gap-3">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void handleExport()}
        disabled={state.status === 'saving'}
      >
        <Download className="size-3.5" />
        {state.status === 'saving' ? savingLabel : label}
      </Button>
      {state.status === 'saved' && (
        <span className="text-muted-foreground inline-flex items-center gap-2 text-[13px]">
          Saved to {state.path}
          <button
            className="text-primary inline-flex items-center gap-1 text-[11px] hover:underline"
            onClick={() => void revealInFinder(state.path)}
          >
            <FolderOpen className="size-3" />
            Reveal in Finder
          </button>
        </span>
      )}
      {state.status === 'error' && (
        <span className="text-destructive text-[13px]">{state.message}</span>
      )}
    </div>
  );
}
