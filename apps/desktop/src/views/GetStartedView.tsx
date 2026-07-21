import { useState } from 'react';

import { Button } from '../components/ui/Button';
import './GetStartedView.css';

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
    <div className="get-started-view">
      <h1 className="view-topbar-title">Get started with Dispatch</h1>
      <p className="get-started-view-intro">
        Dispatch tracks tasks as files inside a project&rsquo;s own{' '}
        <code>.dispatch/</code> directory. Initialize it below, then reopen this
        window — its Board, Tasks, Runs, and Plans will take over.
      </p>

      <div className="get-started-view-list">
        <div className="get-started-view-row highlighted">
          <div className="get-started-view-row-main">
            <code className="get-started-view-row-command">{command}</code>
          </div>
          <Button variant="secondary" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy command'}
          </Button>
        </div>
      </div>
    </div>
  );
}
