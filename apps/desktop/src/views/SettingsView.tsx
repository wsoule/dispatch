import type { ConfigPatch } from '@dispatch-foo/core/browser';
import { Button, EmptyState, TextField } from '@dispatch/ui';
import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Bot,
  BotMessageSquare,
  Brain,
  Cpu,
  FileDiff,
  FolderSearch,
  Gauge,
  KeyRound,
  LockIcon,
  MonitorPlay,
  Network,
  Plug,
  RefreshCw,
  SearchIcon,
  Server,
  Settings2,
  ShieldCheck,
  Users,
  Wrench,
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

import { A2ASection } from '../components/settings/A2ASection';
import {
  accessFor,
  SettingsAccessProvider,
} from '../components/settings/access';
import { AgentRosterSection } from '../components/settings/AgentRosterSection';
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
import { MemorySection } from '../components/settings/MemorySection';
import { NotificationsSection } from '../components/settings/NotificationsSection';
import { PolicySection } from '../components/settings/PolicySection';
import { PreviewsSection } from '../components/settings/PreviewsSection';
import { QueueWeightsGroup } from '../components/settings/QueueWeightsGroup';
import { RemotesSection } from '../components/settings/RemotesSection';
import {
  SearchScopeProvider,
  SettingsSearchProvider,
} from '../components/settings/search';
import { TakeOverDaemon } from '../components/settings/TakeOverDaemon';
import { TeamSection } from '../components/settings/TeamSection';
import { AgentStep } from '../components/setup/AgentStep';
import { CliCommandStep } from '../components/setup/CliCommandStep';
import { GitStep } from '../components/setup/GitStep';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { SettingsPage } from '../lib/appNav';
import { isInsufficientTier } from '../lib/daemonAuth';
import styles from './SettingsView.module.css';

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
  /** Whole views shown as extra pages (Two views folds Sessions and All agents in here). */
  hostedPages?: readonly HostedSettingsPage[];
  /** Actions at the end of the header's crumb row, e.g. the panel's close button. */
  headerActions?: ReactNode;
  /** Shown after a page's own groups (Two views puts memory's Recent under Memory). */
  pageExtras?: Partial<Record<SettingsPage, ReactNode>>;
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
        id: 'setup',
        label: 'Setup',
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
            <CliCommandStep />
          </>
        ),
      },
      {
        id: 'general',
        label: 'General',
        icon: Settings2,
        intro: "The board's columns and where pull-request checkouts go.",
        savesConfig: true,
        render: (ctx) => (
          <>
            {ctx.config !== null && (
              <GeneralSection
                config={ctx.config}
                onSave={ctx.save}
                canOperate={ctx.canOperate}
              />
            )}
          </>
        ),
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
            client={ctx.data.client}
            port={ctx.data.port}
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
        id: 'memory',
        label: 'Memory',
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
        intro:
          'Your team: start one, invite a teammate, or join with a link someone sent you.',
        savesConfig: false,
        render: (ctx) => <TeamSection data={ctx.data} />,
      },
      {
        id: 'sync',
        label: 'Board sync',
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
        label: 'License',
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
        id: 'connected-agents',
        label: 'Connected agents',
        icon: BotMessageSquare,
        intro:
          'Agent tools such as Claude Code or Codex that connected through Dispatch’s MCP server and asked to message this project, and whether they may.',
        savesConfig: false,
        render: (ctx) => <AgentRosterSection data={ctx.data} />,
      },
      {
        id: 'a2a',
        label: 'A2A',
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
  hostedPages = [],
  headerActions,
  pageExtras,
}: SettingsViewProps) {
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [page, setPage] = useState<SettingsPage | HostedSettingsPage['id']>(
    initialPage ?? 'general'
  );
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

  if (activeProject === null) {
    return (
      <div className={styles.view}>
        <SettingsHeader actions={headerActions} />
        <div className={styles.empty}>
          <EmptyState
            label="No project selected"
            icon={<FolderSearch size={22} strokeWidth={1.8} aria-hidden />}
          >
            Pick a project in the sidebar.
          </EmptyState>
        </div>
      </div>
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
  };

  const saveLine = (
    <span
      role="status"
      className={styles.saveLine}
      data-error={saveState.kind === 'error' ? '' : undefined}
    >
      {saveState.kind === 'saving' && 'Saving…'}
      {saveState.kind === 'saved' && 'Saved'}
      {saveState.kind === 'error' && saveState.message}
    </span>
  );

  return (
    <SettingsAccessProvider access={access}>
      <div className={styles.view}>
        <SettingsHeader actions={headerActions} />
        <div className={styles.body}>
          <nav aria-label="Settings" className={styles.rail}>
            <TextField
              type="search"
              size="sm"
              aria-label="Search settings"
              placeholder="Search settings"
              value={query}
              className={styles.search}
              start={<SearchIcon size={14} strokeWidth={1.8} aria-hidden />}
              end={
                searching ? (
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label="Clear search"
                    icon={<XIcon size={14} strokeWidth={1.8} aria-hidden />}
                    onClick={() => setQuery('')}
                  />
                ) : undefined
              }
              onChange={(e) => setQuery(e.target.value)}
              // Escape with text in the search clears it and stops there, so the same
              // press never also closes the panel; an empty search lets it close.
              onKeyDown={(e) => {
                if (e.key !== 'Escape' || query === '') return;
                e.preventDefault();
                e.stopPropagation();
                setQuery('');
              }}
            />
            {[
              ...SETTINGS_GROUPS,
              ...(hostedPages.length === 0
                ? []
                : [{ label: 'Activity', pages: hostedPages }]),
            ].map((group) => (
              <div key={group.label}>
                <div className={styles.railGroup}>{group.label}</div>
                <div className={styles.railRows}>
                  {group.pages.map((entry) => {
                    const active = !searching && entry.id === page;
                    const Icon = entry.icon;
                    // A native button: Gr8r's Button takes no aria-current.
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        aria-current={active ? 'page' : undefined}
                        className={styles.railRow}
                        onClick={() => {
                          setQuery('');
                          setPage(entry.id);
                        }}
                      >
                        <Icon aria-hidden size={14} strokeWidth={1.8} />
                        <span className={styles.railLabel}>{entry.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {hosted !== undefined && !searching ? (
            // Titled like every other page; the hosted view keeps only its tabs row.
            <div className={styles.hosted}>
              <div className={styles.hostedHead}>
                <h1 className={styles.pageTitle}>{hosted.label}</h1>
                <p className={styles.intro}>{hosted.intro}</p>
              </div>
              <div className={styles.hostedBody}>{hosted.render()}</div>
            </div>
          ) : (
            <div className={styles.scroller}>
              <div className={styles.column}>
                {searching ? (
                  <>
                    <div className={styles.titleRow}>
                      <h1 className={styles.resultsTitle}>
                        Results for &ldquo;{query.trim()}&rdquo;
                      </h1>
                      {saveLine}
                    </div>
                    <SettingsSearchProvider query={query}>
                      <div ref={resultsRef} className={styles.results}>
                        {ALL_PAGES.map((entry) => (
                          <SearchScopeProvider
                            key={entry.id}
                            text={entry.label}
                          >
                            <section
                              aria-label={entry.label}
                              className={styles.resultPage}
                            >
                              <span className={styles.resultLink}>
                                <Button
                                  variant="quiet"
                                  size="sm"
                                  icon={
                                    <entry.icon
                                      aria-hidden
                                      size={14}
                                      strokeWidth={1.8}
                                    />
                                  }
                                  onClick={() => {
                                    setQuery('');
                                    setPage(entry.id);
                                  }}
                                >
                                  {entry.label}
                                </Button>
                              </span>
                              {entry.render(ctx)}
                            </section>
                          </SearchScopeProvider>
                        ))}
                      </div>
                    </SettingsSearchProvider>
                    {noMatches && (
                      <EmptyState
                        label="No settings match"
                        icon={
                          <SearchIcon size={22} strokeWidth={1.8} aria-hidden />
                        }
                      >
                        Try a different word, like “budget”, “model” or
                        “webhook”.
                      </EmptyState>
                    )}
                  </>
                ) : (
                  <>
                    <div className={styles.pageHead}>
                      <div className={styles.titleRow}>
                        <h1 className={styles.pageTitle}>{spec.label}</h1>
                        {spec.savesConfig && saveLine}
                      </div>
                      <p className={styles.intro}>{spec.intro}</p>
                    </div>
                    {/* No tier yet means no connection yet, not a refusal. */}
                    {spec.savesConfig &&
                      data.myTier !== null &&
                      !access.canDecide && (
                        <div className={styles.lockNote}>
                          <p role="note" className={styles.lockLine}>
                            <LockIcon aria-hidden size={14} strokeWidth={1.8} />
                            {access.decideReason}
                          </p>
                          {data.takeover !== null && (
                            <div className={styles.lockAction}>
                              <TakeOverDaemon
                                takeover={data.takeover}
                                onRestart={data.handleRestartDaemon}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    {spec.render(ctx)}
                    {pageExtras?.[spec.id]}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </SettingsAccessProvider>
  );
}

/** The crumb row above the rail and the page, with the host's actions at its end. */
function SettingsHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className={styles.header}>
      <span className={styles.crumb}>Settings</span>
      {actions !== undefined && actions !== null && (
        <div className={styles.headerActions}>{actions}</div>
      )}
    </header>
  );
}
