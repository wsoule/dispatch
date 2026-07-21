import { Check, Copy, Terminal } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/ui/button';

interface GetStartedViewProps {
  /** Absolute path of the one project this window is scoped to — shown here specifically
   * because `hasDispatch(projectPath)` came back `false`, i.e. it has no `.dispatch/`
   * tracker yet. */
  projectPath: string;
}

/**
 * First-run / no-tracker screen: shown whenever the app's single active project (see
 * `App.tsx`'s `currentProjectRoot()` resolution) doesn't have a `.dispatch/` tracker yet.
 * There's no Tauri command to run `dispatch init` on the app's behalf (`ensure_dispatchd`/
 * `has_dispatch` are the only two dispatch-related IPC calls), so this is the honest "here's
 * the one real action available" — copy the init command, run it in a terminal, reopen.
 */
export function GetStartedView({ projectPath }: GetStartedViewProps) {
  const [copied, setCopied] = useState(false);
  const command = `cd ${projectPath} && dispatch init`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the OS — the command is still shown as plain text,
      // so it's copyable by hand even if the button silently fails.
    }
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 pt-24 text-center">
      <div className="bg-accent text-accent-foreground flex size-10 items-center justify-center rounded-lg">
        <Terminal className="size-5" />
      </div>
      <h1 className="text-foreground text-[15px] font-medium">
        Get started with Dispatch
      </h1>
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        Dispatch tracks tasks as files inside a project&rsquo;s own{' '}
        <code className="bg-secondary rounded px-1 py-0.5 font-mono text-[12px]">
          .dispatch/
        </code>{' '}
        directory. Initialize it below, then reopen this window — its Board,
        Tasks, Runs, and Plans will take over.
      </p>

      <div className="border-border bg-card flex w-full items-center gap-2 rounded-lg border px-3 py-2.5">
        <code className="text-foreground min-w-0 flex-1 truncate text-left font-mono text-[12px]">
          {command}
        </code>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void copy()}
          className="shrink-0"
        >
          {copied ? (
            <>
              <Check className="size-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" /> Copy command
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
