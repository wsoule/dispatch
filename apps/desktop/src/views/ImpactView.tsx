import type { ImpactEntry, ImpactSubjectKind } from '@dispatch/client';
import { IMPACT_SUBJECT_KINDS } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import { Waypoints } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ImpactPanel } from '../components/impact/ImpactPanel';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { ImpactSubjectRef } from '../lib/appNav';
import { filterByPath, groupByHop } from '../lib/impactGroups';
import {
  EmptyState,
  HintText,
  Panel,
  PanelHeader,
  PanelRow,
} from '@/ui/chrome';
import { CollapseBar } from '@/ui/chrome/collapse-bar';
import { PathCrumb } from '@/ui/chrome/path-crumb';
import { Toolbar } from '@/ui/chrome/toolbar';
import { ViewHeader } from '@/ui/chrome/view-header';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

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

// A stable reference for "nothing fetched yet" so the grouping `useMemo`
// below doesn't re-run every render on a fresh `[]` literal.
const NO_ENTRIES: ImpactEntry[] = [];

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

  const { data: response } = useQuery({
    queryKey: ['impact', data.client?.baseUrl, kind, id],
    queryFn: () => {
      if (data.client === null) throw new Error('no API client');
      return data.client.getImpact(kind, id);
    },
    enabled: data.client !== null && hasSubject,
    retry: false,
  });

  const entries = response?.reach.entries ?? NO_ENTRIES;
  const groups = useMemo(
    () => groupByHop(filterByPath(entries, filter)),
    [entries, filter]
  );
  const shownCount = groups.reduce((n, g) => n + g.paths.length, 0);

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
      <ViewHeader
        title="Impact"
        subtitle="What a file, run, or task's changes could touch"
      />

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
          <Select value={id} onValueChange={setId}>
            <SelectTrigger size="sm" aria-label="Run" className="w-60">
              <SelectValue placeholder="Choose a run…" />
            </SelectTrigger>
            <SelectContent>
              {data.runs.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.taskTitle} · {r.branch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {kind === 'task' && (
          <Select value={id} onValueChange={setId}>
            <SelectTrigger size="sm" aria-label="Task" className="w-60">
              <SelectValue placeholder="Choose a task…" />
            </SelectTrigger>
            <SelectContent>
              {data.tasksIncludingArchived.map((t) => (
                <SelectItem key={t.meta.id} value={t.meta.id}>
                  {t.meta.id} · {t.meta.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Toolbar>

      {!hasSubject ? (
        <EmptyState
          icon={Waypoints}
          message="Pick a file, run, or task to see its blast radius."
        />
      ) : (
        <>
          <ImpactPanel client={data.client} subject={kind} id={id} />

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

            {groups.length === 0 ? (
              <EmptyState
                message={
                  entries.length === 0
                    ? 'No files affected.'
                    : 'No files match that filter.'
                }
              />
            ) : (
              groups.map((group) => (
                <PanelRow
                  key={group.hops}
                  className="flex-col items-stretch gap-1.5"
                >
                  <CollapseBar
                    label={`Hop ${group.hops} · ${group.paths.length} file${
                      group.paths.length === 1 ? '' : 's'
                    }`}
                    collapsed={collapsedHops.has(group.hops)}
                    onToggle={() => toggleHop(group.hops)}
                  />
                  {!collapsedHops.has(group.hops) && (
                    <ul className="flex flex-col gap-1 pl-1">
                      {group.paths.map((path) => (
                        <li key={path}>
                          <PathCrumb path={path} />
                        </li>
                      ))}
                    </ul>
                  )}
                </PanelRow>
              ))
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
