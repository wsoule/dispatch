import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Bot,
  Cpu,
  FileDiff,
  FolderSearch,
  Gauge,
  KeyRound,
  LockIcon,
  MonitorPlay,
  Plug,
  RefreshCw,
  SearchIcon,
  Server,
  Settings2,
  ShieldCheck,
  Users,
  XIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  accessFor,
  SettingsAccessProvider,
} from '../components/settings/access';
import { AgentsSection } from '../components/settings/AgentsSection';
import { BoardSyncGroup } from '../components/settings/BoardSyncGroup';
import { ChecksSection } from '../components/settings/ChecksSection';
import {
  boardStorage,
  BoardSyncSettings,
  CommitTaskFilesGroup,
  DaemonConfigGroups,
} from '../components/settings/DaemonConfigGroups';
import { DaemonSection } from '../components/settings/DaemonSection';
import { DiffsSection } from '../components/settings/DiffsSection';
import { GeneralSection } from '../components/settings/GeneralSection';
import { IntegrationsSection } from '../components/settings/IntegrationsSection';
import { LicenseSection } from '../components/settings/LicenseSection';
import { NotificationsSection } from '../components/settings/NotificationsSection';
import { PolicySection } from '../components/settings/PolicySection';
import { PreviewsSection } from '../components/settings/PreviewsSection';
import { QueueWeightsGroup } from '../components/settings/QueueWeightsGroup';
import { RemotesSection } from '../components/settings/RemotesSection';
import {
  SearchScopeProvider,
  SettingsSearchProvider,
} from '../components/settings/search';
import { TeamSection } from '../components/settings/TeamSection';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { SettingsPage } from '../lib/appNav';
import { isInsufficientTier } from '../lib/daemonAuth';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/ui/ai/page-header';
import {
  SIDEBAR_ROW_ACTIVE_CLASS,
  SIDEBAR_ROW_CLASS,
  SIDEBAR_ROW_INACTIVE_CLASS,
} from '@/ui/ai/sidebar-nav';
import { EmptyState } from '@/ui/chrome';
import { Input } from '@/ui/input';

