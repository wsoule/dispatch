import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { Button } from '../components/ui/Button';
import { Pill } from '../components/ui/Pill';
import { Select } from '../components/ui/Select';
import { formatRelativeTime, sessionDisplayName } from '../lib/format';
import { colorForProject } from '../lib/projectColor';
import { listProjects, listSessions } from '../lib/tauri';
import type { ProjectSummary, Session } from '../lib/types';
import { SessionDetailModal } from './SessionDetailModal';
import './TimelineView.css';

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

type DatePreset = 'all' | 'today' | 'week';

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
    <button className="timeline-entry" onClick={onClick}>
      <span
        className="timeline-entry-dot"
        style={{ backgroundColor: colorForProject(session.project_id) }}
        aria-hidden="true"
      />
      <div className="timeline-entry-main">
        <div className="timeline-entry-top">
          <span className="timeline-entry-project">{projectName}</span>
          <Pill
            variant="status"
            tone={session.status === 'active' ? 'green' : 'gray'}
          >
            {session.status}
          </Pill>
          {tags.map((tag) => (
            <Pill key={tag} variant="tag">
              {tag}
            </Pill>
          ))}
          <span className="timeline-entry-time">
            {formatRelativeTime(timelineTimestamp(session))}
          </span>
        </div>
        <div className="timeline-entry-summary">
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
    <div className="timeline-view">
      <div className="view-topbar">
        <h1 className="view-topbar-title">Timeline</h1>
      </div>

      {isLoading && <p className="timeline-view-status">Loading timeline…</p>}

      {isError && (
        <p className="timeline-view-status">
          Couldn't load sessions. Is the backend running?
        </p>
      )}

      {!isLoading && !isError && (!sessions || sessions.length === 0) && (
        <p className="timeline-view-status">
          No sessions yet — start a Claude Code session in any repo and it will
          appear here.
        </p>
      )}

      {!isLoading && !isError && sessions && sessions.length > 0 && (
        <>
          <div className="timeline-filters">
            <Select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              aria-label="Filter by project"
            >
              <option value="all">All projects</option>
              {projects?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>

            <Select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              aria-label="Filter by tag"
            >
              <option value="all">All tags</option>
              {availableTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </Select>

            <div
              className="timeline-filter-presets"
              role="group"
              aria-label="Filter by date"
            >
              {(['all', 'today', 'week'] as const).map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant="secondary"
                  className={
                    datePreset === preset
                      ? 'timeline-filter-preset-active'
                      : undefined
                  }
                  onClick={() => setDatePreset(preset)}
                >
                  {preset === 'all'
                    ? 'All time'
                    : preset === 'today'
                      ? 'Today'
                      : 'This week'}
                </Button>
              ))}
            </div>
          </div>

          {sortedAndFiltered.length === 0 ? (
            <p className="timeline-view-status">
              No sessions match the current filters.
            </p>
          ) : (
            <div className="timeline-list">
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
