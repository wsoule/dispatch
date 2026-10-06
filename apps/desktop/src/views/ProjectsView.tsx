import type { TaskListItem } from '@dispatch-foo/core/browser';
import { canonicalKind, isContainerKind } from '@dispatch-foo/core/browser';
import {
  Box,
  ChevronRight,
  CircleDot,
  Diamond,
  type LucideIcon,
  Target,
} from 'lucide-react';
import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useShellActions } from '../components/shell/ShellActionsContext';
import { AssigneeAvatar } from '../components/tasks/AssigneeAvatar';
import { StatusIcon } from '../components/tasks/StatusIcon';
import {
  VirtualRows,
  type VirtualRowsHandle,
} from '../components/virtual/VirtualRows';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  readCollapsedGroups,
  toggleCollapsedGroup,
  writeCollapsedGroups,
} from '../lib/collapsedEpics';
import {
  buildProjectTree,
  type ContainerHealth,
  containerHealth,
  expandedByDefault,
  flattenProjectTree,
  type ProjectTree,
  type TreeRollup,
  type TreeRow,
} from '../lib/projectTree';
import { useStatusModelOf } from '../lib/statusModel';
import { dayFromNow, dueDateInfo } from '../lib/taskDates';
import { kindLabel } from '../lib/taskDisplay';
import { stepKey } from '../lib/virtualRows';
import { cn } from '@/lib/utils';
import { ListRow } from '@/ui/ai/list-row';
import { PageHeader } from '@/ui/ai/page-header';
import { LabelPill } from '@/ui/ai/pill';
import { EmptyState, ProgressGlyph } from '@/ui/chrome';

/** Nodes flipped away from their default fold (see `expandedByDefault`), per session. */
export const TOGGLED_PROJECT_NODES_STORAGE_KEY = 'dispatch:projects-toggled';

const ROW_HEIGHT = 36;
const rowHeight = () => ROW_HEIGHT;
const rowKey = (row: TreeRow) => row.key;
const INDENT_PX = 20;

const KIND_ICON: Record<string, LucideIcon> = {
  initiative: Target,
  project: Box,
  milestone: Diamond,
  task: CircleDot,
};

const HEALTH: Record<ContainerHealth, { label: string; color: string }> = {
  done: { label: 'Completed', color: 'var(--status-done)' },
  'off-track': { label: 'Off track', color: 'var(--red)' },
  'at-risk': { label: 'At risk', color: 'var(--amber)' },
  'on-track': { label: 'On track', color: 'var(--green)' },
};

/** The DOM id `aria-activedescendant` names; keys are paths, so they are escaped. */
function rowDomId(key: string): string {
  return `project-row-${key.replaceAll('/', '--')}`;
}

interface ProjectsViewProps {
  projectName: string | null;
  data: DispatchProjectData;
  /** Opens a container's page (its Flight Plan) or an issue's. */
  onOpenTask: (taskId: string) => void;
}

/**
 * Projects: Linear's hierarchy to browse — initiatives, their projects, each project's
 * milestones and the issues under them — as one virtualized tree. A container row carries
 * its progress (issues done of total, by status type), health, target date and lead;
 * an issue row its status and assignee. `j`/`k` move, `l`/`h` expand and collapse (or
 * step into and out of a node), Enter opens the row's page, where a container shows its
 * Flight Plan.
 */