interface SettingsViewProps {
  /** Just `{ path, name }`, the same minimal shape `App.tsx` derives from
   *  `currentProjectRoot()` — not the full observability-database `ProjectSummary`. */
  activeProject: { path: string; name: string } | null;
  data: DispatchProjectData;
  /** Opens a task's full view — the Autonomy page's receipts link through to
   *  the task ledger that holds each auto-decision. */
  onOpenTask?: (taskId: string) => void;
  /** The page to open on — `navState.settingsPage`, which the rail's Connect Linear and
   *  the strip's gear set to Integrations. A new value while mounted switches the page. */
  initialPage?: SettingsPage;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

type Config = NonNullable<DispatchProjectData['config']>;

/** What every page's body is drawn from. `config` is null until it loads (or
 *  while the daemon is down), which only the config-backed pages wait on. */
interface PageContext {
  data: DispatchProjectData;
  config: Config | null;
  /** Resolves false when the save was refused, so a form can keep its draft. */
  save: (
    patch: Parameters<DispatchProjectData['handleUpdateConfig']>[0]
  ) => Promise<boolean>;
  canOperate: boolean;
  activeProject: { path: string; name: string };
  onOpenTask?: (taskId: string) => void;
}

interface PageSpec {
  id: SettingsPage;
  label: string;
  icon: LucideIcon;
  /** One line under the page title saying what the page is for. */
  intro: string;
  /** Whether saves on this page go to config.yml (and so show the save line). */
  savesConfig: boolean;
  render: (ctx: PageContext) => ReactNode;
}

/** The rail, grouped by what you are trying to do. Labels double as page titles. */
// Renders a config-backed page body once config has loaded, and nothing before.
function withConfig(
  render: (ctx: PageContext & { config: Config }) => ReactNode
): (ctx: PageContext) => ReactNode {
  return (ctx) =>
    ctx.config === null ? null : render({ ...ctx, config: ctx.config });
}

const SETTINGS_GROUPS: { label: string; pages: PageSpec[] }[] = [
  {
    label: 'Project',
    pages: [
      {
        id: 'general',
        label: 'General',
        icon: Settings2,
        intro: "The board's columns and where pull-request checkouts go.",
        savesConfig: true,
        render: withConfig((ctx) => (
          <GeneralSection
            config={ctx.config}
            onSave={ctx.save}
            canOperate={ctx.canOperate}
          />
        )),
      },
      {
        id: 'agents',
        label: 'Agents',
        icon: Bot,
        intro:
          'Which models do the work, how hard they think, and the limits they run under.',
        savesConfig: true,
        render: withConfig((ctx) => (
          <AgentsSection
            config={ctx.config}
            executors={ctx.data.executors}
            onSave={ctx.save}
            canOperate={ctx.canOperate}
          />
        )),
      },
      {
        id: 'checks',
        label: 'Checks',
        icon: ShieldCheck,
        intro:
          'What a branch must pass before it merges, and what happens when it fails.',
        savesConfig: true,
        render: withConfig((ctx) => (
          <ChecksSection
            config={ctx.config}
            onSave={ctx.save}
            canOperate={ctx.canOperate}
          />
        )),
      },
      {
        id: 'autonomy',
        label: 'Autonomy',
        icon: Gauge,
        intro:
          'How much Dispatch decides on its own, and what always waits for you.',
        savesConfig: true,
        render: withConfig((ctx) => (
          <>
            <PolicySection
              config={ctx.config}
              onSave={ctx.save}
              client={ctx.data.client}
              onOpenTask={ctx.onOpenTask}
            />
            <QueueWeightsGroup config={ctx.config} onSave={ctx.save} />
          </>
        )),
      },
      {
        id: 'previews',
        label: 'Previews',
        icon: MonitorPlay,
        intro: "Start a run's app from its own checkout to try the change.",
        savesConfig: true,
        render: withConfig((ctx) => (
          <PreviewsSection
            config={ctx.config}
            onSave={ctx.save}
            canOperate={ctx.canOperate}
          />
        )),
      },
      {
        id: 'notifications',
        label: 'Notifications',
        icon: Bell,
        intro: 'What reaches you when you are not looking at Dispatch.',
        savesConfig: true,
        render: withConfig((ctx) => (
          <NotificationsSection
            config={ctx.config}
            onSave={ctx.save}
            canOperate={ctx.canOperate}
          />
        )),
      },
    ],
  },
  {
    label: 'Team',
    pages: [
      {
        id: 'team',
        label: 'Members',
        icon: Users,
        intro: "Who can work on this project's board.",
        savesConfig: false,
        render: (ctx) => <TeamSection data={ctx.data} />,
      },
      {
        id: 'sync',
        label: 'Board sync',
        icon: RefreshCw,
        intro:
          "Keep one board in step with teammates' copies of Dispatch through git.",
        savesConfig: true,
        // Sharing works only on a database-backed board; a board kept as
        // files reaches teammates by committing them instead. Until the
        // daemon says which, neither set of controls is offered.
        render: withConfig((ctx) => {
          const storage = boardStorage(ctx.data.health, ctx.data.syncStatus);
          if (storage === null) return null;
          return storage === 'files' ? (
            <CommitTaskFilesGroup
              config={ctx.config}
              onSave={ctx.save}
              syncStatus={ctx.data.syncStatus}
              canOperate={ctx.canOperate}
            />
          ) : (
            <>
              <BoardSyncGroup data={ctx.data} />
              <BoardSyncSettings
                config={ctx.config}
                onSave={ctx.save}
                canOperate={ctx.canOperate}
              />
            </>
          );
        }),
      },
      {
        id: 'integrations',
        label: 'Linear',
        icon: Plug,
        intro: 'Keep tasks here and issues in one Linear team in step.',
        savesConfig: true,
        render: (ctx) => (
          // LinearPanel saves through `data.handleUpdateConfig`; route it
          // through the shared save so the one save line covers it.
          <IntegrationsSection
            data={{
              ...ctx.data,
              handleUpdateConfig: async (patch) => {
                await ctx.save(patch);
              },
            }}
          />
        ),
      },
      {
        id: 'license',
        label: 'License',
        icon: KeyRound,
        intro: 'Your plan and how many seats are in use.',
        savesConfig: false,
        render: (ctx) => <LicenseSection data={ctx.data} />,
      },
    ],
  },
  {
    label: 'This machine',
    pages: [
      {
        id: 'remotes',
        label: 'Remotes',
        icon: Server,
        intro: 'Other machines your terminals can open on, over ssh.',
        savesConfig: true,
        render: withConfig((ctx) => (
          <RemotesSection
            config={ctx.config}
            onSave={ctx.save}
            canOperate={ctx.canOperate}
          />
        )),
      },
      {
        id: 'daemon',
        label: 'Background',
        icon: Cpu,
        intro:
          "Dispatch's own process for this project, and the work it does in the background.",
        savesConfig: true,
        // Status renders without config, so a daemon that is down still says so.
        render: (ctx) => (
          <>
            <DaemonSection activeProject={ctx.activeProject} data={ctx.data} />
            {ctx.config !== null && (
              <DaemonConfigGroups
                config={ctx.config}
                onSave={ctx.save}
                canOperate={ctx.canOperate}
              />
            )}
          </>
        ),
      },
      {
        id: 'diffs',
        label: 'Diff display',
        icon: FileDiff,
        intro: 'How diffs look in this app. Saved in this browser only.',
        savesConfig: false,
        render: () => <DiffsSection />,
      },
    ],
  },
];

const ALL_PAGES = SETTINGS_GROUPS.flatMap((group) => group.pages);

/** Settings for the active project, laid out as Linear's settings shell: a
 *  grouped rail of pages on the left, the selected page as a centred column on
 *  the right. Typing in the rail's search swaps the page for every matching
 *  setting across all pages, still editable in place. Every config-backed page
 *  saves through the one `save` here and its one line beside the title. */
export function SettingsView({
  activeProject,
  data,
  onOpenTask,
  initialPage,
}: SettingsViewProps) {
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [page, setPage] = useState<SettingsPage>(initialPage ?? 'general');
  const [query, setQuery] = useState('');
  const resultsRef = useRef<HTMLDivElement>(null);
  const [noMatches, setNoMatches] = useState(false);

  // A request that arrives while Settings is already mounted (the gear pressed from the
  // General page) still lands; the nav rows keep working in between.
  useEffect(() => {
    if (initialPage !== undefined) setPage(initialPage);
  }, [initialPage]);

  const searching = query.trim() !== '';

  // Rows hide themselves, so whether anything matched is only known after
  // render: read it from the DOM rather than keeping a second index of rows.
  useLayoutEffect(() => {
    if (!searching) {
      setNoMatches(false);
      return;
    }
    setNoMatches(
      resultsRef.current?.querySelector('[data-settings-row]') === null
    );
  });

  // What this viewer may change, handed to every group and row below.
  const access = accessFor(data.myTier, data.attachedWithoutAppToken);

  // The one save path every config-backed section's onSave goes through, so
  // one indicator covers those pages instead of each section reporting on its
  // own. A tier refusal is reworded: the daemon's own text is written for the
  // CLI (`--token`, `dispatch team invite`) and says nothing useful here.
  const save = useCallback(
    async (
      patch: Parameters<DispatchProjectData['handleUpdateConfig']>[0]
    ): Promise<boolean> => {
      setSaveState({ kind: 'saving' });
      try {
        await data.handleUpdateConfig(patch);
        setSaveState({ kind: 'saved' });
        return true;
      } catch (err) {
        setSaveState({
          kind: 'error',
          message: isInsufficientTier(err)
            ? access.canDecide
              ? access.operateReason
              : access.decideReason
            : err instanceof Error
              ? err.message
              : String(err),
        });
        return false;
      }
    },
    [data, access.canDecide, access.decideReason, access.operateReason]
  );

  if (activeProject === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PageHeader crumb={['Settings']} />
        <EmptyState
          icon={FolderSearch}
          heading="No project selected"
          description="Pick a project in the sidebar."
          className="flex-1"
        />
      </div>
    );
  }

