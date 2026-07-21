import { useQuery } from '@tanstack/react-query';
import { AlertCircle, History } from 'lucide-react';
import { useMemo, useState } from 'react';

import { formatRelativeTime, sessionDisplayName } from '../lib/format';
import { colorForProject } from '../lib/projectColor';
import { listProjects, listSessions } from '../lib/tauri';
import type { ProjectSummary, Session } from '../lib/types';
import { SessionDetailModal } from './SessionDetailModal';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';

/** `tags` is stored as a JSON array string (e.g. `["bugfix","refactor"]`); fall back to
 * treating the raw string as a single tag if it doesn't parse, rather than hiding it.
 * Kept identical to `SessionDetailModal`'s `parseTags` so the two views never diverge
 * in how they interpret the same stored value. */
function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
    return [tags];
  } catch {
    return [tags];
  }
}

/** Timestamp used for both sorting and date filtering: `started_at` when known, falling
 * back to `last_activity_at` for the rare case a session hasn't recorded a start yet. */
function timelineTimestamp(session: Session): number {
  return session.started_at ?? session.last_activity_at;
}

function projectNameFor(
  projects: ProjectSummary[] | undefined,
  projectId: string
): string {
  return projects?.find((p) => p.id === projectId)?.name ?? projectId;
}

function statusDotClass(status: Session['status']): string {
  return status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/50';
}

type DatePreset = 'all' | 'today' | 'week';

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
];

function isWithinDatePreset(
  timestampSeconds: number,
  preset: DatePreset
): boolean {
  if (preset === 'all') return true;
  const now = new Date();
  if (preset === 'today') {
    const startOfToday =
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() /
      1000;
    return timestampSeconds >= startOfToday;
  }
  // "week": since the start of the current calendar week (Sunday).
  const startOfWeek =
    new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - now.getDay()
    ).getTime() / 1000;
  return timestampSeconds >= startOfWeek;
}

interface TimelineEntryProps {
  session: Session;
  projectName: string;
  onClick: () => void;
}

function TimelineEntry({ session, projectName, onClick }: TimelineEntryProps) {
  const tags = parseTags(session.tags);

  return (
    <button
      onClick={onClick}
      className="border-border bg-card hover:bg-accent/40 flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors"
    >
      <span
        className="mt-1 size-2.5 flex-shrink-0 rounded-full"
        style={{ backgroundColor: colorForProject(session.project_id) }}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground text-[13px] font-medium">
            {projectName}
          </span>
          <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
            <span
              className={`size-1.5 rounded-full ${statusDotClass(session.status)}`}
              aria-hidden="true"
            />
            {session.status}
          </span>
          {tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
          <span className="text-muted-foreground ml-auto text-[11px]">
            {formatRelativeTime(timelineTimestamp(session))}
          </span>
        </div>
        <div className="text-muted-foreground truncate text-[13px]">
          {sessionDisplayName(session.title, session.summary)}
        </div>
      </div>
    </button>
  );
}

export function TimelineView() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');

  const {
    data: sessions,
    isLoading,
    isError,
  } = useQuery({ queryKey: ['sessions'], queryFn: listSessions });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  const availableTags = useMemo(() => {
    if (!sessions) return [];
    const tagSet = new Set<string>();
    for (const session of sessions) {
      for (const tag of parseTags(session.tags)) {
        tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort();
  }, [sessions]);

  const sortedAndFiltered = useMemo(() => {
    if (!sessions) return [];
    return sessions
      .filter((session) => {
        if (projectFilter !== 'all' && session.project_id !== projectFilter) {
          return false;
        }
        if (
          tagFilter !== 'all' &&
          !parseTags(session.tags).includes(tagFilter)
        ) {
          return false;
        }
        if (!isWithinDatePreset(timelineTimestamp(session), datePreset)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => timelineTimestamp(b) - timelineTimestamp(a));
  }, [sessions, projectFilter, tagFilter, datePreset]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-foreground text-[15px] font-medium">Timeline</h1>

      {isLoading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {isError && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <AlertCircle className="text-destructive size-5" />
          <p className="text-muted-foreground text-[13px]">
            Couldn&rsquo;t load sessions. Is the backend running?
          </p>
        </div>
      )}

      {!isLoading && !isError && (!sessions || sessions.length === 0) && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <History className="text-muted-foreground size-5" />
          <p className="text-muted-foreground max-w-sm text-[13px]">
            No sessions yet — start a Claude Code session in any repo and it
            will appear here.
          </p>
        </div>
      )}

      {!isLoading && !isError && sessions && sessions.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={projectFilter} onValueChange={setProjectFilter}>
              <SelectTrigger size="sm" aria-label="Filter by project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects?.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={tagFilter} onValueChange={setTagFilter}>
              <SelectTrigger size="sm" aria-label="Filter by tag">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tags</SelectItem>
                {availableTags.map((tag) => (
                  <SelectItem key={tag} value={tag}>
                    {tag}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div
              className="flex gap-1"
              role="group"
              aria-label="Filter by date"
            >
              {DATE_PRESETS.map((preset) => (
                <Button
                  key={preset.value}
                  type="button"
                  variant={
                    datePreset === preset.value ? 'default' : 'secondary'
                  }
                  size="sm"
                  onClick={() => setDatePreset(preset.value)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>

          {sortedAndFiltered.length === 0 ? (
            <p className="text-muted-foreground text-[13px]">
              No sessions match the current filters.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {sortedAndFiltered.map((session) => (
                <TimelineEntry
                  key={session.id}
                  session={session}
                  projectName={projectNameFor(projects, session.project_id)}
                  onClick={() => setSelectedSessionId(session.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <SessionDetailModal
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
