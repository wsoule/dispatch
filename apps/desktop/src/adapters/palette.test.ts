import type {
  Progress,
  TimelineBar,
  TimelineLane,
  TimelineView,
} from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';
import { ArrowRight, BookText, CircleDashed, Play, Zap } from 'lucide-react';
import { createElement } from 'react';

import type { PaletteEntry } from '../lib/paletteEntries';
import { parseHref, taskHref, timelineHref } from '../lib/routes';
import {
  buildJumpToItems,
  JUMP_TO_SECTION,
  laneMark,
  PALETTE_DOCS_LIMIT,
  PALETTE_SECTION_CAPS,
  PALETTE_SECTION_ORDER,
  paletteKeys,
  toPaletteItems,
} from './palette';
import { noProjectId } from './workspaceData';

// Hand-built planning view models (Wed Oct 21, 2026): only the fields the
// palette reads are meaningful.

const TODAY = '2026-10-21';
const HREFS = { task: taskHref, timeline: timelineHref };

function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    total: 4,
    completed: 1,
    canceled: 0,
    scope: 4,
    open: 3,
    openUnassigned: 0,
    openTriage: 0,
    ...overrides,
  };
}

function bar(overrides: Partial<TimelineBar> = {}): TimelineBar {
  return {
    milestoneId: 'ms-1',
    name: 'Dual-write',
    projectId: 'proj-1',
    start: '2026-10-01',
    end: '2026-10-28',
    status: 'on_track',
    reasons: [],
    rubric: { valid: true, gaps: [] },
    doneMeans: { text: 'Both stores agree', source: 'planner' },
    progress: progress(),
    isNext: true,
    daysLeft: 7,
    weight: null,
    ...overrides,
  };
}

function lane(overrides: Partial<TimelineLane> = {}): TimelineLane {
  return {
    projectId: 'proj-1',
    name: 'Atlas billing migration',
    url: '',
    leadId: 'user-chloe',
    leadName: 'Chloe Diaz',
    priority: 1,
    statusType: 'started',
    active: true,
    bars: [bar()],
    undated: [],
    unplannedIssueIds: [],
    allocation: null,
    ...overrides,
  };
}

function view(lanes: TimelineLane[]): TimelineView {
  return {
    today: TODAY,
    windowStart: '2026-10-07',
    windowEnd: '2026-12-30',
    groups: [{ initiativeId: 'init-1', name: 'Platform', lanes }],
    banners: {
      projectsWithoutLead: [],
      milestonesWithoutDate: [],
      issuesWithoutMilestone: { count: 0, byProject: [] },
      blockedProjects: [],
    },
  };
}

function entry(overrides: Partial<PaletteEntry> = {}): PaletteEntry {
  return {
    id: 'task-t-1',
    label: 'Wire the thing',
    sublabel: 't-1',
    kind: 'task',
    section: 'tasks',
    run: () => undefined,
    ...overrides,
  };
}

describe('paletteKeys', () => {
  test('splits a printed shortcut into caps, the modifier glyph becoming the platform label', () => {
    expect(paletteKeys('G L', 'Ctrl')).toEqual(['G', 'L']);
    expect(paletteKeys('C', 'Ctrl')).toEqual(['C']);
    expect(paletteKeys('?', 'Ctrl')).toEqual(['?']);
    expect(paletteKeys('⌘1', 'Ctrl')).toEqual(['Ctrl', '1']);
    expect(paletteKeys('⌘,', '⌘')).toEqual(['⌘', ',']);
    expect(paletteKeys('⌘D', 'Ctrl')).toEqual(['Ctrl', 'D']);
  });
});

