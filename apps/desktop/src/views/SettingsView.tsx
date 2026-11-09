import type { ConfigPatch } from '@dispatch-foo/core/browser';
import { EmptyState } from '@dispatch/ui';
import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Bot,
  BotMessageSquare,
  Brain,
  CalendarRange,
  Cpu,
  FileDiff,
  FolderSearch,
  Gauge,
  Globe,
  KeyRound,
  MonitorPlay,
  Network,
  Plug,
  RefreshCw,
  SearchIcon,
  Server,
  Settings2,
  ShieldCheck,
  Smartphone,
  Users,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { A2ASection } from '../components/settings/A2ASection';
import {
  accessFor,
  SettingsAccessProvider,
} from '../components/settings/access';
import { AgentRosterSection } from '../components/settings/AgentRosterSection';
import { AgentsSection } from '../components/settings/AgentsSection';
import { AppearanceRow } from '../components/settings/AppearanceRow';
import { BoardSyncGroup } from '../components/settings/BoardSyncGroup';
import { ChecksSection } from '../components/settings/ChecksSection';
import {
  boardStorage,
  BoardSyncSettings,
  CommitTaskFilesGroup,
  DaemonConfigGroups,
} from '../components/settings/DaemonConfigGroups';
import { DaemonSection } from '../components/settings/DaemonSection';
import { DevicesSection } from '../components/settings/DevicesSection';
import { DiffsSection } from '../components/settings/DiffsSection';
import { DigestsGroup } from '../components/settings/DigestsGroup';
import { GeneralSection } from '../components/settings/GeneralSection';
import { IntegrationsSection } from '../components/settings/IntegrationsSection';
import { LicenseSection } from '../components/settings/LicenseSection';
import { MemorySection } from '../components/settings/MemorySection';
import { NotificationsSection } from '../components/settings/NotificationsSection';
import { PlanningAuditGroup } from '../components/settings/PlanningAuditGroup';
import { PlanningSection } from '../components/settings/PlanningSection';
import { PolicySection } from '../components/settings/PolicySection';
import { PreviewsSection } from '../components/settings/PreviewsSection';
import { QueueWeightsGroup } from '../components/settings/QueueWeightsGroup';
import { RemotesSection } from '../components/settings/RemotesSection';
import {
  SearchScopeProvider,
  SettingsSearchProvider,
} from '../components/settings/search';
import {
  SettingsEmptyFrame,
  SettingsHostedBody,
  SettingsLayout,
  type SettingsNavGroup,
  SettingsPageHead,
  SettingsReadOnlyNote,
  SettingsResultPage,
  SettingsResults,
  SettingsSaveLine,
  type SettingsSaveState,
} from '../components/settings/SettingsLayout';
import { TakeOverDaemon } from '../components/settings/TakeOverDaemon';
import { TeamSection } from '../components/settings/TeamSection';
import { WebAccessSection } from '../components/settings/WebAccessSection';
import { AgentStep } from '../components/setup/AgentStep';
import { CliCommandStep } from '../components/setup/CliCommandStep';
import { GitStep } from '../components/setup/GitStep';
import { LinearStep } from '../components/setup/LinearStep';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { SETTINGS_PAGE_LABELS, type SettingsPage } from '../lib/appNav';
import { isInsufficientTier } from '../lib/daemonAuth';

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
  initialPage?: SettingsPage | HostedSettingsPage['id'];
  /** Whole views shown as extra pages (App folds Usage and Runs in here). */
  hostedPages?: readonly HostedSettingsPage[];
  /** Shown after a page's own groups (App puts memory's Recent under Memory). */
  pageExtras?: Partial<Record<SettingsPage, ReactNode>>;
  /** A page picked in the rail or from search results. App dispatches
   *  `openSettings` with it, so the hash and the crumbs follow; the view also
   *  switches at once on its own, so it works without a host. */
  onSelectPage?: (page: SettingsPage | HostedSettingsPage['id']) => void;
}

/** A page that is a whole view: full width, its own state, left out of search. Its
 *  render keeps only the view's tabs row (the host marks the view as embedded). */