export function ProjectsView({
  projectName,
  data,
  onOpenTask,
}: ProjectsViewProps) {
  const shell = useShellActions();
  const attention = useMemo(
    () => new Set(data.attentionByTaskId.keys()),
    [data.attentionByTaskId]
  );
  const model = useStatusModelOf(data.config);
  const tree = useMemo(
    () => buildProjectTree(data.tasks, attention, model),
    [data.tasks, attention, model]
  );
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() =>
    readCollapsedGroups(TOGGLED_PROJECT_NODES_STORAGE_KEY)
  );
  const rows = useMemo(
    () =>
      flattenProjectTree(
        tree,
        (key, doc) => expandedByDefault(doc) !== toggled.has(key)
      ),
    [tree, toggled]
  );
  const rowByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row])),
    [rows]
  );
  const keys = useMemo(() => rows.map((row) => row.key), [rows]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const virtualRef = useRef<VirtualRowsHandle>(null);
  const today = dayFromNow(0);

  // The cursor stays on a drawn row: the first one, or the nearest surviving ancestor
  // when a fold hides it.
  useEffect(() => {
    if (cursor !== null && rowByKey.has(cursor)) return;
    let next: string | null = cursor;
    while (next !== null && !rowByKey.has(next)) {
      const cut = next.lastIndexOf('/');
      next = cut === -1 ? null : next.slice(0, cut);
    }
    setCursor(next ?? keys[0] ?? null);
  }, [cursor, rowByKey, keys]);

  const daemonReady =
    !data.portLoading && !data.portError && data.client !== null;
  const showTree = daemonReady && rows.length > 0;
  useEffect(() => {
    if (showTree) listEl?.focus();
  }, [showTree, listEl]);

  const toggle = useCallback((key: string) => {
    setToggled((prev) => {
      const next = toggleCollapsedGroup(prev, key);
      writeCollapsedGroups(TOGGLED_PROJECT_NODES_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const moveTo = useCallback((key: string | null) => {
    if (key === null) return;
    setCursor(key);
    virtualRef.current?.scrollToKey(key);
  }, []);

  const open = useCallback(
    (key: string) => {
      const row = rowByKey.get(key);
      if (row !== undefined) onOpenTask(row.id);
    },
    [rowByKey, onOpenTask]
  );

  if (!daemonReady) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const row = cursor === null ? undefined : rowByKey.get(cursor);
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        moveTo(stepKey(keys, cursor, 1));
        return;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        moveTo(stepKey(keys, cursor, -1));
        return;
      case 'l':
      case 'ArrowRight':
        if (row === undefined || !row.expandable) return;
        e.preventDefault();
        if (!row.expanded) toggle(row.key);
        else moveTo(keys[keys.indexOf(row.key) + 1] ?? null);
        return;
      case 'h':
      case 'ArrowLeft':
        if (row === undefined) return;
        e.preventDefault();
        if (row.expanded) toggle(row.key);
        else moveTo(row.parentKey);
        return;
      case 'Enter':
      case 'o':
        if (row === undefined) return;
        e.preventDefault();
        open(row.key);
        return;
    }
  }

  const crumb = [...(projectName === null ? [] : [projectName]), 'Projects'];
  const header = <PageHeader crumb={crumb} />;

  if (!showTree) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <EmptyState
          icon={Box}
          heading="No projects yet"
          description="Initiatives, projects and milestones — made here or synced from Linear — show up as a tree to browse."
          primary={{
            label: 'New project',
            onClick: () => shell.openCreateTask({ kind: 'project' }),
          }}
          className="min-h-0 flex-1"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div
        ref={setListEl}
        role="treegrid"
        aria-label="Projects"
        tabIndex={0}
        aria-activedescendant={cursor === null ? undefined : rowDomId(cursor)}
        onKeyDown={handleKeyDown}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2 outline-none"
      >
        <VirtualRows
          rows={rows}
          rowKey={rowKey}
          estimateSize={rowHeight}
          scrollElement={listEl}
          pinnedKeys={cursor === null ? undefined : [cursor]}
          handleRef={virtualRef}
          renderRow={(row) => (
            <ProjectTreeRow
              row={row}
              tree={tree}
              focused={row.key === cursor}
              today={today}
              onFocus={setCursor}
              onOpen={open}
              onToggle={toggle}
            />
          )}
        />
      </div>
    </div>
  );
}

interface ProjectTreeRowProps {
  row: TreeRow;
  tree: ProjectTree;
  focused: boolean;
  today: string;
  onFocus: (key: string) => void;
  onOpen: (key: string) => void;
  onToggle: (key: string) => void;
}

// One tree row: memoized on its own props, so a cursor move redraws two rows.
const ProjectTreeRow = memo(function ProjectTreeRow({
  row,
  tree,
  focused,
  today,
  onFocus,
  onOpen,
  onToggle,
}: ProjectTreeRowProps) {
  const doc = tree.byId.get(row.id);
  if (doc === undefined) return null;
  const { meta } = doc;
  const container = isContainerKind(meta.kind);
  const Icon = KIND_ICON[canonicalKind(meta.kind)] ?? CircleDot;
  const rollup = tree.rollups.get(row.id);
  return (
    <ListRow
      domId={rowDomId(row.key)}
      data-row-key={row.key}
      data-kind={canonicalKind(meta.kind)}
      aria-level={row.depth + 1}
      aria-expanded={row.expandable ? row.expanded : undefined}
      tabIndex={-1}
      focused={focused}
      onPointerEnter={() => onFocus(row.key)}
      onClick={() => onOpen(row.key)}
      style={{ paddingLeft: 12 + row.depth * INDENT_PX }}
      leading={
        row.expandable ? (
          <button
            type="button"
            aria-label={row.expanded ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(row.key);
            }}
            className="hover:text-foreground flex size-3.5 items-center justify-center"
          >
            <ChevronRight
              className={cn(
                'transition-transform duration-100',
                row.expanded && 'rotate-90'
              )}
            />
          </button>
        ) : (
          <span aria-hidden />
        )
      }
      status={
        container ? (
          <Icon
            aria-label={kindLabel(meta.kind)}
            style={meta.color === null ? undefined : { color: meta.color }}
          />
        ) : (
          <StatusIcon status={meta.status} />
        )
      }
      id={container ? undefined : meta.id}
      title={meta.title}
      trailing={
        container ? (
          <ContainerFacts doc={doc} rollup={rollup} today={today} />
        ) : (
          <AssigneeAvatar assignee={meta.assignee} size={16} />
        )
      }
    />
  );
});

// A container's right side: health, progress, target date, lead.
function ContainerFacts({
  doc,
  rollup,
  today,
}: {
  doc: TaskListItem;
  rollup: TreeRollup | undefined;
  today: string;
}) {
  const { meta } = doc;
  const counts = rollup ?? { done: 0, total: 0, started: 0, attention: 0 };
  const health = containerHealth(doc, counts, today);
  const percent =
    counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100);
  return (
    <span className="flex shrink-0 items-center gap-3">
      {health !== null && (
        <LabelPill
          data-slot="container-health"
          color={HEALTH[health].color}
          title={
            health === 'at-risk'
              ? `${counts.attention} waiting on you or failed`
              : undefined
          }
        >
          {HEALTH[health].label}
        </LabelPill>
      )}
      <span
        data-slot="container-progress"
        aria-label={`${counts.done} of ${counts.total} done`}
        className="flex w-24 items-center gap-1 text-[12px] font-medium text-(--text-secondary) tabular-nums"
      >
        <ProgressGlyph fraction={percent / 100} />
        {counts.done}/{counts.total}
        <span className="text-muted-foreground ml-auto">{percent}%</span>
      </span>
      <span
        data-slot="container-target"
        title="Target date"
        className="text-muted-foreground w-[84px] text-right text-[12px] tabular-nums"
      >
        {meta.dueDate === null || meta.dueDate === undefined
          ? ''
          : dueDateInfo(meta.dueDate).date}
      </span>
      <AssigneeAvatar assignee={meta.assignee} size={16} />
    </span>
  );
}
