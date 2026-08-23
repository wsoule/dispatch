import type { ImpactEntry, ImpactSubjectKind } from '@dispatch/client';
import { IMPACT_SUBJECT_KINDS } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  TriangleAlert,
  Waypoints,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { ImpactPanel } from '../components/impact/ImpactPanel';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { ImpactSubjectRef } from '../lib/appNav';
import { findClaimOverlaps } from '../lib/claimOverlap';
import type { HopGroup } from '../lib/impactGroups';
import { DEFAULT_REVIEW_CAP, summarizeImpact } from '../lib/impactSummary';
import { resolveAffectedFilesStatus } from '../lib/impactViewStatus';
import type { InsightDelta } from '@/ui/ai/insight-cards';
import { InsightCard } from '@/ui/ai/insight-cards';
import { Button } from '@/ui/button';
import {
  EmptyState,
  HintText,
  Panel,
  PanelHeader,
  PanelRow,
} from '@/ui/chrome';
import { PathCrumb } from '@/ui/chrome/path-crumb';
import { Toolbar } from '@/ui/chrome/toolbar';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/ui/command';
import { Input } from '@/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';

interface ImpactViewProps {
  data: DispatchProjectData;
  /** Subject handed over by one of the three "open in Impact" entry points
   *  (Review case panel, task detail, Git file pane), or `null` when this
   *  view was reached from the sidebar with nothing chosen yet. */
  initialSubject: ImpactSubjectRef | null;
}

const SUBJECT_KIND_LABEL: Record<ImpactSubjectKind, string> = {
  file: 'File',
  run: 'Run',
  task: 'Task',
};

/** How the blast radius fans out by hop distance, fed straight from `groupByHop`'s already-
 * computed buckets — one point per hop, closest first. Only worth a card once there are at
 * least two hops: a single bucket has nothing to show that `ImpactPanel`'s direct/downstream
 * split above doesn't already say. */
function ReachByHopCard({ groups }: { groups: HopGroup[] }) {
  const series = groups.map((group) => group.paths.length);
  const total = series.reduce((sum, count) => sum + count, 0);
  const first = series[0] ?? 0;
  const last = series[series.length - 1] ?? 0;
  // 'up' reads as the reach widening with distance (more files at the farthest hop than the
  // nearest), 'down' as it narrowing, 'flat' as even — derived from the real per-hop counts,
  // not a fabricated trend.
  const direction: InsightDelta['direction'] =
    last > first ? 'up' : last < first ? 'down' : 'flat';
  const farthestHop = groups[groups.length - 1]?.hops ?? 0;

  return (
    <InsightCard
      title="Reach by hop"
      summary={`${total} file${total === 1 ? '' : 's'} across ${groups.length} hops`}
      series={series}
      unit="files"
      delta={{ value: `${last} at hop ${farthestHop}`, direction }}
      page={0}
      pageCount={1}
      onPageChange={() => {}}
    />
  );
}

/**
 * The zero state, made useful: instead of a blank prompt, the current overlap picture —
 * every live run's claimed write paths, with a warning strip when two runs' claims collide
 * (see `findClaimOverlaps`). The page answers "are my parallel agents about to collide?"
 * before anything is picked.
 */
function LiveClaims({
  claims,
  overlaps,
  titleByRunId,
}: {
  claims: import('@dispatch/client').RunClaim[];
  overlaps: ReturnType<typeof findClaimOverlaps>;
  titleByRunId: ReadonlyMap<string, string>;
}) {
  if (claims.length === 0) {
    return (
      <EmptyState
        icon={Waypoints}
        message="Pick a file, run, or task to see its blast radius."
      />
    );
  }

  return (
    <>
      {overlaps.map((overlap) => (
        <div
          key={overlap.a.runId + ':' + overlap.b.runId}
          className="bg-state-waiting-surface text-state-waiting rounded-control flex items-start gap-2 px-3 py-2 text-[12.5px]"
        >
          <TriangleAlert className="size-3.5 shrink-0 translate-y-0.5" />
          <span className="min-w-0">
            {(titleByRunId.get(overlap.a.runId) ?? overlap.a.taskId) +
              ' and ' +
              (titleByRunId.get(overlap.b.runId) ?? overlap.b.taskId) +
              ' are claiming overlapping paths: '}
            <span className="font-mono text-[11.5px]">
              {overlap.paths.join(', ')}
            </span>
          </span>
        </div>
      ))}

      <Panel>
        <PanelHeader count={claims.length}>Live claims</PanelHeader>
        {claims.map((claim) => (
          <PanelRow key={claim.runId} className="flex-col items-stretch gap-1">
            <span className="text-[13px] font-medium">
              {titleByRunId.get(claim.runId) ?? claim.taskId}
            </span>
            {claim.claims.length === 0 ? (
              <HintText>No writes claimed yet.</HintText>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {claim.claims.map((path) => (
                  <li key={path}>
                    <PathCrumb path={path} />
                  </li>
                ))}
              </ul>
            )}
          </PanelRow>
        ))}
      </Panel>
      <HintText>
        Pick a file, run, or task above for its full blast radius.
      </HintText>
    </>
  );
}