export interface HostedSettingsPage {
  id: 'usage' | 'runs';
  label: string;
  icon: LucideIcon;
  intro: string;
  render: () => ReactNode;
}

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
  /** Moves to another Settings page (Setup's Linear step opens Linear). */
  selectPage: (page: SettingsPage) => void;
}

interface PageSpec {
  id: SettingsPage;
  label: string;
  icon: LucideIcon;
  /** One line under the page title saying what the page is for. */
  intro: string;
  /** Whether saves on this page go to config.yml (and so show the save line). */
  savesConfig: boolean;
  /** Groups saved in this browser rather than config.yml (General's
   *  Appearance): drawn first, above the read-only note, which speaks for the
   *  config groups under it only, and shown before config has loaded. */
  preferences?: () => ReactNode;
  render: (ctx: PageContext) => ReactNode;
}

// Renders a config-backed page body once config has loaded, and nothing before.
function withConfig(
  render: (ctx: PageContext & { config: Config }) => ReactNode
): (ctx: PageContext) => ReactNode {
  return (ctx) =>
    ctx.config === null ? null : render({ ...ctx, config: ctx.config });
}

/** The rail, grouped by what you are trying to do. Labels come from
 *  SETTINGS_PAGE_LABELS, so the rail, the page's h1 and the topbar's crumb
 *  always say the same. */
const SETTINGS_GROUPS: { label: string; pages: PageSpec[] }[] = [
  {
    label: 'Project',
    pages: [
      {
        id: 'setup',
        label: SETTINGS_PAGE_LABELS.setup,
        icon: Wrench,
        intro: 'Git and your AI agents: install, sign in, or switch.',
        savesConfig: false,
        render: (ctx) => (
          <>
            <GitStep onReady={() => {}} />
            {ctx.data.client !== null && (
              <AgentStep
                client={ctx.data.client}
                port={ctx.data.port}
                onSetDefault={(executor) => {
                  const patch: ConfigPatch = { executor };
                  return ctx.save(patch);
                }}
                onContinue={() => {}}
                continueLabel="Save"
              />
            )}
            <LinearStep
              connected={ctx.data.linearStatus?.connected ?? null}
              onConnect={() => ctx.selectPage('integrations')}
            />
            <CliCommandStep />
          </>
        ),
      },
      {
        id: 'general',
        label: SETTINGS_PAGE_LABELS.general,
        icon: Settings2,
        intro:
          "The theme in this browser, the board's columns and where pull-request checkouts go.",
        savesConfig: true,
        preferences: () => <AppearanceRow />,
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
        label: SETTINGS_PAGE_LABELS.agents,
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
            client={ctx.data.client}
            port={ctx.data.port}
          />
        )),
      },
      {
        id: 'checks',
        label: SETTINGS_PAGE_LABELS.checks,
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
        label: SETTINGS_PAGE_LABELS.autonomy,
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
        id: 'memory',
        label: SETTINGS_PAGE_LABELS.memory,
        icon: Brain,
        intro:
          'What runs remember between tasks, where it came from, and how much of it each prompt carries.',
        savesConfig: true,
        // The store's health renders without config, so a closed store still says why.
        render: (ctx) => (
          <MemorySection
            data={ctx.data}
            config={ctx.config}
            onSave={ctx.save}
          />
        ),
      },
      {
        id: 'previews',
        label: SETTINGS_PAGE_LABELS.previews,
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
        id: 'planning',
        label: SETTINGS_PAGE_LABELS.planning,
        icon: CalendarRange,
        intro:
          'How the milestone planner judges risk, which projects it counts as active, and who hears about milestones at risk.',
        savesConfig: true,
        render: withConfig((ctx) => (
          <>
            <PlanningSection
              config={ctx.config}
              people={ctx.data.people}
              onSave={ctx.save}
            />
            <DigestsGroup
              config={ctx.config}
              data={ctx.data}
              onSave={ctx.save}
            />
            <PlanningAuditGroup data={ctx.data} />
          </>
        )),
      },
      {
        id: 'notifications',
        label: SETTINGS_PAGE_LABELS.notifications,
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
        label: SETTINGS_PAGE_LABELS.team,
        icon: Users,
        intro:
          'Your team: start one, invite a teammate, or join with a link someone sent you.',
        savesConfig: false,
        render: (ctx) => <TeamSection data={ctx.data} />,
      },
      {
        id: 'sync',
        label: SETTINGS_PAGE_LABELS.sync,
        icon: RefreshCw,
        intro:
          "Keep this board in step with your teammates' copies of Dispatch, through the team relay or a git branch.",
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
        id: 'license',
        label: SETTINGS_PAGE_LABELS.license,
        icon: KeyRound,
        intro: 'Your plan and how many seats are in use.',
        savesConfig: false,
        render: (ctx) => <LicenseSection data={ctx.data} />,
      },
    ],
  },
  {
    label: 'Connections',
    pages: [
      {
        id: 'integrations',
        label: SETTINGS_PAGE_LABELS.integrations,
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
        id: 'connected-agents',
        label: SETTINGS_PAGE_LABELS['connected-agents'],
        icon: BotMessageSquare,
        intro:
          'Agent tools such as Claude Code or Codex that connected through Dispatch’s MCP server and asked to message this project, and whether they may.',
        savesConfig: false,
        render: (ctx) => <AgentRosterSection data={ctx.data} />,
      },
      {
        id: 'a2a',
        label: SETTINGS_PAGE_LABELS.a2a,
        icon: Network,
        intro:
          "Agents outside your team, on other platforms or other people's Dispatch, over the open A2A protocol. Teammates don't need this: their agents already reach yours through the team.",
        savesConfig: false,
        render: (ctx) => <A2ASection data={ctx.data} />,
      },
    ],
  },
  {
    label: 'This machine',
    pages: [
      {
        id: 'remotes',
        label: SETTINGS_PAGE_LABELS.remotes,
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
<<<<<<< HEAD
        id: 'web',
        label: SETTINGS_PAGE_LABELS.web,
        icon: Globe,
        intro:
          'Open this machine’s projects from app.dispatch.foo, in any browser, signed in as you.',
        savesConfig: false,
        render: (ctx) => <WebAccessSection data={ctx.data} />,
=======
        id: 'devices',
        label: SETTINGS_PAGE_LABELS.devices,
        icon: Smartphone,
        intro:
          'Your other devices on this daemon — the app on another machine, a phone — and the remote daemons this app connects to.',
        savesConfig: false,
        render: (ctx) => <DevicesSection data={ctx.data} />,
>>>>>>> origin/main
      },
      {
        id: 'daemon',
        label: SETTINGS_PAGE_LABELS.daemon,
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
        label: SETTINGS_PAGE_LABELS.diffs,
        icon: FileDiff,
        intro: 'How diffs look in this app. Saved in this browser only.',
        savesConfig: false,
        render: () => <DiffsSection />,
      },
    ],
  },
];