  const spec = ALL_PAGES.find((entry) => entry.id === page) ?? ALL_PAGES[0];
  const ctx: PageContext = {
    data,
    config: data.config,
    save,
    // The settings that run a command or send data elsewhere are the owner's
    // alone (the server's patchConfig); below that tier they show read-only
    // behind a lock. Everything else needs decide, which SettingsGroup reads
    // from the access context below.
    canOperate: access.canOperate,
    activeProject,
    onOpenTask,
  };

  const saveLine = (
    <span
      role="status"
      className={cn(
        'font-book text-[12px]',
        saveState.kind === 'error'
          ? 'text-state-failed'
          : 'text-muted-foreground'
      )}
    >
      {saveState.kind === 'saving' && 'Saving…'}
      {saveState.kind === 'saved' && 'Saved'}
      {saveState.kind === 'error' && saveState.message}
    </span>
  );

  return (
    <SettingsAccessProvider access={access}>
      <div className="flex h-full min-h-0 flex-col">
        <PageHeader crumb={['Settings']} />
        <div className="grid min-h-0 flex-1 grid-cols-[208px_minmax(0,1fr)]">
          <nav
            aria-label="Settings"
            className="shadow-hairline-right flex min-h-0 flex-col gap-4 overflow-y-auto px-2 py-3"
          >
            <div className="relative">
              <SearchIcon
                aria-hidden
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
              />
              <Input
                type="search"
                aria-label="Search settings"
                placeholder="Search settings"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setQuery('');
                }}
                className="pr-7 pl-7 [&::-webkit-search-cancel-button]:hidden"
              />
              {searching && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery('')}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                >
                  <XIcon aria-hidden className="size-3.5" />
                </button>
              )}
            </div>
            {SETTINGS_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="text-muted-foreground flex h-7 items-center px-2 text-[12px] font-medium">
                  {group.label}
                </div>
                <div className="flex flex-col gap-px">
                  {group.pages.map((entry) => {
                    const active = !searching && entry.id === page;
                    const Icon = entry.icon;
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        onClick={() => {
                          setQuery('');
                          setPage(entry.id);
                        }}
                        className={cn(
                          SIDEBAR_ROW_CLASS,
                          'gap-2',
                          active
                            ? SIDEBAR_ROW_ACTIVE_CLASS
                            : SIDEBAR_ROW_INACTIVE_CLASS
                        )}
                      >
                        <Icon aria-hidden className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {entry.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <div className="mx-auto flex w-full max-w-[600px] flex-col gap-6 pb-10">
              {searching ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <h1 className="text-foreground text-[20px] leading-7 font-semibold tracking-[-0.12px]">
                      Results for &ldquo;{query.trim()}&rdquo;
                    </h1>
                    {saveLine}
                  </div>
                  <SettingsSearchProvider query={query}>
                    <div ref={resultsRef} className="flex flex-col gap-8">
                      {ALL_PAGES.map((entry) => (
                        <SearchScopeProvider key={entry.id} text={entry.label}>
                          <section
                            aria-label={entry.label}
                            className="flex flex-col gap-4 [&:not(:has([data-settings-row]))]:hidden"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setQuery('');
                                setPage(entry.id);
                              }}
                              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 self-start text-[12px] font-medium"
                            >
                              <entry.icon aria-hidden className="size-3.5" />
                              {entry.label}
                            </button>
                            {entry.render(ctx)}
                          </section>
                        </SearchScopeProvider>
                      ))}
                    </div>
                  </SettingsSearchProvider>
                  {noMatches && (
                    <EmptyState
                      icon={SearchIcon}
                      heading="No settings match"
                      description="Try a different word, like “budget”, “model” or “webhook”."
                    />
                  )}
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <h1 className="text-foreground text-[24px] leading-8 font-semibold tracking-[-0.16px]">
                        {spec.label}
                      </h1>
                      {spec.savesConfig && saveLine}
                    </div>
                    <p className="font-book text-muted-foreground text-[13px]">
                      {spec.intro}
                    </p>
                  </div>
                  {/* No tier yet means no connection yet, not a refusal. */}
                  {spec.savesConfig &&
                    data.myTier !== null &&
                    !access.canDecide && (
                      <p
                        role="note"
                        className="bg-surface-secondary text-muted-foreground rounded-control font-book flex items-start gap-2 px-3 py-2 text-[12px]"
                      >
                        <LockIcon
                          aria-hidden
                          className="mt-px size-3.5 shrink-0"
                        />
                        {access.decideReason}
                      </p>
                    )}
                  {spec.render(ctx)}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </SettingsAccessProvider>
  );
}
