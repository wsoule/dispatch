import type { TaskDoc } from '@dispatch/core';
import {
  ChevronsUp,
  ListTodo,
  Plus,
  Search,
  SearchX,
  SignalHigh,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { RunStatePill } from '../components/runs/RunStatePill';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { resolveListKeyCommand } from '../lib/keyboard';
import { priorityTone, statusTone } from '../lib/taskDisplay';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Skeleton } from '../ui/skeleton';

interface TasksListViewProps {
  data: DispatchProjectData;
  onSelectTask: (taskId: string) => void;
  onNewTask: () => void;
}

/** Case-insensitive substring match against a task's id and title — the list view's filter
 * is a plain narrowing search, not the palette's fuzzy ranking (a dense flat list benefits
 * more from a predictable "contains" filter than from fuzzy re-ordering). */
function matchesFilter(doc: TaskDoc, filter: string): boolean {
  if (filter.trim() === '') return true;
  const needle = filter.toLowerCase();
  return (
    doc.meta.id.toLowerCase().includes(needle) ||
    doc.meta.title.toLowerCase().includes(needle)
  );
}

// Maps a `statusTone`/`priorityTone` result to the small dot's background color — the same
// six-tone vocabulary `Pill` used, just rendered as a dot instead of a filled chip per the
// Linear redesign's "status is a dot, not a pill" direction.
function toneDotClass(tone: string): string {
  switch (tone) {
    case 'green':
      return 'bg-emerald-500';
    case 'blue':
      return 'bg-blue-500';
    case 'red':
      return 'bg-destructive';
    case 'amber':
      return 'bg-amber-500';
    case 'accent':
      return 'bg-primary';
    default:
      return 'bg-muted-foreground/50';
  }
}

// Small lucide icon in place of the old priority text pill. `priorityTone` already encodes
// the "only urgent/high deserve a color treatment" decision (see lib/taskDisplay.ts) — this
// just picks the icon + color for the (only ever) two tones it actually returns; typed as a
// plain string rather than importing `Tone` (unexported from lib/taskDisplay.ts).
function PriorityIcon({ tone }: { tone: string }) {
  const isUrgent = tone === 'red';
  const Icon = isUrgent ? ChevronsUp : SignalHigh;
  const colorClass = isUrgent ? 'text-destructive' : 'text-amber-500';
  return <Icon className={`size-3.5 shrink-0 ${colorClass}`} />;
}

/**
 * Flat, filterable list of every task in the active project — the "Tasks" primary nav item,
 * complementing the Board's column view when you want to scan or search rather than group by
 * status. Supports the redesign brief's j/k + Enter list navigation directly on the row
 * list (only while the filter input itself isn't focused, so "j"/"k" keep working as
 * ordinary filter-text characters while typing). The list container auto-focuses itself on
 * mount (view enter) so j/k work immediately without first requiring a click or Tab.
 */
export function TasksListView({
  data,
  onSelectTask,
  onNewTask,
}: TasksListViewProps) {
  const [filter, setFilter] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => data.tasks.filter((doc) => matchesFilter(doc, filter)),
    [data.tasks, filter]
  );

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // Keeps the highlighted row visible as j/k moves it — `listRef`'s direct children are the
  // row buttons in list order, so the highlighted index doubles as a DOM child index.
  useEffect(() => {
    const row = listRef.current?.children[highlighted];
    row?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  function handleListKeyDown(e: React.KeyboardEvent) {
    const command = resolveListKeyCommand(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
      { isTyping: false }
    );
    if (command === 'list-down') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (command === 'list-up') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (command === 'list-confirm') {
      e.preventDefault();
      const doc = filtered[highlighted];
      if (doc !== undefined) onSelectTask(doc.meta.id);
    }
  }

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  if (data.tasksLoading || data.config === null) {
    return (
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-foreground text-[15px] font-medium">Tasks</h1>
          <Skeleton className="h-8 w-24" />
        </div>
        <Skeleton className="h-9 w-full" />
        <div className="border-border flex flex-col gap-px overflow-hidden rounded-md border">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2.5">
              <Skeleton className="h-3 w-10 shrink-0" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-4 w-14 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-foreground text-[15px] font-medium">Tasks</h1>
        <Button size="sm" onClick={onNewTask}>
          <Plus className="size-3.5" />
          New task
        </Button>
      </div>

      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          className="pl-8 text-[13px]"
          placeholder="Filter by id or title…"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setHighlighted(0);
          }}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          {data.tasks.length === 0 ? (
            <>
              <ListTodo className="text-muted-foreground size-5" />
              <p className="text-muted-foreground max-w-sm text-[13px]">
                No tasks yet — create the first one from the Board.
              </p>
              <Button size="sm" onClick={onNewTask}>
                <Plus className="size-3.5" />
                New task
              </Button>
            </>
          ) : (
            <>
              <SearchX className="text-muted-foreground size-5" />
              <p className="text-muted-foreground text-[13px]">
                No tasks match this filter.
              </p>
            </>
          )}
        </div>
      ) : (
        <div
          className="border-border flex flex-col overflow-hidden rounded-md border"
          ref={listRef}
          tabIndex={0}
          onKeyDown={handleListKeyDown}
        >
          {filtered.map((doc, i) => {
            const tone = priorityTone(doc.meta.priority);
            const liveState = data.liveRunStateByTaskId.get(doc.meta.id);
            return (
              <button
                key={doc.meta.id}
                type="button"
                className={`border-border flex w-full items-center gap-3 border-b px-3 py-2.5 text-left transition-colors duration-150 last:border-b-0 ${
                  i === highlighted ? 'bg-accent' : 'bg-card hover:bg-accent/60'
                }`}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => onSelectTask(doc.meta.id)}
              >
                <span className="text-muted-foreground w-16 shrink-0 font-mono text-[11px]">
                  {doc.meta.id}
                </span>
                <span className="text-foreground min-w-0 flex-1 truncate text-[13px]">
                  {doc.meta.title}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {data.blockedIds.has(doc.meta.id) && (
                    <Badge
                      variant="outline"
                      className="border-destructive/30 text-destructive text-[11px]"
                    >
                      blocked
                    </Badge>
                  )}
                  {tone !== null && <PriorityIcon tone={tone} />}
                  {liveState !== undefined && (
                    <RunStatePill state={liveState} />
                  )}
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${toneDotClass(
                        statusTone(doc.meta.status)
                      )}`}
                    />
                    <span className="text-muted-foreground text-[11px]">
                      {doc.meta.status}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
