import { useState } from 'react';

import { Button } from '../components/ui/Button';
import type { ProjectSummary } from '../lib/types';
import './GetStartedView.css';

interface GetStartedViewProps {
  /** Every project Relay has discovered, dispatch-enabled or not — this view's job is to
   * turn "not yet" into "now" for whichever one you came here about. */
  projects: ProjectSummary[];
  /** Ids of projects that already have a `.dispatch/` tracker, reusing `has_dispatch` the
   * same way the old global Tasks nav item did. */
  dispatchEnabledIds: Set<string>;
  /** Set when this view was opened by clicking a specific "no tracker" project in the
   * sidebar's project switcher, so that project's init command is shown first/highlighted. */
  focusProjectId: string | null;
}

/** One project's init instructions: the exact command to run in a terminal, plus a
 * copy-to-clipboard button — there's no Tauri command to run `dispatch init` on the app's
 * behalf (`ensure_dispatchd`/`has_dispatch` are the only two dispatch-related IPC calls), so
 * this is the honest "here's the one real action available" rather than a button that does
 * nothing. */
function InitProjectRow({
  project,
  highlighted,
}: {
  project: ProjectSummary;
  highlighted: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const command = `cd ${project.path} && dispatch init`;

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
    <div className={`get-started-view-row${highlighted ? ' highlighted' : ''}`}>
      <div className="get-started-view-row-main">
        <span className="get-started-view-row-name">{project.name}</span>
        <code className="get-started-view-row-command">{command}</code>
      </div>
      <Button variant="secondary" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy command'}
      </Button>
    </div>
  );
}

/**
 * First-run / no-tracker screen: shown at launch when no project has ever resolved as
 * dispatch-enabled, and when the sidebar's project switcher is used to click a project that
 * doesn't have a `.dispatch/` tracker yet. Lists every discovered project's init command
 * rather than a generic "get started" message, so the actual next step is always concrete.
 */
export function GetStartedView({
  projects,
  dispatchEnabledIds,
  focusProjectId,
}: GetStartedViewProps) {
  const uninitialized = projects.filter((p) => !dispatchEnabledIds.has(p.id));

  return (
    <div className="get-started-view">
      <h1 className="view-topbar-title">Get started with Dispatch</h1>
      <p className="get-started-view-intro">
        Dispatch tracks tasks as files inside a project&rsquo;s own{' '}
        <code>.dispatch/</code> directory. Initialize it in a project below,
        then reopen this window — its Board, Tasks, Runs, and Plans will appear
        in the sidebar.
      </p>

      {uninitialized.length === 0 ? (
        <p className="get-started-view-empty">
          Every discovered project already has a tracker — pick one from the
          sidebar to get to work.
        </p>
      ) : (
        <div className="get-started-view-list">
          {uninitialized.map((project) => (
            <InitProjectRow
              key={project.id}
              project={project}
              highlighted={project.id === focusProjectId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
