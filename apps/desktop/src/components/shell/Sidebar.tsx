import type { DraftRecord } from '@dispatch/client';
import {
  BookText,
  Box,
  Brain,
  CircleDot,
  Crosshair,
  FileCode2,
  GitBranch,
  GitMerge,
  House,
  Inbox,
  Layers,
  LayoutDashboard,
  Link2,
  ListChecks,
  MessagesSquare,
  NotebookPen,
  Play,
  Radar,
  Search,
  Shield,
  Sparkles,
  SquarePen,
  TerminalSquare,
  Waypoints,
  Workflow,
} from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { GlobalView, ProjectView } from '../../lib/appNav';
import type { PaletteView } from '../../lib/paletteEntries';
import { isTauri } from '../../lib/tauri';
import { DraftTrayPopover } from './DraftTray';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import {
  SidebarNav,
  type SidebarNavItem,
  type SidebarNavSection,
} from '@/ui/ai/sidebar-nav';
import { Sidebar as SidebarRoot } from '@/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

type ViewRow<Id> = { id: Id; label: string; icon: typeof Inbox };

/**
 * Work: what you are building, in the order it moves — where things stand, the
 * tasks themselves, the plans behind them, and the notes that have not become
 * either yet. Inbox and Threads are not here; they lead the fixed top group above.
 *
 * Labels are the plain word for what the page does. "Control room" and "Brain
 * dump" were names this team knew and nobody else could parse, and a first run
 * met nine different nouns for "your work" before it had any.
 */
const WORK_VIEWS: ViewRow<ProjectView>[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  // Board, list and milestones are header view tabs inside Tasks now, not rail rows.
  { id: 'board', label: 'Tasks', icon: ListChecks },
  // The hierarchy above the tasks: initiatives, projects, milestones.
  { id: 'projects', label: 'Projects', icon: Box },
  // Every container's work in flight at once, as live Flight Plan bands.
  { id: 'live', label: 'Live', icon: Workflow },
  { id: 'plans', label: 'Plans', icon: NotebookPen },
  { id: 'brain-dump', label: 'Notes', icon: Brain },
];

/** Code: the repository itself, rather than the work being done to it — its
 *  history, its files, a shell on it, the running app, and what a change would
 *  touch. */
/** Code rows that act on the host machine as the person running the daemon —
 *  a shell, and a browser carrying their cookies. The daemon holds both to the
 *  operator tier, so a teammate below it is not shown doors that only 403. */
const HOST_VIEWS: ReadonlySet<ProjectView> = new Set(['terminals', 'design']);

const CODE_VIEWS: ViewRow<ProjectView>[] = [
  { id: 'branches', label: 'Git', icon: GitBranch },
  { id: 'files', label: 'Files', icon: FileCode2 },
  { id: 'docs', label: 'Docs', icon: BookText },
  { id: 'terminals', label: 'Terminals', icon: TerminalSquare },
  { id: 'design', label: 'Design', icon: Crosshair },
  // Blast radius of a file, run, or task's declared writes.
  { id: 'impact', label: 'Impact', icon: Waypoints },
];

/** Runs: agents at work and what they are landing. `landing` is a project view
 *  and the other two are global ones — they sit together because that is how
 *  someone thinks about them, and `handleSelect` routes each by its id. "Merge
 *  queue" says what the page is; "Landing" read as an airport. */
const RUN_PROJECT_VIEWS: ViewRow<ProjectView>[] = [
  // Every open PR with its gates plus what already landed.
  { id: 'landing', label: 'Merge queue', icon: GitMerge },
];

const RUN_GLOBAL_VIEWS: ViewRow<GlobalView>[] = [
  { id: 'sessions', label: 'Sessions', icon: Play },
  { id: 'all-agents', label: 'All agents', icon: Radar },
];

/** Every project destination in rail order — Home, Inbox and Threads first, then
 * the sections as they are rendered — which is also the ⌘N order: ⌘1 is the first
 * row, and so on. App indexes into this for `goto-N`. */
export const PROJECT_NAV_VIEWS: PaletteView[] = [
  { id: 'cockpit', label: 'Home' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'threads', label: 'Threads' },
  ...[...WORK_VIEWS, ...RUN_PROJECT_VIEWS, ...CODE_VIEWS].map(
    ({ id, label }) => ({ id, label })
  ),
];