const ALL_PAGES = SETTINGS_GROUPS.flatMap((group) => group.pages);

/** Settings for the active project, in the main column: a grouped rail of
 *  pages beside the selected page (SettingsLayout). Typing in the rail's
 *  search swaps the page for every matching setting across all pages, still
 *  editable in place. Every config-backed page saves through the one `save`
 *  here and its one line beside the title. There is no header or close
 *  button: the shell's crumbs name the place, and Escape or any navigation
 *  leaves it. */
export function SettingsView({
  activeProject,
  data,
  onOpenTask,
  initialPage,
  hostedPages = [],
  pageExtras,
  onSelectPage,
}: SettingsViewProps) {
  const [saveState, setSaveState] = useState<SettingsSaveState>({
    kind: 'idle',
  });
  const [page, setPage] = useState<SettingsPage | HostedSettingsPage['id']>(
    initialPage ?? 'general'
  );
  const [query, setQuery] = useState('');
  const resultsRef = useRef<HTMLDivElement>(null);
  const [noMatches, setNoMatches] = useState(false);

  // A request that arrives while Settings is already mounted (the gear pressed from the
  // General page, a rail link App turned into openSettings) still lands; the rail keeps
  // working in between.
  useEffect(() => {
    if (initialPage !== undefined) setPage(initialPage);
  }, [initialPage]);

  const searching = query.trim() !== '';

  // Rows hide themselves, so whether anything matched is only known after
  // render: read it from the DOM rather than keeping a second index of rows.
  // Checked as each query renders, then watched, because a section can add or
  // drop rows on its own later (data that loads after the keystroke).
  useLayoutEffect(() => {
    const results = resultsRef.current;
    if (!searching || results === null) {
      setNoMatches(false);
      return undefined;
    }
    const check = () =>
      setNoMatches(results.querySelector('[data-settings-row]') === null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(results, {
      childList: true,
      subtree: true,
      attributeFilter: ['data-settings-row'],
    });
    return () => observer.disconnect();
  }, [searching, query]);

  // What this viewer may change, handed to every group and row below.
  const access = accessFor(
    data.myTier,
    data.attachedWithoutAppToken,
    data.takeover?.background === true
  );

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

  // Picking a page (a rail link, a results heading) ends any search, shows
  // the page at once, and tells the host so the hash and crumbs follow.
  const selectPage = (next: SettingsPage | HostedSettingsPage['id']) => {
    setQuery('');
    setPage(next);
    onSelectPage?.(next);
  };

  if (activeProject === null) {
    return (
      <SettingsEmptyFrame>
        <EmptyState
          label="No project selected"
          icon={<FolderSearch size={22} strokeWidth={1.8} aria-hidden />}
        >
          Pick a project in the sidebar.
        </EmptyState>
      </SettingsEmptyFrame>
    );
  }

  const hosted = hostedPages.find((entry) => entry.id === page);
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
    selectPage,
  };

  const navGroups: SettingsNavGroup[] = [
    ...SETTINGS_GROUPS,
    ...(hostedPages.length === 0
      ? []
      : [{ label: 'Activity', pages: hostedPages }]),
  ];
  const saveLine = <SettingsSaveLine state={saveState} />;
  const showHosted = hosted !== undefined && !searching;

  return (
    <SettingsAccessProvider access={access}>
      <SettingsLayout
        groups={navGroups}
        page={showHosted ? hosted.id : spec.id}
        query={query}
        onQueryChange={setQuery}
        onSelectPage={selectPage}
        hosted={showHosted}
      >
        {showHosted ? (
          // Titled like every other page; the hosted view keeps only its toolbar row.
          <>
            <SettingsPageHead title={hosted.label} intro={hosted.intro} />
            <SettingsHostedBody>{hosted.render()}</SettingsHostedBody>
          </>
        ) : searching ? (
          <>
            <SettingsPageHead
              title={<>Results for &ldquo;{query.trim()}&rdquo;</>}
              status={saveLine}
            />
            <SettingsSearchProvider query={query}>
              <SettingsResults ref={resultsRef}>
                {ALL_PAGES.map((entry) => (
                  <SearchScopeProvider key={entry.id} text={entry.label}>
                    <SettingsResultPage
                      page={entry}
                      onPick={() => selectPage(entry.id)}
                    >
                      {entry.preferences?.()}
                      {entry.render(ctx)}
                    </SettingsResultPage>
                  </SearchScopeProvider>
                ))}
              </SettingsResults>
            </SettingsSearchProvider>
            {noMatches && (
              <EmptyState
                label="No settings match"
                icon={<SearchIcon size={22} strokeWidth={1.8} aria-hidden />}
              >
                Try a different word, like “budget”, “model” or “webhook”.
              </EmptyState>
            )}
          </>
        ) : (
          <>
            <SettingsPageHead
              title={spec.label}
              status={spec.savesConfig ? saveLine : undefined}
              intro={spec.intro}
            />
            {spec.preferences?.()}
            {/* No tier yet means no connection yet, not a refusal. */}
            {spec.savesConfig && data.myTier !== null && !access.canDecide && (
              <SettingsReadOnlyNote
                reason={access.decideReason}
                action={
                  data.takeover === null ? undefined : (
                    <TakeOverDaemon
                      takeover={data.takeover}
                      onRestart={data.handleRestartDaemon}
                    />
                  )
                }
              />
            )}
            {spec.render(ctx)}
            {pageExtras?.[spec.id]}
          </>
        )}
      </SettingsLayout>
    </SettingsAccessProvider>
  );
}