// A stable reference for "nothing fetched yet" so the grouping `useMemo`
// below doesn't re-run every render on a fresh `[]` literal.
const NO_ENTRIES: ImpactEntry[] = [];

interface SubjectOption {
  id: string;
  label: string;
  /** Muted trailing text — a branch, a task id. Also searchable. */
  hint?: string;
}

/** Searchable subject picker — a Command palette in a popover, replacing the raw `Select`
 * that listed every run/task in the project with no filter. */
function SubjectCombobox({
  value,
  placeholder,
  options,
  onSelect,
  ariaLabel,
}: {
  value: string;
  placeholder: string;
  options: SubjectOption[];
  onSelect: (id: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className="w-80 justify-between font-normal"
        >
          <span className={cnTruncate(selected === undefined)}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-0">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.id}
                value={`${option.label} ${option.hint ?? ''} ${option.id}`}
                onSelect={() => {
                  onSelect(option.id);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint !== undefined && (
                  <span className="text-muted-foreground ml-2 shrink-0 font-mono text-[11px]">
                    {option.hint}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function cnTruncate(placeholder: boolean): string {
  return placeholder
    ? 'text-muted-foreground min-w-0 truncate'
    : 'min-w-0 truncate';
}

/**
 * The full blast-radius browser: pick a file, run, or task, see the same
 * honesty-checked summary `ImpactPanel` renders at the top of the Review case
 * panel/task detail/Git file pane, then browse every affected path grouped
 * by hop distance with a path filter.
 *
 * Fetches through the exact query key `ImpactPanel` builds
 * (`['impact', baseUrl, kind, id]`), so this view and the embedded panel
 * share one cached request rather than each parsing its own copy of the
 * reach — the "one data shape, not two" rule this feature is built around.
 * All hop/direct/downstream/truncation wording still comes from
 * `summarizeImpact` via the embedded `ImpactPanel`; this view only adds the
 * grouped path list `ImpactPanel`'s compact surface has no room for.
 */
export function ImpactView({ data, initialSubject }: ImpactViewProps) {
  const [kind, setKind] = useState<ImpactSubjectKind>(
    initialSubject?.kind ?? 'file'
  );
  const [id, setId] = useState(initialSubject?.id ?? '');
  // A file path is free text, so it gets its own draft/commit-on-blur pair
  // (matching `EditableBodySection`'s pattern) rather than firing a fetch on
  // every keystroke.
  const [pathDraft, setPathDraft] = useState(
    initialSubject?.kind === 'file' ? (initialSubject.id ?? '') : ''
  );
  const [filter, setFilter] = useState('');
  const [collapsedHops, setCollapsedHops] = useState<ReadonlySet<number>>(
    new Set()
  );

  const hasSubject = id.trim() !== '';

  const runOptions = useMemo<SubjectOption[]>(
    () =>
      [...data.runs]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((r) => ({ id: r.id, label: r.taskTitle, hint: r.branch })),
    [data.runs]
  );
  const taskOptions = useMemo<SubjectOption[]>(
    () =>
      data.tasksIncludingArchived.map((t) => ({
        id: t.meta.id,
        label: t.meta.title,
        hint: t.meta.id,
      })),
    [data.tasksIncludingArchived]
  );

  // The zero state's data: every live run's claimed write paths. Keyed on the run count so
  // a dispatch or completion refetches; only fetched while nothing is picked.
  const { data: runClaims } = useQuery({
    queryKey: ['run-claims', data.client?.baseUrl, data.runs.length],
    queryFn: () => {
      if (data.client === null) throw new Error('no API client');
      return data.client.fetchRunClaims();
    },
    enabled: data.client !== null && !hasSubject,
    retry: false,
  });
  const overlaps = useMemo(
    () => findClaimOverlaps(runClaims ?? []),
    [runClaims]
  );
  const titleByRunId = useMemo(
    () => new Map(data.runs.map((r) => [r.id, r.taskTitle])),
    [data.runs]
  );

  const {
    data: response,
    isError,
    error,
  } = useQuery({
    queryKey: ['impact', data.client?.baseUrl, kind, id],
    queryFn: () => {
      if (data.client === null) throw new Error('no API client');
      return data.client.getImpact(kind, id);
    },
    enabled: data.client !== null && hasSubject,
    retry: false,
  });

  const entries = response?.reach.entries ?? NO_ENTRIES;
  // The same pure summary `ImpactPanel` renders from, computed once here so
  // this panel's zero-count wording (genuine zero vs. an unanalyzable seed)
  // matches it exactly rather than this view inventing its own copy.
  const summary = useMemo(
    () =>
      response
        ? summarizeImpact(response.reach, response.seeds, DEFAULT_REVIEW_CAP)
        : null,
    [response]
  );
  // Decided by a pure function (see impactViewStatus.ts) rather than inline
  // here, specifically so a failed request can never be rendered as "no
  // files affected" — `ImpactPanel` above already shows the real error;
  // this panel must agree with it, not contradict it. `resolved` is false
  // both while the query is still in flight and when it is disabled (no
  // API client yet), so neither case renders as a false "No files
  // affected." — see the terminal-false-empty bug this replaced. `reason`
  // is threaded through the same way: a `no-declared-writes` or
  // `writes-match-nothing` response already gets its own sentence from
  // `ImpactPanel` above, so this panel must not also print "No files
  // affected." underneath it.
  const status = useMemo(
    () =>
      resolveAffectedFilesStatus({
        isError,
        error,
        entries,
        filter,
        resolved: response !== undefined,
        reason: response?.reason,
        zeroMessage: summary?.zeroMessage,
      }),
    [isError, error, entries, filter, response, summary]
  );
  const shownCount =
    status.kind === 'entries'
      ? status.groups.reduce((n, g) => n + g.paths.length, 0)
      : 0;

  function toggleHop(hops: number) {
    setCollapsedHops((prev) => {
      const next = new Set(prev);
      if (next.has(hops)) next.delete(hops);
      else next.add(hops);
      return next;
    });
  }

  // Switching kind invalidates whatever id was chosen for the previous one —
  // a file path is never a valid run or task id, and vice versa.
  function pickKind(next: ImpactSubjectKind) {
    setKind(next);
    setId('');
    setPathDraft('');
    setFilter('');
    setCollapsedHops(new Set());
  }

  function commitPath() {
    setId(pathDraft.trim());
  }

  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <Select
          value={kind}
          onValueChange={(value) => pickKind(value as ImpactSubjectKind)}
        >
          <SelectTrigger size="sm" aria-label="Subject kind" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {IMPACT_SUBJECT_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {SUBJECT_KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {kind === 'file' && (
          <Input
            className="h-8 w-64 text-[12px]"
            placeholder="File path, e.g. src/api.ts"
            aria-label="File path"
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onBlur={commitPath}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPath();
            }}
          />
        )}

        {kind === 'run' && (
          <SubjectCombobox
            value={id}
            placeholder="Choose a run…"
            ariaLabel="Run"
            options={runOptions}
            onSelect={setId}
          />
        )}

        {kind === 'task' && (
          <SubjectCombobox
            value={id}
            placeholder="Choose a task…"
            ariaLabel="Task"
            options={taskOptions}
            onSelect={setId}
          />
        )}
      </Toolbar>

      {!hasSubject ? (
        <LiveClaims
          claims={runClaims ?? []}
          overlaps={overlaps}
          titleByRunId={titleByRunId}
        />
      ) : (
        <>
          <ImpactPanel client={data.client} subject={kind} id={id} />

          {status.kind === 'entries' && status.groups.length > 1 && (
            <ReachByHopCard groups={status.groups} />
          )}

          {/* Suppressed entirely on error, and on a reason-carrying 200
              (`no-declared-writes` / `writes-match-nothing`), rather than
              repeating either here: `ImpactPanel` immediately above already
              renders the real failure or the real reason, and a second,
              differently-worded box below it would just invite the two to
              read as disagreeing. What this panel must never do is fall
              back to "No files affected." for either case — see
              `resolveAffectedFilesStatus`. */}
          {status.kind !== 'error' && status.kind !== 'suppressed' && (
            <Panel>
              <PanelHeader count={shownCount}>Affected files</PanelHeader>
              <PanelRow className="flex-col items-stretch gap-1.5">
                <Input
                  className="h-8 text-[12px]"
                  placeholder="Filter by path…"
                  aria-label="Filter affected files by path"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                {entries.length > 0 && (
                  <HintText>
                    {shownCount} of {entries.length} shown
                  </HintText>
                )}
              </PanelRow>

              {status.kind === 'pending' ? (
                <div className="flex flex-col gap-2 p-3">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3.5 w-1/2" />
                </div>
              ) : status.kind === 'empty' ? (
                <EmptyState message={status.message} />
              ) : (
                status.groups.map((group) => {
                  // Controlled off `collapsedHops` — that external `ReadonlySet` stays the
                  // single source of truth, same as TasksListView's groups.
                  const open = !collapsedHops.has(group.hops);
                  return (
                    <PanelRow
                      key={group.hops}
                      className="flex-col items-stretch gap-1.5"
                    >
                      <Collapsible
                        open={open}
                        onOpenChange={() => toggleHop(group.hops)}
                        className="flex flex-col gap-1.5"
                      >
                        <CollapsibleTrigger className="bg-muted hover:bg-secondary dense-meta flex w-full items-center gap-2 rounded px-3 py-1.5 transition-colors duration-150">
                          {open ? (
                            <ChevronUp className="size-3.5 shrink-0" />
                          ) : (
                            <ChevronDown className="size-3.5 shrink-0" />
                          )}
                          <span>
                            {`Hop ${group.hops} · ${group.paths.length} file${
                              group.paths.length === 1 ? '' : 's'
                            }`}
                          </span>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <ul className="flex flex-col gap-1 pl-1">
                            {group.paths.map((path) => (
                              <li key={path}>
                                <PathCrumb path={path} />
                              </li>
                            ))}
                          </ul>
                        </CollapsibleContent>
                      </Collapsible>
                    </PanelRow>
                  );
                })
              )}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