export const PROJECT_VIEW_ORDER: ProjectView[] = PROJECT_NAV_VIEWS.map(
  (v) => v.id
);

// Persists whether the rail is hidden, so the choice survives a reload.
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'dispatch:sidebar-collapsed';

function readStoredSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
}

/**
 * The hidden-rail preference, kept here beside the rail it describes but applied by App's
 * `SidebarProvider`, which owns the open/closed state the whole shell reads.
 */
export function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(readStoredSidebarCollapsed);
  useEffect(() => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? '1' : '0'
    );
  }, [collapsed]);
  // A plain setter, not React's raw one: `SidebarProvider` always hands back a resolved
  // open/closed value, so the updater overload is not part of this hook's contract.
  const set = useCallback((next: boolean) => setCollapsed(next), []);
  return [collapsed, set];
}

/** The collapsible sections' ids — also the keys in the persisted map. */
export type SidebarSectionId =
  | 'favorites'
  | 'workspace'
  | 'code'
  | 'fleet'
  | 'live'
  | 'try';

/** A starred view or task, resolved to the label its rail row shows. */
interface SidebarFavorite {
  kind: 'view' | 'task';
  id: string;
  label: string;
}

// Row-id prefixes for the rows built from the saved-view and favourite stores.
const VIEW_ROW = 'view-';
const FAV_VIEW_ROW = 'fav-view-';
const FAV_TASK_ROW = 'fav-task-';

// Stable empty defaults so the props stay optional without a fresh array per render.
const NO_VIEWS: { id: string; name: string }[] = [];
const NO_FAVORITES: SidebarFavorite[] = [];

// Which sections the user has folded, as a JSON map. The Try block is the one that folds
// itself: it is open on a fresh install and collapses the first time one of its rows is
// used, since by then it has done its job.
const SIDEBAR_SECTIONS_STORAGE_KEY = 'dispatch:sidebar-sections';

type SectionState = Partial<Record<SidebarSectionId, boolean>>;

function readStoredSections(): SectionState {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as SectionState)
      : {};
  } catch {
    return {};
  }
}

/** The persisted collapsed/expanded state of each rail section. */
function useSidebarSections(): {
  collapsed: (id: SidebarSectionId) => boolean;
  toggle: (id: SidebarSectionId) => void;
  collapse: (id: SidebarSectionId) => void;
} {
  const [state, setState] = useState<SectionState>(readStoredSections);
  useEffect(() => {
    window.localStorage.setItem(
      SIDEBAR_SECTIONS_STORAGE_KEY,
      JSON.stringify(state)
    );
  }, [state]);
  const collapsed = useCallback(
    (id: SidebarSectionId) => state[id] === true,
    [state]
  );
  const toggle = useCallback(
    (id: SidebarSectionId) =>
      setState((prev) => ({ ...prev, [id]: prev[id] !== true })),
    []
  );
  const collapse = useCallback(
    (id: SidebarSectionId) => setState((prev) => ({ ...prev, [id]: true })),
    []
  );
  return useMemo(
    () => ({ collapsed, toggle, collapse }),
    [collapsed, toggle, collapse]
  );
}

/** True on the packaged macOS app, where the window uses `titleBarStyle: "Overlay"` and the
 * native traffic lights float over the top-left of the rail, so it needs a left inset. In a
 * plain browser (dev harness) or on Linux there are no overlaid controls to dodge. */
function isMacTauri(): boolean {
  return (
    isTauri() &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Macintosh')
  );
}

/** Whether to reserve space for the macOS traffic lights. They auto-hide in native
 * fullscreen, so the inset collapses there; fullscreen is re-checked on every window resize
 * (entering/leaving fullscreen always resizes, and `isFullscreen` is the reliable signal). */