describe('toPaletteItems', () => {
  test('maps every entry field: heading, hint, keys, href, run as onSelect, default icons', () => {
    const ran: string[] = [];
    const items = toPaletteItems(
      [
        entry({ run: () => ran.push('task') }),
        entry({
          id: 'dispatch-t-1',
          label: 'Dispatch Wire the thing',
          kind: 'action',
        }),
        entry({
          id: 'go-overseer',
          label: 'Go to Overseer',
          sublabel: undefined,
          kind: 'go to',
          section: 'navigation',
          shortcut: '⌘1',
          href: '#/overseer',
        }),
        entry({
          id: 'action-new-task',
          label: 'New task',
          sublabel: undefined,
          kind: 'action',
          section: 'actions',
          shortcut: 'C',
        }),
        entry({
          id: 'doc:d-1#top',
          label: 'Board spec',
          sublabel: 'board',
          kind: 'doc',
          section: 'docs',
        }),
      ],
      { modLabel: 'Ctrl' }
    );
    expect(items.map((i) => i.section)).toEqual([
      'Tasks',
      'Tasks',
      'Navigation',
      'Actions',
      'Docs',
    ]);
    expect(items.map((i) => i.icon)).toEqual([
      CircleDashed,
      Play,
      ArrowRight,
      Zap,
      BookText,
    ]);
    expect(items[0]).toMatchObject({
      id: 'task-t-1',
      label: 'Wire the thing',
      hint: 't-1',
    });
    expect(items[0]?.shortcut).toBeUndefined();
    expect(items[0]?.href).toBeUndefined();
    expect(items[0]?.matched).toBeUndefined();
    items[0]?.onSelect?.();
    expect(ran).toEqual(['task']);
    expect(items[2]).toMatchObject({
      shortcut: ['Ctrl', '1'],
      href: '#/overseer',
    });
    expect(items[2]?.hint).toBeUndefined();
    expect(items[3]?.shortcut).toEqual(['C']);
  });

  test('an entry with its own icon keeps it; matched marks every item', () => {
    const icon = createElement(BookText);
    const [own, plain] = toPaletteItems(
      [entry({ icon }), entry({ id: 'task-t-2' })],
      { modLabel: '⌘', matched: true }
    );
    expect(own?.icon).toBe(icon);
    expect(plain?.icon).toBe(CircleDashed);
    expect(own?.matched).toBe(true);
    expect(plain?.matched).toBe(true);
  });

  test('the section order keeps the old headings in order, with Jump to beside Tasks', () => {
    expect(PALETTE_SECTION_ORDER).toEqual([
      'Inbox',
      'Tasks',
      JUMP_TO_SECTION,
      'Docs',
      'Views',
      'Navigation',
      'Actions',
    ]);
  });
});

describe('laneMark', () => {
  test("is the next milestone's mark, else done when all are complete, else missing", () => {
    expect(laneMark(lane())).toEqual({ status: 'on_track', label: 'On track' });
    expect(
      laneMark(
        lane({
          bars: [
            bar({ status: 'on_track', rubric: { valid: false, gaps: [] } }),
          ],
        })
      )
    ).toEqual({ status: 'missing', label: 'Missing input' });
    expect(
      laneMark(lane({ bars: [bar({ status: 'complete', isNext: false })] }))
    ).toEqual({ status: 'done', label: 'All milestones complete' });
    expect(laneMark(lane({ bars: [] }))).toEqual({
      status: 'missing',
      label: 'No milestones',
    });
  });
});

