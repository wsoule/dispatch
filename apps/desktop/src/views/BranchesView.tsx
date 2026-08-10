import type { GitStash } from '@dispatch/client';
import {
  AlertTriangle,
  GitBranch as GitBranchIcon,
  HelpCircle,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { BranchesPanel } from '../components/git/BranchesPanel';
import { CommitComposer } from '../components/git/CommitComposer';
import { CommitsPanel } from '../components/git/CommitsPanel';
import { DispatchAgentDialog } from '../components/git/DispatchAgentDialog';
import { FilesPanel } from '../components/git/FilesPanel';
import { GitKeymapDialog } from '../components/git/GitKeymapDialog';
import { GitRightPane } from '../components/git/GitRightPane';
import { StashesPanel } from '../components/git/StashesPanel';
import { StatusPanel } from '../components/git/StatusPanel';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { useGit } from '../hooks/useGit';
import { isTypingTarget } from '../hooks/useGlobalKeyboard';
import type { ImpactSubjectRef } from '../lib/appNav';
import type { BranchRowVM } from '../lib/gitBranchRows';
import {
  buildBranchRows,
  filterBranchRows,
  forceDeleteDefault,
} from '../lib/gitBranchRows';
import { fileRowsFromStatus } from '../lib/gitFileRows';
import type { GitFilter } from '../lib/gitHealth';
import { computeGitHealth } from '../lib/gitHealth';
import type {
  GitFileRow,
  GitPanelId,
  GitPanelSelection,
} from '../lib/gitPanels';
import {
  clampGitPanelSelection,
  deriveGitRightPane,
  focusGitPanel,
  GIT_PANEL_IDS,
  INITIAL_GIT_PANEL_SELECTION,
  moveGitSelection,
  reconcileGitPanelSelection,
} from '../lib/gitPanels';
import type { GitKeyCommand } from '../lib/keyboard';
import {
  isInteractiveControlTagName,
  resolveGitKeyCommand,
} from '../lib/keyboard';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Field, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/ui/input-group';
import { Kbd } from '@/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

interface BranchesViewProps {
  data: DispatchProjectData;
  onOpenRun: (runId: string) => void;
  /** Navigates to `ImpactView` with the selected file preselected — the
   *  Git file pane's "open in Impact" action. */
  onOpenImpact: (subject: ImpactSubjectRef) => void;
}

const PANEL_LABEL: Record<GitPanelId, string> = {
  status: 'Status',
  files: 'Files',
  branches: 'Branches',
  commits: 'Commits',
  stashes: 'Stashes',
};

const PANEL_DIGIT: Record<GitPanelId, string> = {
  status: '1',
  files: '2',
  branches: '3',
  commits: '4',
  stashes: '5',
};

/** What a pending confirmation dialog is about — every destructive action on this page
 * confirms here rather than firing straight from its button/keystroke. */
type PendingConfirm =
  | { kind: 'discard-file'; row: GitFileRow }
  | { kind: 'discard-run'; runId: string; branch: string }
  | { kind: 'delete-branch'; row: BranchRowVM }
  | { kind: 'drop-stash'; stash: GitStash };

/** The Git page: a lazygit-style multi-panel workspace plus agent-focused affordances plain
 * git doesn't have. Every keyboard shortcut also has a visible button/menu equivalent. */
export function BranchesView({
  data,
  onOpenRun,
  onOpenImpact,
}: BranchesViewProps) {
  const [panelState, setPanelState] = useState(INITIAL_GIT_PANEL_SELECTION);
  const [branchFilter, setBranchFilter] = useState<GitFilter>('all');
  const [textFilter, setTextFilter] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [stashMessage, setStashMessage] = useState('');
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyPaths, setBusyPaths] = useState<ReadonlySet<string>>(new Set());
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [reclaiming, setReclaiming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null
  );
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [keymapOpen, setKeymapOpen] = useState(false);
  const [dispatchDialog, setDispatchDialog] = useState<{
    title: string;
    prompt: string;
  } | null>(null);

  const filterInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Focuses the page's own keydown container on mount, so the keymap works the instant the
  // page opens rather than only after the user has clicked something inside it.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const {
    status,
    statusLoading,
    log,
    logLoading,
    stashes,
    stashesLoading,
    workingDiff,
    workingDiffLoading,
    commitDiff,
    commitDiffLoading,
    actions,
    refetchAll,
    fileRows,
    branchRowsFiltered,
    selectedFileRow,
    selectedBranchRow,
    selectedCommit,
    selectedStash,
    rightPane,
  } = useGitPage({ data, panelState, branchFilter, textFilter });

  // ---- selection clamping/reconciliation ----
  useEffect(() => {
    setPanelState((s) => clampGitPanelSelection(s, 'files', fileRows.length));
  }, [fileRows.length]);

  const prevBranchNames = useRef<string[]>([]);
  useEffect(() => {
    const names = branchRowsFiltered.map((r) => r.name);
    setPanelState((s) =>
      reconcileGitPanelSelection(
        s,
        'branches',
        prevBranchNames.current,
        names,
        (n) => n
      )
    );
    prevBranchNames.current = names;
  }, [branchRowsFiltered]);

  const prevCommitShas = useRef<string[]>([]);
  useEffect(() => {
    const shas = log.map((c) => c.sha);
    setPanelState((s) =>
      reconcileGitPanelSelection(
        s,
        'commits',
        prevCommitShas.current,
        shas,
        (sha) => sha
      )
    );
    prevCommitShas.current = shas;
  }, [log]);

  // Panels are short enough that j/k routinely moves the selection out of view,
  // where the highlight is invisible and keyboard nav reads as doing nothing.
  useEffect(() => {
    containerRef.current
      ?.querySelector(
        `[data-git-panel="${panelState.focused}"] [data-git-selected="true"]`
      )
      ?.scrollIntoView({ block: 'nearest' });
  }, [panelState]);

  // Identity is the stash's sha, not its positional `ref` (`stash@{0}`), which
  // shifts for other entries whenever one is pushed or dropped.
  const prevStashShas = useRef<string[]>([]);
  useEffect(() => {
    const shas = stashes.map((s) => s.sha);
    setPanelState((s) =>
      reconcileGitPanelSelection(
        s,
        'stashes',
        prevStashShas.current,
        shas,
        (sha) => sha
      )
    );
    prevStashShas.current = shas;
  }, [stashes]);

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  function listLength(panel: GitPanelId): number {
    if (panel === 'status') return 0;
    if (panel === 'files') return fileRows.length;
    if (panel === 'branches') return branchRowsFiltered.length;
    if (panel === 'commits') return log.length;
    return stashes.length;
  }

  async function runMutation(
    action: () => Promise<{ ok: boolean; stderr?: string }>
  ) {
    setBusy(true);
    setActionError(null);
    try {
      const result = await action();
      if (!result.ok) setActionError(result.stderr ?? 'That failed.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runFileMutation(
    path: string,
    action: () => Promise<{ ok: boolean; stderr?: string }>
  ) {
    setBusyPaths((prev) => new Set(prev).add(path));
    setActionError(null);
    try {
      const result = await action();
      if (!result.ok) setActionError(result.stderr ?? 'That failed.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }

  async function runBranchMutation(
    branch: string,
    action: () => Promise<{ ok: boolean; stderr?: string } | void>
  ) {
    setBusyBranch(branch);
    setActionError(null);
    try {
      const result = await action();
      if (result !== undefined && typeof result === 'object' && !result.ok) {
        setActionError(result.stderr ?? 'That failed.');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyBranch(null);
    }
  }

  function toggleStage(row: GitFileRow) {
    void runFileMutation(row.path, () =>
      row.section === 'staged'
        ? actions.unstage([row.path])
        : actions.stage([row.path])
    );
  }

  function stageAll() {
    const paths = fileRows
      .filter((r) => r.section !== 'staged')
      .map((r) => r.path);
    if (paths.length === 0) return;
    void runMutation(() => actions.stage(paths));
  }

  function focusComposer() {
    document.getElementById('git-commit-message')?.focus();
  }

  async function submitCommit() {
    if (commitMessage.trim() === '') return;
    await runMutation(async () => {
      const result = await actions.commit(commitMessage.trim(), { amend });
      if (result.ok) {
        setCommitMessage('');
        setAmend(false);
      }
      return result;
    });
  }

  async function generateMessage() {
    setGenerating(true);
    setActionError(null);
    try {
      const { message } = await actions.generateCommitMessage();
      setCommitMessage(message);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  function openDispatchForBranch(branch: string) {
    setDispatchDialog({
      title: `Work on ${branch}`,
      prompt: `Continue the work on branch \`${branch}\`. Review what's already there before making changes.`,
    });
  }

  function openDispatchForConflicts() {
    const files = status?.conflicted ?? [];
    setDispatchDialog({
      title: 'Resolve merge conflicts',
      prompt: `Resolve the merge conflicts in the working tree${
        files.length > 0 ? `:\n${files.map((f) => `- ${f}`).join('\n')}` : '.'
      }`,
    });
  }

  function openDispatchGeneral() {
    setDispatchDialog({ title: '', prompt: '' });
  }

  function requestDeleteBranch(row: BranchRowVM) {
    setPendingConfirm({ kind: 'delete-branch', row });
  }

  function requestDiscardFile(row: GitFileRow) {
    if (row.section === 'staged') return;
    setPendingConfirm({ kind: 'discard-file', row });
  }

  function requestDropStash(stash: GitStash) {
    setPendingConfirm({ kind: 'drop-stash', stash });
  }

  function requestDiscardRun(runId: string, branch: string) {
    setPendingConfirm({ kind: 'discard-run', runId, branch });
  }

  // The confirm dialog unmounts outright rather than animating closed, so Radix never
  // restores focus — without this the page's own 1-5/j/k shortcuts go dead.
  function closeConfirm() {
    setPendingConfirm(null);
    requestAnimationFrame(() => containerRef.current?.focus());
  }

  async function confirmPending(forceBranchDelete: boolean) {
    const pending = pendingConfirm;
    closeConfirm();
    if (pending === null) return;
    if (pending.kind === 'discard-file') {
      await runFileMutation(pending.row.path, () =>
        actions.discard([pending.row.path])
      );
    } else if (pending.kind === 'delete-branch') {
      const branch = pending.row.name;
      // A dispatch worktree branch must go through the dispatch endpoint — plain `git
      // branch -d/-D` refuses outright while a linked worktree still exists.
      await runBranchMutation(
        branch,
        pending.row.worktree !== undefined
          ? () => data.handleDeleteBranch(branch, { force: forceBranchDelete })
          : () => actions.deleteBranch(branch, { force: forceBranchDelete })
      );
    } else if (pending.kind === 'drop-stash') {
      await runMutation(() => actions.stashDrop(pending.stash.index));
    } else {
      await runBranchMutation(pending.branch, () =>
        data.handleReview(pending.runId, 'discard')
      );
    }
  }

  // Both bulk actions read their set from the same health pass the summary
  // renders its counts from, so the button's number is the set it acts on.
  const health = computeGitHealth(data.branches);

  async function deleteAllMergedOrphans() {
    for (const entry of health.mergedOrphans) {
      await runBranchMutation(entry.branch, () =>
        data.handleDeleteBranch(entry.branch)
      );
    }
  }

  async function reclaimMerged() {
    setReclaiming(true);
    try {
      for (const entry of health.reclaimable) {
        await data.handleFreeBranchDisk(entry.branch);
      }
    } finally {
      setReclaiming(false);
    }
  }

  function handleGitCommand(cmd: GitKeyCommand) {
    if (cmd.kind === 'focus-panel') {
      setPanelState((s) => focusGitPanel(s, cmd.panel));
      return;
    }
    if (cmd.kind === 'move') {
      setPanelState((s) =>
        moveGitSelection(s, listLength(s.focused), cmd.delta)
      );
      return;
    }
    if (cmd.kind === 'toggle-stage') {
      if (panelState.focused !== 'files') return;
      const row = fileRows[panelState.index.files];
      if (row !== undefined) toggleStage(row);
      return;
    }
    if (cmd.kind === 'stage-all') {
      stageAll();
      return;
    }
    if (cmd.kind === 'commit') {
      focusComposer();
      return;
    }
    if (cmd.kind === 'amend') {
      setAmend(true);
      focusComposer();
      return;
    }
    if (cmd.kind === 'discard') {
      if (panelState.focused !== 'files') return;
      const row = fileRows[panelState.index.files];
      if (row !== undefined) requestDiscardFile(row);
      return;
    }
    if (cmd.kind === 'new-branch') {
      setNewBranchOpen(true);
      return;
    }
    if (cmd.kind === 'checkout') {
      if (panelState.focused !== 'branches') return;
      const row = branchRowsFiltered[panelState.index.branches];
      if (row !== undefined && !row.isCurrent) {
        void runMutation(() => actions.checkout(row.name));
      }
      return;
    }
    if (cmd.kind === 'stash') {
      void runMutation(async () => {
        const result = await actions.stashPush(
          stashMessage.trim() || undefined
        );
        if (result.ok) setStashMessage('');
        return result;
      });
      return;
    }
    if (cmd.kind === 'stash-pop') {
      if (panelState.focused !== 'stashes') return;
      const stash = stashes[panelState.index.stashes];
      if (stash !== undefined)
        void runMutation(() => actions.stashPop(stash.index));
      return;
    }
    if (cmd.kind === 'fetch') {
      void runMutation(() => actions.fetch());
      return;
    }
    if (cmd.kind === 'pull') {
      void runMutation(() => actions.pull());
      return;
    }
    if (cmd.kind === 'push') {
      void runMutation(() => actions.push());
      return;
    }
    if (cmd.kind === 'filter') {
      filterInputRef.current?.focus();
      return;
    }
    if (cmd.kind === 'help') {
      setKeymapOpen(true);
    }
  }

  function onRootKeyDown(e: React.KeyboardEvent) {
    if (
      keymapOpen ||
      dispatchDialog !== null ||
      newBranchOpen ||
      pendingConfirm !== null
    ) {
      return;
    }
    // A keydown landing directly on a button/input belongs to that control's own Space/
    // Enter activation, not to a Git page command.
    if (
      (e.key === ' ' || e.key === 'Enter') &&
      e.target instanceof HTMLElement &&
      isInteractiveControlTagName(e.target.tagName)
    ) {
      return;
    }
    const cmd = resolveGitKeyCommand(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
      { isTyping: isTypingTarget(e.target) }
    );
    if (cmd === null) return;
    e.preventDefault();
    handleGitCommand(cmd);
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col gap-3 outline-none"
      onKeyDown={onRootKeyDown}
    >
      <div className="flex items-center justify-between gap-3">
        <h1 className="view-topbar-title">Git</h1>
        <div className="flex min-w-0 flex-1 items-center px-2">
          {/* The `pl-2` InputGroup pushes onto its input is variant-prefixed, so it out-ranks
              a plain `px-0` on the control and has to be overridden in the same form. */}
          <InputGroup className="h-7 max-w-64 gap-2 px-2 has-[>[data-align=inline-start]]:[&>input]:pl-0">
            <InputGroupAddon className="p-0">
              <Search className="text-muted-foreground size-3.5 shrink-0" />
            </InputGroupAddon>
            <InputGroupInput
              ref={filterInputRef}
              value={textFilter}
              onChange={(e) => setTextFilter(e.target.value)}
              placeholder="Filter files and branches (/)"
              className="h-auto px-0 text-[12px] md:text-[12px]"
            />
          </InputGroup>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            onClick={openDispatchGeneral}
          >
            <GitBranchIcon className="size-3.5" />
            Dispatch agent
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Keyboard shortcuts (?)"
                onClick={() => setKeymapOpen(true)}
              >
                <HelpCircle className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Keyboard shortcuts (?)</TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-[12px]"
            onClick={() => {
              void data.handleRefreshBranches();
              void refetchAll();
            }}
          >
            <RefreshCw
              className={cn(
                'size-3.5',
                (data.branchesLoading || statusLoading) && 'animate-spin'
              )}
            />
            Refresh
          </Button>
        </div>
      </div>

      {actionError !== null && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]">
          <AlertTriangle className="mt-px size-4 shrink-0" />
          <span className="min-w-0 flex-1">{actionError}</span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[19rem_minmax(0,1fr)] gap-3 overflow-hidden">
        <div className="border-border flex min-h-0 flex-col overflow-hidden rounded-md border">
          {GIT_PANEL_IDS.map((panel) => (
            <div
              key={panel}
              className={cn(
                'border-border flex min-h-0 flex-col border-b last:border-b-0',
                // Weighted so the longest list (branches) gets the most room, with a floor
                // under each so no panel collapses to a header at small window sizes.
                panel === 'status'
                  ? 'flex-none'
                  : panel === 'branches'
                    ? 'min-h-[9rem] flex-[2]'
                    : panel === 'stashes'
                      ? 'min-h-[5.5rem] flex-[0.8]'
                      : 'min-h-[5.5rem] flex-[1.2]'
              )}
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPanelState((s) => focusGitPanel(s, panel))}
                className={cn(
                  // The header has never lit up on hover, so ghost's own hover fill is pinned
                  // back to whichever resting fill this panel is wearing.
                  'bg-muted/40 hover:bg-muted/40 h-auto justify-start gap-2 rounded-none px-3 py-1.5 text-left text-[10.5px] font-medium tracking-wide uppercase',
                  panelState.focused === panel &&
                    'bg-accent/60 hover:bg-accent/60'
                )}
              >
                <Kbd className="text-muted-foreground h-auto min-w-0 bg-transparent px-0 font-mono text-[length:inherit] normal-case">
                  {PANEL_DIGIT[panel]}
                </Kbd>
                {PANEL_LABEL[panel]}
                {panel !== 'status' && (
                  <span
                    data-git-panel-count={panel}
                    className="text-muted-foreground font-mono normal-case"
                  >
                    {listLength(panel)}
                  </span>
                )}
              </Button>
              <div
                data-git-panel={panel}
                className="scroll-affordance min-h-0 flex-1 overflow-y-auto"
              >
                {panel === 'status' && (
                  <StatusPanel
                    status={status}
                    loading={statusLoading}
                    busy={busy}
                    onFetch={() => void runMutation(() => actions.fetch())}
                    onPull={() => void runMutation(() => actions.pull())}
                    onPush={() => void runMutation(() => actions.push())}
                    onResolveConflicts={openDispatchForConflicts}
                  />
                )}
                {panel === 'files' && (
                  <>
                    <div className="flex justify-end px-2 pt-1.5">
                      <Button variant="ghost" size="xs" onClick={stageAll}>
                        Stage all
                      </Button>
                    </div>
                    <FilesPanel
                      rows={fileRows}
                      selectedIndex={panelState.index.files}
                      busyPaths={busyPaths}
                      onSelectIndex={(index) =>
                        setPanelState((s) => ({
                          ...focusGitPanel(s, 'files'),
                          index: { ...s.index, files: index },
                        }))
                      }
                      onToggleStage={toggleStage}
                    />
                  </>
                )}
                {panel === 'branches' && (
                  <>
                    <div className="flex justify-end px-2 pt-1.5">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setNewBranchOpen(true)}
                      >
                        <Plus className="size-3" />
                        New branch
                      </Button>
                    </div>
                    <BranchesPanel
                      rows={branchRowsFiltered}
                      worktrees={data.branches}
                      selectedIndex={panelState.index.branches}
                      filter={branchFilter}
                      onFilterChange={(next) =>
                        setBranchFilter(next === branchFilter ? 'all' : next)
                      }
                      reclaiming={reclaiming}
                      onReclaimMerged={() => void reclaimMerged()}
                      onDeleteAllMergedOrphans={() =>
                        void deleteAllMergedOrphans()
                      }
                      onSelectIndex={(index) =>
                        setPanelState((s) => ({
                          ...focusGitPanel(s, 'branches'),
                          index: { ...s.index, branches: index },
                        }))
                      }
                      onOpenRun={onOpenRun}
                      onDispatchAgent={openDispatchForBranch}
                    />
                  </>
                )}
                {panel === 'commits' && (
                  <CommitsPanel
                    commits={log}
                    loading={logLoading}
                    selectedIndex={panelState.index.commits}
                    onSelectIndex={(index) =>
                      setPanelState((s) => ({
                        ...focusGitPanel(s, 'commits'),
                        index: { ...s.index, commits: index },
                      }))
                    }
                  />
                )}
                {panel === 'stashes' && (
                  <>
                    <div className="flex items-center gap-1.5 px-2 pt-1.5">
                      <Input
                        value={stashMessage}
                        onChange={(e) => setStashMessage(e.target.value)}
                        placeholder="Stash message (optional)"
                        className="h-7 flex-1 text-[11px]"
                      />
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={busy}
                        onClick={() =>
                          void runMutation(async () => {
                            const result = await actions.stashPush(
                              stashMessage.trim() || undefined
                            );
                            if (result.ok) setStashMessage('');
                            return result;
                          })
                        }
                      >
                        Stash
                      </Button>
                    </div>
                    <StashesPanel
                      stashes={stashes}
                      loading={stashesLoading}
                      busy={busy}
                      selectedIndex={panelState.index.stashes}
                      onSelectIndex={(index) =>
                        setPanelState((s) => ({
                          ...focusGitPanel(s, 'stashes'),
                          index: { ...s.index, stashes: index },
                        }))
                      }
                      onPop={(index) =>
                        void runMutation(() => actions.stashPop(index))
                      }
                      onRequestDrop={requestDropStash}
                    />
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="border-border min-h-0 overflow-hidden rounded-md border">
          <GitRightPane
            pane={rightPane}
            status={status}
            selectedFileRow={selectedFileRow}
            workingDiff={workingDiff}
            workingDiffLoading={workingDiffLoading}
            onToggleStageSelectedFile={() => {
              if (selectedFileRow !== undefined) toggleStage(selectedFileRow);
            }}
            onRequestDiscardFile={requestDiscardFile}
            client={data.client}
            onOpenImpact={onOpenImpact}
            selectedCommit={selectedCommit}
            commitDiff={commitDiff}
            commitDiffLoading={commitDiffLoading}
            onCherryPick={(sha) =>
              void runMutation(() => actions.cherryPick(sha))
            }
            onRevert={(sha) => void runMutation(() => actions.revert(sha))}
            selectedBranch={selectedBranchRow}
            onCheckout={(name) =>
              void runMutation(() => actions.checkout(name))
            }
            onRequestDeleteBranch={requestDeleteBranch}
            onFreeDisk={(branch) =>
              void runBranchMutation(branch, () =>
                data.handleFreeBranchDisk(branch)
              )
            }
            onDiscardRun={(runId) => {
              if (selectedBranchRow !== undefined) {
                requestDiscardRun(runId, selectedBranchRow.name);
              }
            }}
            onOpenRun={onOpenRun}
            onDispatchAgent={openDispatchForBranch}
            selectedStash={selectedStash}
            onPopStash={(index) =>
              void runMutation(() => actions.stashPop(index))
            }
            onRequestDropStash={requestDropStash}
            busy={busy || busyBranch !== null}
          />
        </div>
      </div>

      <CommitComposer
        message={commitMessage}
        onMessageChange={setCommitMessage}
        stagedCount={fileRows.filter((r) => r.section === 'staged').length}
        amend={amend}
        onAmendChange={setAmend}
        busy={busy}
        generating={generating}
        onGenerate={() => void generateMessage()}
        onCommit={() => void submitCommit()}
      />

      <NewBranchDialog
        open={newBranchOpen}
        onClose={() => setNewBranchOpen(false)}
        currentBranch={status?.branch ?? undefined}
        onCreate={async (name, from) => {
          await runMutation(() => actions.createBranch(name, from));
          setNewBranchOpen(false);
        }}
      />

      <DispatchAgentDialog
        open={dispatchDialog !== null}
        onClose={() => setDispatchDialog(null)}
        defaultTitle={dispatchDialog?.title ?? ''}
        defaultPrompt={dispatchDialog?.prompt ?? ''}
        client={data.client}
        onDispatch={(taskId) => data.handleDispatch(taskId)}
      />

      <GitKeymapDialog open={keymapOpen} onClose={() => setKeymapOpen(false)} />

      <ConfirmDialog
        key={pendingConfirmKey(pendingConfirm)}
        pending={pendingConfirm}
        onCancel={closeConfirm}
        onConfirm={confirmPending}
      />
    </div>
  );
}

// Remounts `ConfirmDialog` fresh for every distinct confirmation, so its `force` checkbox's
// lazy initial state is always computed from the *current* `pending`, never one render behind.
function pendingConfirmKey(pending: PendingConfirm | null): string {
  if (pending === null) return 'none';
  if (pending.kind === 'discard-file')
    return `discard-file:${pending.row.section}:${pending.row.path}`;
  if (pending.kind === 'discard-run') return `discard-run:${pending.runId}`;
  if (pending.kind === 'delete-branch')
    return `delete-branch:${pending.row.name}`;
  return `drop-stash:${pending.stash.sha}`;
}

// Pulls together `useGit`'s data plus the local file/branch row derivations that need it, so
// BranchesView's body reads top-to-bottom instead of interleaving the two.
function useGitPage({
  data,
  panelState,
  branchFilter,
  textFilter,
}: {
  data: DispatchProjectData;
  panelState: GitPanelSelection;
  branchFilter: GitFilter;
  textFilter: string;
}) {
  // Status/branches, independent of selection. `logRef: undefined` skips the log query
  // entirely — `scoped` below fetches the one the Commits panel actually needs.
  const base = useGit({
    client: data.client,
    port: data.port,
    logRef: undefined,
    workingDiffTarget: null,
    commitSha: null,
  });

  const fileRowsAll = useMemo(() => {
    if (base.status === undefined) return [];
    return fileRowsFromStatus(
      base.status.staged,
      base.status.unstaged,
      base.status.untracked,
      base.status.conflicted
    );
  }, [base.status]);

  const fileRows = useMemo(() => {
    const needle = textFilter.trim().toLowerCase();
    if (needle === '') return fileRowsAll;
    return fileRowsAll.filter((r) => r.path.toLowerCase().includes(needle));
  }, [fileRowsAll, textFilter]);

  const branchRowsAll = useMemo(
    () => buildBranchRows(base.branches, data.branches),
    [base.branches, data.branches]
  );

  const branchRowsFilteredByBucket = useMemo(
    () => filterBranchRows(branchRowsAll, data.branches, branchFilter),
    [branchRowsAll, data.branches, branchFilter]
  );

  const branchRowsFiltered = useMemo(() => {
    const needle = textFilter.trim().toLowerCase();
    if (needle === '') return branchRowsFilteredByBucket;
    return branchRowsFilteredByBucket.filter((r) =>
      r.name.toLowerCase().includes(needle)
    );
  }, [branchRowsFilteredByBucket, textFilter]);

  const selectedFileRow = fileRows[panelState.index.files];
  const selectedBranchRow = branchRowsFiltered[panelState.index.branches];

  const logRef = selectedBranchRow?.name ?? null;
  const workingDiffTarget =
    selectedFileRow !== undefined && selectedFileRow.section !== 'untracked'
      ? {
          staged: selectedFileRow.section === 'staged',
          path: selectedFileRow.path,
        }
      : null;

  // A second `useGit` call scoped to what's selected — its `log` is the one and only list
  // the Commits panel renders.
  const scoped = useGit({
    client: data.client,
    port: data.port,
    logRef,
    workingDiffTarget,
    commitSha: null,
  });

  // Sourced from `scoped.log`, not any other log fetch, so the sha requested below always
  // matches the commit the panel is displaying at that index.
  const commitSha =
    panelState.focused === 'commits'
      ? (scoped.log[panelState.index.commits]?.sha ?? null)
      : null;

  // A third call for just the commit diff — `logRef: undefined` skips fetching a log it
  // doesn't need, since `scoped.log` above already is one.
  const commitScoped = useGit({
    client: data.client,
    port: data.port,
    logRef: undefined,
    workingDiffTarget: null,
    commitSha,
  });

  const selectedCommit = scoped.log[panelState.index.commits];
  const selectedStash = scoped.stashes[panelState.index.stashes];

  const rightPane = deriveGitRightPane(panelState, {
    files: fileRows,
    branches: branchRowsFiltered.map((r) => r.name),
    commits: scoped.log.map((c) => c.sha),
    stashes: scoped.stashes.map((s) => s.index),
  });

  return {
    status: base.status,
    statusLoading: base.statusLoading,
    log: scoped.log,
    logLoading: scoped.logLoading,
    stashes: scoped.stashes,
    stashesLoading: scoped.stashesLoading,
    workingDiff: scoped.workingDiff,
    workingDiffLoading: scoped.workingDiffLoading,
    commitDiff: commitScoped.commitDiff,
    commitDiffLoading: commitScoped.commitDiffLoading,
    actions: base.actions,
    refetchAll: base.refetchAll,
    fileRows,
    branchRowsFiltered,
    selectedFileRow,
    selectedBranchRow,
    selectedCommit,
    selectedStash,
    rightPane,
  };
}

function NewBranchDialog({
  open,
  onClose,
  currentBranch,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  currentBranch: string | undefined;
  onCreate: (name: string, from?: string) => Promise<void>;
}) {
  const [name, setName] = useState('');

  useEffect(() => {
    if (open) setName('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New branch</DialogTitle>
          <DialogDescription>
            {currentBranch !== undefined
              ? `Branches from ${currentBranch}.`
              : 'Branches from the current HEAD.'}
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="branch-name"
          autoFocus
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={name.trim() === ''}
            onClick={() => void onCreate(name.trim())}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// A worktree branch's `ahead` is base-relative (dispatch's own concept); a plain branch has
// no base, so its git-level `ahead` (upstream-relative) is the closest count available.
function deleteBranchCommitCount(row: BranchRowVM): number {
  return row.worktree?.ahead ?? row.ahead;
}

function ConfirmDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingConfirm | null;
  onCancel: () => void;
  onConfirm: (forceBranchDelete: boolean) => Promise<void>;
}) {
  // Lazy initializer, no effect: the parent remounts this component per distinct `pending`
  // (see `pendingConfirmKey`), so this runs fresh instead of showing a stale value for a frame.
  const [force, setForce] = useState(
    () => pending?.kind === 'delete-branch' && forceDeleteDefault(pending.row)
  );

  if (pending === null) return null;

  const title =
    pending.kind === 'discard-file'
      ? 'Discard changes?'
      : pending.kind === 'discard-run'
        ? 'Discard this run?'
        : pending.kind === 'delete-branch'
          ? 'Delete branch?'
          : 'Drop stash?';

  const description =
    pending.kind === 'discard-file' ? (
      <>
        <span className="font-mono">{pending.row.path}</span> — this reverts the
        file to its last committed state and cannot be undone.
      </>
    ) : pending.kind === 'discard-run' ? (
      <>
        Removes the worktree and branch{' '}
        <span className="font-mono">{pending.branch}</span> and reopens its
        task. The work is not recoverable once the branch is gone.
      </>
    ) : pending.kind === 'delete-branch' ? (
      <div className="flex flex-col gap-2">
        <span className="font-mono">{pending.row.name}</span>
        <span>
          {deleteBranchCommitCount(pending.row)} commit
          {deleteBranchCommitCount(pending.row) === 1 ? '' : 's'}{' '}
          {pending.row.worktree !== undefined
            ? 'that never landed on its base'
            : 'not reachable from any other branch you have'}
          .
        </span>
        <Field orientation="horizontal" className="w-fit gap-1.5">
          <Checkbox
            id="git-force-delete-branch"
            className="size-3.5"
            checked={force}
            onCheckedChange={(checked) => setForce(checked === true)}
          />
          <FieldLabel
            htmlFor="git-force-delete-branch"
            className="text-[12px] font-normal"
          >
            Force delete (destroys them permanently)
          </FieldLabel>
        </Field>
      </div>
    ) : (
      <>
        <span className="font-mono">{pending.stash.message}</span> — dropping a
        stash discards it permanently.
      </>
    );

  // `AlertDialogDescription` renders a `<p>`, so `asChild` swaps in the `<div>` the
  // delete-branch copy needs — a block layout inside a paragraph is invalid markup.
  return (
    <AlertDialog open onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* No `onClick` — Cancel is a Radix Close, so dismissal already runs through
              `onOpenChange` above; handling both would call `onCancel` twice. */}
          <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => void onConfirm(force)}
          >
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