export function useTrafficLightInset(): boolean {
  const [inset, setInset] = useState(() => isMacTauri());

  useEffect(() => {
    if (!isMacTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const update = async () => {
        const fullscreen = await win.isFullscreen();
        if (!cancelled) setInset(!fullscreen);
      };
      void update();
      const stop = await win.onResized(() => void update());
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return inset;
}

interface SidebarProps {
  hasActiveProject: boolean;
  /** True for a teammate on a team-local daemon whose credential is below the
   *  operator tier: Terminals and Design are left out of the rail. Never set
   *  for the person running the daemon. */
  hideHostViews?: boolean;
  section: 'project' | 'global';
  projectView: ProjectView;
  globalView: GlobalView;
  /** The rail's top-row switcher (`ProjectSwitcher`) — App wires its lazy project list. */
  switcher: ReactNode;
  /** Leave 76px on the left of the top strip for the macOS traffic lights. */
  trafficLightInset: boolean;
  onOpenPalette: () => void;
  onNewTask: () => void;
  /** Everything waiting on a human — the Inbox row's count and attention dot. */
  inboxCount: number;
  /** Open questions and handoffs waiting on me, from the Threads rail. */
  threadsNeedsYouCount?: number;
  /** Overseer tool calls and queued actions waiting on the human — the Overseer row's count. */
  overseerPendingCount?: number;
  /** Count of non-terminal runs for this project — the All agents row's count. */
  liveAgentCount: number;
  drafts: DraftRecord[];
  onOpenDraft: (id: string) => void;
  onDismissDraft: (id: string) => void;
  onSetProjectView: (view: ProjectView) => void;
  /** `page` lands Settings on one of its pages — the Try block's Connect Linear opens
   * Integrations. */
  onSetGlobalView: (
    view: GlobalView,
    options?: { page?: 'integrations' }
  ) => void;
  /** The `Live agents ▾` section's body (`LiveRail`), or `null` outside project scope. */
  liveRail: ReactNode;
  /** The Try block's "Drop a thought" — the ⌘D quick capture. */
  onQuickCapture: () => void;
  /** The project's saved views, one nested row each under Tasks (linear-reference §2's
   * `Views`). Defaults to none. */
  savedViews?: { id: string; name: string }[];
  /** Starred views and tasks — the `Favorites ▾` section, present only when non-empty. */
  favorites?: SidebarFavorite[];
  /** The saved view the Tasks page is showing, which makes its nested row the active one
   * while the project view is `board`. */
  activeSavedViewId?: string | null;
  onSelectSavedView?: (id: string) => void;
  onOpenFavorite?: (ref: { kind: 'view' | 'task'; id: string }) => void;
}

/**
 * Linear's rail on the `#08080a` frame: a top strip holding the project switcher plus
 * search and new-task icon buttons, a fixed heading-less group (Inbox, Threads, Drafts,
 * Overseer), then the collapsible `Favorites ▾` (when anything is starred), `Workspace ▾` — with the
 * saved views nested under Tasks — `Fleet ▾`, `Live agents ▾` and `Try ▾` sections. Built
 * on `SidebarNav` (`ui/ai/sidebar-nav.tsx`) inside the `Sidebar` shell that App's
 * `SidebarProvider` hides entirely on `[`. Settings is not a row: it lives in the
 * switcher's menu, on `G S` and behind the header's gear; the status strip's `?` is the
 * shortcuts sheet.
 */
export function Sidebar({
  hasActiveProject,
  hideHostViews = false,
  section,
  projectView,
  globalView,
  switcher,
  trafficLightInset,
  onOpenPalette,
  onNewTask,
  inboxCount,
  threadsNeedsYouCount = 0,
  overseerPendingCount = 0,
  liveAgentCount,
  drafts,
  onOpenDraft,
  onDismissDraft,
  onSetProjectView,
  onSetGlobalView,
  liveRail,
  onQuickCapture,
  savedViews = NO_VIEWS,
  favorites = NO_FAVORITES,
  activeSavedViewId = null,
  onSelectSavedView,
  onOpenFavorite,
}: SidebarProps) {
  const sections = useSidebarSections();
  const [draftsOpen, setDraftsOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const draftCount = drafts.filter(
    (d) =>
      d.state === 'running' || d.state === 'ready' || d.questions.length > 0
  ).length;

  // A saved view showing on the Tasks page lights its nested row rather than Tasks itself.
  const activeId =
    section === 'project'
      ? projectView === 'board' && activeSavedViewId !== null
        ? VIEW_ROW + activeSavedViewId
        : projectView
      : globalView;

  const topGroup: SidebarNavSection = {
    id: 'top',
    items: [
      {
        // The Cockpit: what is ready for you, in flight, and waiting on you.
        id: 'cockpit',
        label: 'Home',
        icon: <House strokeWidth={2} />,
        disabled: !hasActiveProject,
      },
      {
        id: 'inbox',
        label: 'Inbox',
        icon: <Inbox strokeWidth={2} />,
        count: inboxCount > 0 ? inboxCount : undefined,
        // The one row whose count is "needs a human" — it earns the dot, not just a number.
        state: inboxCount > 0 ? 'attention' : undefined,
        disabled: !hasActiveProject,
      },
      {
        id: 'threads',
        label: 'Threads',
        icon: <MessagesSquare strokeWidth={2} />,
        count: threadsNeedsYouCount > 0 ? threadsNeedsYouCount : undefined,
        state: threadsNeedsYouCount > 0 ? 'attention' : undefined,
        disabled: !hasActiveProject,
      },
      {
        id: 'drafts',
        label: 'Drafts',
        icon: <Sparkles strokeWidth={2} />,
        count: draftCount > 0 ? draftCount : undefined,
        disabled: !hasActiveProject,
      },
      {
        id: 'overseer',
        label: 'Assistant',
        icon: <Shield strokeWidth={2} />,
        count: overseerPendingCount > 0 ? overseerPendingCount : undefined,
        state: overseerPendingCount > 0 ? 'attention' : undefined,
      },
    ],
  };

  // One row from a view definition. Shared by all three sections so a row
  // looks and disables the same wherever it sits.
  const rowFor = (view: ViewRow<ProjectView | GlobalView>): SidebarNavItem => {
    const Icon = view.icon;
    return {
      id: view.id,
      label: view.label,
      icon: <Icon strokeWidth={2} />,
      disabled: !hasActiveProject,
    } satisfies SidebarNavItem;
  };

  const work: SidebarNavSection = {
    // The persisted id stays `workspace`: it is a localStorage key, and
    // renaming it would collapse the section for everyone who had it open.
    id: 'workspace',
    label: 'Work',
    collapsible: true,
    collapsed: sections.collapsed('workspace'),
    onToggle: () => sections.toggle('workspace'),
    items: WORK_VIEWS.flatMap((view) => {
      const row = rowFor(view);
      if (view.id !== 'board') return [row];
      // The saved views nest under Tasks, the 16px-indented rows of a team's `Views`.
      return [
        row,
        ...savedViews.map(
          (saved) =>
            ({
              id: VIEW_ROW + saved.id,
              label: saved.name,
              icon: <Layers strokeWidth={2} />,
              indent: 1,
              disabled: !hasActiveProject,
            }) satisfies SidebarNavItem
        ),
      ];
    }),
  };

  const code: SidebarNavSection = {
    id: 'code',
    label: 'Code',
    collapsible: true,
    collapsed: sections.collapsed('code'),
    onToggle: () => sections.toggle('code'),
    items: CODE_VIEWS.filter(
      (view) => !(hideHostViews && HOST_VIEWS.has(view.id))
    ).map(rowFor),
  };

  const favoritesSection: SidebarNavSection | null =
    favorites.length > 0
      ? {
          id: 'favorites',
          label: 'Favorites',
          collapsible: true,
          collapsed: sections.collapsed('favorites'),
          onToggle: () => sections.toggle('favorites'),
          items: favorites.map((fav) => ({
            id: (fav.kind === 'view' ? FAV_VIEW_ROW : FAV_TASK_ROW) + fav.id,
            label: fav.label,
            icon:
              fav.kind === 'view' ? (
                <Layers strokeWidth={2} />
              ) : (
                <CircleDot strokeWidth={2} />
              ),
            disabled: !hasActiveProject,
          })),
        }
      : null;

  const runs: SidebarNavSection = {
    // Persisted id stays `fleet` for the same reason `workspace` does.
    id: 'fleet',
    label: 'Runs',
    collapsible: true,
    collapsed: sections.collapsed('fleet'),
    onToggle: () => sections.toggle('fleet'),
    // The merge queue leads: "what is landing" is the question someone opens
    // this section to answer, and the agent lists are how it gets there.
    items: [...RUN_PROJECT_VIEWS, ...RUN_GLOBAL_VIEWS].map((view) => ({
      ...rowFor(view),
      // Only the global agent rows are reachable with no project open, and
      // only one of them carries a count.
      disabled: view.id === 'landing' ? !hasActiveProject : false,
      count:
        view.id === 'all-agents' && liveAgentCount > 0
          ? liveAgentCount
          : undefined,
    })),
  };

  const live: SidebarNavSection | null =
    liveRail !== null
      ? {
          id: 'live',
          label: 'Live agents',
          collapsible: true,
          collapsed: sections.collapsed('live'),
          onToggle: () => sections.toggle('live'),
          items: [],
          content: liveRail,
        }
      : null;

  const tryBlock: SidebarNavSection = {
    id: 'try',
    label: 'Try',
    collapsible: true,
    collapsed: sections.collapsed('try'),
    onToggle: () => sections.toggle('try'),
    items: [
      {
        id: 'try-plan',
        label: 'Plan work…',
        icon: <NotebookPen strokeWidth={2} />,
        disabled: !hasActiveProject,
      },
      {
        id: 'try-capture',
        label: 'Drop a thought',
        icon: <Brain strokeWidth={2} />,
        disabled: !hasActiveProject,
      },
      {
        id: 'try-linear',
        label: 'Connect Linear',
        icon: <Link2 strokeWidth={2} />,
      },
    ],
  };

  const navSections: SidebarNavSection[] = [
    topGroup,
    ...(favoritesSection !== null ? [favoritesSection] : []),
    work,
    runs,
    code,
    ...(live !== null ? [live] : []),
    tryBlock,
  ];

  const handleSelect = useCallback(
    (id: string) => {
      if (id === 'drafts') {
        setDraftsOpen((open) => !open);
        return;
      }
      if (id.startsWith('try-')) {
        // First use is the last time the block needs to be open by default.
        sections.collapse('try');
        if (id === 'try-plan') onSetProjectView('plans');
        else if (id === 'try-capture') onQuickCapture();
        else onSetGlobalView('settings', { page: 'integrations' });
        return;
      }
      if (id.startsWith(VIEW_ROW)) {
        onSelectSavedView?.(id.slice(VIEW_ROW.length));
        return;
      }
      if (id.startsWith(FAV_VIEW_ROW)) {
        onOpenFavorite?.({ kind: 'view', id: id.slice(FAV_VIEW_ROW.length) });
        return;
      }
      if (id.startsWith(FAV_TASK_ROW)) {
        onOpenFavorite?.({ kind: 'task', id: id.slice(FAV_TASK_ROW.length) });
        return;
      }
      if ((PROJECT_VIEW_ORDER as string[]).includes(id)) {
        onSetProjectView(id as ProjectView);
        return;
      }
      onSetGlobalView(id as GlobalView);
    },
    [
      sections,
      onSetProjectView,
      onSetGlobalView,
      onQuickCapture,
      onSelectSavedView,
      onOpenFavorite,
    ]
  );

  return (
    <SidebarRoot id="dispatch-sidebar">
      {/* The window's drag strip: with `titleBarStyle: "Overlay"` the native traffic lights
          float over the top-left of this row, so it steps right to clear them. Only elements
          carrying `data-tauri-drag-region` start a window drag, so every control stays
          clickable. */}
      <div
        data-tauri-drag-region
        className={cn(
          'flex h-10 shrink-0 items-center gap-1 pr-2',
          trafficLightInset ? 'pl-[76px]' : 'pl-2'
        )}
      >
        <div className="min-w-0 flex-1">{switcher}</div>
        <Tooltip>
          <TooltipTrigger
            render={<IconButton label="Search" onClick={onOpenPalette} />}
          >
            <Search />
          </TooltipTrigger>
          <TooltipContent side="bottom">Search ⌘K</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <IconButton
                filled
                label="New task"
                onClick={onNewTask}
                disabled={!hasActiveProject}
              />
            }
          >
            <SquarePen />
          </TooltipTrigger>
          <TooltipContent side="bottom">New task C</TooltipContent>
        </Tooltip>
      </div>
      <div ref={navRef} className="min-h-0 flex-1">
        <SidebarNav
          sections={navSections}
          activeId={activeId}
          onSelect={handleSelect}
        />
      </div>
      <DraftTrayPopover
        open={draftsOpen}
        onOpenChange={setDraftsOpen}
        anchor={() =>
          navRef.current?.querySelector('[data-nav-item="drafts"]') ?? null
        }
        drafts={drafts}
        onOpenDraft={onOpenDraft}
        onDismissDraft={onDismissDraft}
      />
    </SidebarRoot>
  );
}