describe('buildJumpToItems', () => {
  const atlas = lane({
    bars: [
      bar(),
      bar({
        milestoneId: 'ms-0',
        name: 'Schema freeze',
        status: 'complete',
        end: '2026-10-01',
        isNext: false,
      }),
    ],
    undated: [
      bar({
        milestoneId: 'ms-u',
        name: 'Dashboards',
        end: null,
        status: 'unscheduled',
        isNext: false,
      }),
    ],
  });
  const beacon = lane({
    projectId: 'proj-2',
    name: 'Beacon search',
    leadId: null,
    leadName: null,
    active: false,
    statusType: 'paused',
    bars: [
      bar({
        milestoneId: 'ms-b',
        name: 'Index rebuild',
        projectId: 'proj-2',
        status: 'overdue',
        end: '2027-01-04',
        daysLeft: -3,
      }),
    ],
  });
  const items = buildJumpToItems(view([atlas, beacon]), HREFS);

  test('lists every lane, then every bar (dated and undated), all under Jump to', () => {
    expect(items.map((i) => i.id)).toEqual([
      'project:proj-1',
      'project:proj-2',
      'milestone:ms-1',
      'milestone:ms-0',
      'milestone:ms-u',
      'milestone:ms-b',
    ]);
    expect(new Set(items.map((i) => i.section))).toEqual(
      new Set([JUMP_TO_SECTION])
    );
    for (const item of items) {
      expect(item.onSelect).toBeUndefined();
      expect(item.status).toBeDefined();
    }
  });

  test("a project row opens the project's Timeline lane, marked like the sidebar, with its lead", () => {
    expect(items[0]).toEqual({
      id: 'project:proj-1',
      label: 'Atlas billing migration',
      hint: 'Project · Chloe Diaz',
      section: JUMP_TO_SECTION,
      href: '#/timeline?project=proj-1',
      status: 'on_track',
      statusLabel: 'On track',
    });
    expect(parseHref(items[0]?.href ?? '')).toEqual([
      { type: 'openTimeline', project: 'proj-1' },
    ]);
    expect(items[1]?.hint).toBe('Project · No lead');
  });

  test('a milestone row says when it is due, is complete, or has no date, with the year only when it differs', () => {
    expect(items[2]).toMatchObject({
      label: 'Dual-write',
      hint: 'Atlas billing migration · due Oct 28',
      href: '#/task/ms-1',
      status: 'on_track',
      statusLabel: 'On track',
    });
    expect(items[3]).toMatchObject({
      hint: 'Atlas billing migration · complete · Oct 1',
      status: 'done',
      statusLabel: 'Complete',
    });
    expect(items[4]).toMatchObject({
      hint: 'Atlas billing migration · no target date',
      status: 'missing',
      statusLabel: 'No target date',
    });
    expect(items[5]?.hint).toBe('Beacon search · due Jan 4, 2027');
  });

  test("an inactive lane's rows are muted and say so in the mark's label", () => {
    expect(items[1]).toMatchObject({
      status: 'overdue',
      statusLabel: 'Overdue · inactive project',
      statusMuted: true,
    });
    expect(items[5]).toMatchObject({
      status: 'overdue',
      statusLabel: 'Overdue · inactive project',
      statusMuted: true,
    });
    expect(items[0]?.statusMuted).toBeUndefined();
  });

  test('an empty timeline makes no rows', () => {
    expect(buildJumpToItems(view([]), HREFS)).toEqual([]);
  });

  test('the synthetic "No project" lane has no project row; its loose milestones keep theirs', () => {
    const loose = lane({
      projectId: noProjectId('init-1'),
      name: 'No project',
      leadId: null,
      leadName: null,
      active: false,
      statusType: 'backlog',
      bars: [
        bar({
          milestoneId: 'ms-loose',
          name: 'Loose milestone',
          projectId: noProjectId('init-1'),
        }),
      ],
    });
    const rows = buildJumpToItems(view([atlas, loose]), HREFS);
    expect(rows.map((i) => i.id)).toEqual([
      'project:proj-1',
      'milestone:ms-1',
      'milestone:ms-0',
      'milestone:ms-u',
      'milestone:ms-loose',
    ]);
    expect(rows[4]).toMatchObject({
      href: '#/task/ms-loose',
      hint: 'No project · due Oct 28',
    });
  });
});

describe('PALETTE_SECTION_CAPS', () => {
  test("keeps the old sectioned menu's caps, Jump to like Tasks, with navigation and actions unbounded", () => {
    expect(PALETTE_SECTION_CAPS).toEqual({
      Inbox: 3,
      Tasks: 8,
      [JUMP_TO_SECTION]: 8,
      Docs: PALETTE_DOCS_LIMIT,
      Views: 4,
      Navigation: Number.POSITIVE_INFINITY,
      Actions: Number.POSITIVE_INFINITY,
    });
    for (const heading of PALETTE_SECTION_ORDER) {
      expect(PALETTE_SECTION_CAPS[heading]).toBeDefined();
    }
  });
});
