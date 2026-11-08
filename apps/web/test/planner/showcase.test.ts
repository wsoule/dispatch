// Pins down the showcase demo workspace (LINEAR_FIXTURE=showcase): that it
// contains the base workspace unchanged, its size against the targets and
// the graph's draw limits, every reference, determinism, the milestone
// scenarios, the shape of the blocking graph (flow rules, the designed
// cycles and nothing else, the critical path, hubs, linked and unlinked
// work everywhere), the guest's view, the issue-page content and the
// store. Graph checks go through core's real builder, so the demo is
// proven to build at every level with exactly the designed cycles.

import {
  assessWorkspace,
  buildDependencyGraph,
  DEFAULT_TUNING,
  estimateOptions,
  type EvalContext,
  type GraphScope,
  homeInitiativeIds,
  indexWorkspace,
  type Issue,
  type MilestoneMeta,
  type Snapshot,
  type WorkspaceData,
} from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import { createFixtureIssueDetails } from '../../src/planner/linear/fixture-details.js';
import {
  createFixtureGateway,
  createFixtureStore,
  createFixtureWorkspace,
  FIXTURE_GUEST_USER_ID,
  FIXTURE_MILESTONE_META,
  FIXTURE_WORKSPACE,
} from '../../src/planner/linear/fixture.js';
import {
  createDemoStore,
  createShowcaseIssueDetails,
  createShowcaseStore,
  createShowcaseWorkspace,
  demoMilestoneMeta,
  SHOWCASE_CRITICAL_PATH,
  SHOWCASE_CYCLES,
  SHOWCASE_MILESTONE_META,
} from '../../src/planner/linear/showcase.js';

const TODAY = '2026-10-21';
const DAY_MS = 86_400_000;

const data: WorkspaceData = createShowcaseWorkspace(TODAY);
const base: WorkspaceData = createFixtureWorkspace(TODAY);
const snapshot: Snapshot = indexWorkspace(data);
const stateType = new Map(data.states.map((s) => [s.id, s.type]));
const issueById = new Map(data.issues.map((i) => [i.id, i]));
const byIdentifier = new Map(data.issues.map((i) => [i.identifier, i]));
const milestoneById = new Map(data.milestones.map((m) => [m.id, m]));
const baseIssueIds = new Set(base.issues.map((i) => i.id));
const baseMilestoneIds = new Set(base.milestones.map((m) => m.id));

function isOpen(issue: Issue): boolean {
  return ['triage', 'backlog', 'unstarted', 'started'].includes(
    stateType.get(issue.stateId) ?? ''
  );
}

function issue(identifier: string): Issue {
  const found = byIdentifier.get(identifier);
  if (found === undefined) throw new Error(`no issue ${identifier}`);
  return found;
}

function identifierOf(id: string): string {
  return issueById.get(id)?.identifier ?? id;
}

function evalContext(today = TODAY): EvalContext {
  return {
    today,
    now: `${today}T12:00:00.000Z`,
    tuning: DEFAULT_TUNING,
    meta: new Map<string, MilestoneMeta>(
      SHOWCASE_MILESTONE_META.map((m) => [
        m.milestoneId,
        { ...m, updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: null },
      ])
    ),
  };
}

const ctx = evalContext();
const assessments = assessWorkspace(snapshot, ctx);

/** Tarjan's strongly connected components of size > 1, as identifiers. */
function cyclesOf(
  nodes: readonly string[],
  edges: readonly [string, string][]
): string[][] {
  const next = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) next.get(from)?.push(to);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  let counter = 0;
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) out.push(component.sort());
    }
  };
  for (const n of nodes) if (!index.has(n)) visit(n);
  return sortedCycles(out);
}

/** Cycles as sorted member lists, in one order, so lists compare. */
function sortedCycles(cycles: readonly (readonly string[])[]): string[][] {
  return cycles
    .map((cycle) => [...cycle].sort())
    .sort((a, b) => a.join().localeCompare(b.join()));
}

const relationPairs: [string, string][] = data.relations.map((r) => [
  identifierOf(r.blockerId),
  identifierOf(r.blockedId),
]);

function graph(scope: GraphScope, snap: Snapshot = snapshot) {
  const graphAssessments =
    snap === snapshot ? assessments : assessWorkspace(snap, ctx);
  return buildDependencyGraph(snap, ctx, graphAssessments, scope);
}

describe('showcase: the base workspace is inside it, unchanged', () => {
  test('every base entity is in the showcase, deep-equal', () => {
    const pick = <T extends { id: string }>(
      list: readonly T[],
      ids: Iterable<string>
    ): T[] => {
      const byId = new Map(list.map((x) => [x.id, x]));
      return [...ids].map((id) => byId.get(id) as T);
    };
    expect(data.workspaceId).toBe(base.workspaceId);
    for (const key of [
      'users',
      'states',
      'initiatives',
      'projects',
      'milestones',
      'issues',
      'relations',
    ] as const) {
      const ours = data[key] as readonly { id: string }[];
      const theirs = base[key] as readonly { id: string }[];
      expect(
        pick(
          ours,
          theirs.map((x) => x.id)
        )
      ).toEqual([...theirs]);
    }
  });

  test('base teams keep their fields and members, and only gain members', () => {
    for (const team of base.teams) {
      const grown = data.teams.find((t) => t.id === team.id);
      expect({ ...grown, memberIds: undefined }).toEqual({
        ...team,
        memberIds: undefined,
      });
      expect(grown?.memberIds?.slice(0, team.memberIds?.length)).toEqual(
        team.memberIds
      );
    }
  });

  test('base issue-page content and meta rows are kept', () => {
    const baseDetails = createFixtureIssueDetails(TODAY);
    const details = createShowcaseIssueDetails(TODAY);
    for (const [id, fields] of Object.entries(baseDetails.issueFields)) {
      expect(details.issueFields[id]).toEqual(fields);
    }
    expect(details.labels.slice(0, baseDetails.labels.length)).toEqual(
      baseDetails.labels
    );
    expect(
      details.seededComments.slice(0, baseDetails.seededComments.length)
    ).toEqual(baseDetails.seededComments);
    expect(
      SHOWCASE_MILESTONE_META.slice(0, FIXTURE_MILESTONE_META.length)
    ).toEqual(FIXTURE_MILESTONE_META);
  });
});

describe('showcase: size, against the targets and the draw limits', () => {
  const open = data.issues.filter(isOpen);
  const canceled = data.issues.filter(
    (i) => stateType.get(i.stateId) === 'canceled'
  );

  test('a mid-size company: people, teams, initiatives, projects, milestones', () => {
    expect(data.users.length).toBeGreaterThanOrEqual(18);
    expect(data.users.length).toBeLessThanOrEqual(25);
    expect(data.users.filter((u) => u.guest === true).map((u) => u.id)).toEqual(
      [FIXTURE_GUEST_USER_ID]
    );
    expect(data.users.filter((u) => u.app)).toHaveLength(1);
    expect(data.teams.map((t) => t.key)).toEqual(['ENG', 'OPS', 'DATA', 'GRO']);
    expect(data.initiatives).toHaveLength(4);
    expect(data.projects.length).toBeGreaterThanOrEqual(16);
    expect(data.projects.length).toBeLessThanOrEqual(22);
    expect(data.milestones.length).toBeGreaterThanOrEqual(55);
    expect(data.milestones.length).toBeLessThanOrEqual(75);
  });

  test('a ton of issues, about 70% open, in every state and priority', () => {
    expect(data.issues.length).toBeGreaterThanOrEqual(350);
    expect(data.issues.length).toBeLessThanOrEqual(450);
    const openShare = open.length / data.issues.length;
    expect(openShare).toBeGreaterThan(0.65);
    expect(openShare).toBeLessThan(0.8);
    const names = new Set(
      data.issues.map(
        (i) => data.states.find((s) => s.id === i.stateId)?.name ?? ''
      )
    );
    expect([...names].sort()).toEqual([
      'Backlog',
      'Canceled',
      'Done',
      'Duplicate',
      'In Progress',
      'In Review',
      'Todo',
      'Triage',
    ]);
    expect(new Set(data.issues.map((i) => i.priority))).toEqual(
      new Set([0, 1, 2, 3, 4])
    );
    expect(open.filter((i) => i.assigneeId === null).length).toBeGreaterThan(
      80
    );
    expect(open.filter((i) => i.assigneeId !== null).length).toBeGreaterThan(
      120
    );
  });

  test('220-290 blocking relations', () => {
    expect(data.relations.length).toBeGreaterThanOrEqual(220);
    expect(data.relations.length).toBeLessThanOrEqual(290);
  });

  // Every level draws every item in scope (owner decision 2026-10-23, "the
  // graph is there to show all issues"): every non-canceled issue, every
  // milestone, project and initiative. The whole workspace's issue level
  // must fit the raised draw limits with room to spare.
  test('every level fits the draw limits (450 boxes, 600 arrows at most)', () => {
    const issueBoxes = data.issues.length - canceled.length;
    expect(issueBoxes).toBeLessThanOrEqual(450);
    expect(data.relations.length).toBeLessThanOrEqual(600);
    expect({
      issue: issueBoxes,
      milestone: data.milestones.length,
      project: data.projects.length,
      initiative: data.initiatives.length,
    }).toEqual({ issue: 406, milestone: 67, project: 21, initiative: 4 });
  });
});

describe('showcase: references, timestamps and names', () => {
  test('ids are unique across every entity', () => {
    const ids = [
      ...data.users.map((x) => x.id),
      ...data.teams.map((x) => x.id),
      ...data.states.map((x) => x.id),
      ...data.initiatives.map((x) => x.id),
      ...data.projects.map((x) => x.id),
      ...data.milestones.map((x) => x.id),
      ...data.issues.map((x) => x.id),
      ...data.relations.map((x) => x.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    const identifiers = data.issues.map((i) => i.identifier);
    expect(new Set(identifiers).size).toBe(identifiers.length);
  });

  test('every foreign id resolves the way Linear allows', () => {
    const users = new Set(data.users.map((u) => u.id));
    const teams = new Set(data.teams.map((t) => t.id));
    const initiatives = new Set(data.initiatives.map((i) => i.id));
    for (const team of data.teams) {
      for (const member of team.memberIds ?? []) {
        expect(users.has(member)).toBe(true);
      }
    }
    for (const state of data.states) expect(teams.has(state.teamId)).toBe(true);
    for (const project of data.projects) {
      if (project.leadId !== null) expect(users.has(project.leadId)).toBe(true);
      for (const id of project.initiativeIds) {
        expect(initiatives.has(id)).toBe(true);
      }
      for (const id of project.teamIds) expect(teams.has(id)).toBe(true);
    }
    for (const milestone of data.milestones) {
      expect(snapshot.projects.has(milestone.projectId)).toBe(true);
    }
    for (const i of data.issues) {
      expect(teams.has(i.teamId)).toBe(true);
      expect(data.states.find((s) => s.id === i.stateId)?.teamId).toBe(
        i.teamId
      );
      if (i.assigneeId !== null) expect(users.has(i.assigneeId)).toBe(true);
      if (i.projectId === null) {
        // The real sync mirrors only open issues without a project.
        expect(isOpen(i)).toBe(true);
        expect(i.milestoneId).toBeNull();
        continue;
      }
      const project = snapshot.projects.get(i.projectId);
      expect(project?.teamIds).toContain(i.teamId);
      if (i.milestoneId !== null) {
        expect(milestoneById.get(i.milestoneId)?.projectId).toBe(i.projectId);
      }
    }
    for (const r of data.relations) {
      expect(issueById.has(r.blockerId)).toBe(true);
      expect(issueById.has(r.blockedId)).toBe(true);
      expect(r.blockerId).not.toBe(r.blockedId);
    }
    const pairs = relationPairs.map(([a, b]) => `${a}>${b}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  test('no project is closed (the real sync mirrors none)', () => {
    for (const project of data.projects) {
      expect(['completed', 'canceled']).not.toContain(project.statusType);
    }
  });

  test('timestamps are consistent and never today or later', () => {
    const midnight = Date.parse(`${TODAY}T00:00:00.000Z`);
    for (const i of data.issues) {
      const created = Date.parse(i.createdAt);
      expect(Date.parse(i.lastStateChangeAt)).toBeGreaterThanOrEqual(created);
      expect(Date.parse(i.updatedAt)).toBeGreaterThanOrEqual(
        Date.parse(i.lastStateChangeAt)
      );
      expect(Date.parse(i.updatedAt)).toBeLessThan(midnight);
      const type = stateType.get(i.stateId);
      expect(i.completedAt !== null).toBe(type === 'completed');
      expect(i.canceledAt !== null).toBe(type === 'canceled');
      if (type === 'started' || type === 'completed') {
        expect(i.startedAt).not.toBeNull();
      }
    }
  });

  test('fictional: Northwind URLs and emails, no names from the real team', () => {
    for (const url of [
      ...data.projects.map((p) => p.url),
      ...data.issues.map((i) => i.url),
    ]) {
      expect(
        url.startsWith(`https://linear.app/${FIXTURE_WORKSPACE.urlKey}/`)
      ).toBe(true);
    }
    for (const user of data.users) {
      if (user.email !== null) {
        expect(user.email.endsWith('@northwind.example')).toBe(true);
      }
    }
    const firstNames = data.users.map((u) => u.displayName);
    expect(new Set(firstNames).size).toBe(firstNames.length);
    expect(
      JSON.stringify([
        data,
        SHOWCASE_MILESTONE_META,
        createShowcaseIssueDetails(TODAY),
      ])
    ).not.toMatch(/orion|halo|waggoner|wyat|shanzer/i);
  });
});

describe('showcase: deterministic, dated relative to today', () => {
  test('the same today gives deep-equal data', () => {
    expect(createShowcaseWorkspace(TODAY)).toEqual(data);
    expect(createShowcaseIssueDetails(TODAY)).toEqual(
      createShowcaseIssueDetails(TODAY)
    );
  });

  test('another today shifts every date by the same number of days', () => {
    const later = createShowcaseWorkspace('2026-11-05');
    const laterDetails = createShowcaseIssueDetails('2026-11-05');
    const details = createShowcaseIssueDetails(TODAY);
    const shift = (a: string | null, b: string | null): number | null =>
      a === null || b === null
        ? null
        : Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
    expect(later.milestones.map((m) => m.id)).toEqual(
      data.milestones.map((m) => m.id)
    );
    data.milestones.forEach((m, index) => {
      const moved = later.milestones[index]?.targetDate ?? null;
      expect(moved === null).toBe(m.targetDate === null);
      if (m.targetDate !== null) expect(shift(m.targetDate, moved)).toBe(15);
    });
    data.issues.forEach((i, index) => {
      const moved = later.issues[index];
      expect(moved?.id).toBe(i.id);
      expect(shift(i.createdAt, moved?.createdAt ?? null)).toBe(15);
      expect(shift(i.lastStateChangeAt, moved?.lastStateChangeAt ?? null)).toBe(
        15
      );
      expect({
        ...moved,
        createdAt: '',
        updatedAt: '',
        lastStateChangeAt: '',
        startedAt: '',
        completedAt: '',
        canceledAt: '',
      }).toEqual({
        ...i,
        createdAt: '',
        updatedAt: '',
        lastStateChangeAt: '',
        startedAt: '',
        completedAt: '',
        canceledAt: '',
      });
    });
    for (const [id, fields] of Object.entries(details.issueFields)) {
      const moved = laterDetails.issueFields[id]?.dueDate ?? null;
      if (fields.dueDate !== null)
        expect(shift(fields.dueDate, moved)).toBe(15);
    }
    expect(later.relations).toEqual(data.relations);
  });

  test('month and year boundaries work; a bad date throws', () => {
    const newYear = createShowcaseWorkspace('2026-12-30');
    expect(
      newYear.milestones.find((m) => m.id === 'ms-lagoon-2')?.targetDate
    ).toBe('2027-01-05');
    expect(() => createShowcaseWorkspace('10/21/2026')).toThrow(RangeError);
  });

  test('the milestone scenarios hold on any day', () => {
    for (const today of ['2026-10-21', '2027-02-27', '2027-06-14']) {
      const day = evalContext(today);
      const result = assessWorkspace(
        indexWorkspace(createShowcaseWorkspace(today)),
        day
      );
      expect(
        Object.fromEntries(
          [
            'ms-ridge-2',
            'ms-plume-2',
            'ms-thistle-2',
            'ms-nettle-1',
            'ms-lagoon-2',
            'ms-saffron-2',
          ].map((id) => [id, result.get(id)?.status])
        )
      ).toEqual({
        'ms-ridge-2': 'overdue',
        'ms-plume-2': 'overdue',
        'ms-thistle-2': 'at_risk',
        'ms-nettle-1': 'at_risk',
        'ms-lagoon-2': 'at_risk',
        'ms-saffron-2': 'on_track',
      });
    }
  });
});

describe('showcase: milestone scenarios', () => {
  const status = (id: string) => assessments.get(id)?.status;
  const reasons = (id: string) => assessments.get(id)?.reasons ?? [];
  const newIds = data.milestones
    .map((m) => m.id)
    .filter((id) => !baseMilestoneIds.has(id));

  test('a spread of statuses among the new milestones', () => {
    const counts: Record<string, number> = {};
    for (const id of newIds) {
      const s = status(id) ?? '?';
      counts[s] = (counts[s] ?? 0) + 1;
    }
    expect(counts).toEqual({
      complete: 12,
      overdue: 2,
      at_risk: 5,
      on_track: 26,
      unscheduled: 4,
      empty: 1,
    });
  });

  test('at risk for each reason, alone where it matters', () => {
    expect(reasons('ms-lagoon-2')).toEqual(['unassigned_open']);
    expect(reasons('ms-nettle-1')).toEqual(['behind_pace']);
    expect(reasons('ms-thistle-2')).toContain('stalled');
    expect(reasons('ms-thistle-2')).not.toContain('unassigned_open');
    expect(status('ms-umber-1')).toBe('at_risk');
    expect(reasons('ms-umber-1')).toContain('unassigned_open');
  });

  test('on track due within the warning window: all assigned, moving, on pace', () => {
    expect(status('ms-saffron-2')).toBe('on_track');
    expect(assessments.get('ms-saffron-2')?.daysLeft).toBeLessThanOrEqual(7);
    expect(reasons('ms-saffron-2')).toEqual([]);
  });

  test('missing inputs: Willow\'s next milestone has no "done means…"', () => {
    expect(assessments.get('ms-willow-1')?.rubric.gaps).toEqual([
      'no_done_means',
    ]);
    expect(
      SHOWCASE_MILESTONE_META.some((m) => m.milestoneId === 'ms-willow-1')
    ).toBe(false);
  });

  test('complete milestones are in the past and fully closed', () => {
    for (const id of newIds.filter((x) => status(x) === 'complete')) {
      const due = milestoneById.get(id)?.targetDate ?? null;
      expect(due !== null && due < TODAY).toBe(true);
      for (const i of snapshot.issuesByMilestone.get(id) ?? []) {
        expect(isOpen(i)).toBe(false);
      }
    }
  });

  test('a paused and a backlog project; every other project is active', () => {
    const inactive = data.projects
      .filter((p) => !['planned', 'started'].includes(p.statusType))
      .map((p) => [p.id, p.statusType]);
    expect(inactive).toEqual([
      ['proj-fjord', 'paused'],
      ['proj-sorrel', 'backlog'],
    ]);
  });

  test('meta rows reference real milestones; weights on three', () => {
    for (const m of SHOWCASE_MILESTONE_META) {
      expect(milestoneById.has(m.milestoneId)).toBe(true);
    }
    expect(
      SHOWCASE_MILESTONE_META.filter((m) => m.weight !== null).map((m) => [
        m.milestoneId,
        m.weight,
      ])
    ).toEqual([
      ['ms-juniper-1', 5],
      ['ms-lagoon-2', 3],
      ['ms-saffron-4', 2],
    ]);
  });
});

describe('showcase: the blocking graph', () => {
  const home = homeInitiativeIds(snapshot);
  const projectOrder = [
    'plume',
    'orchard',
    'atlas',
    'beacon',
    'juniper',
    'harbor',
    'ridge',
    'thistle',
    'delta',
    'fjord',
    'quarry',
    'lagoon',
    'nettle',
    'marble',
    'saffron',
    'ember',
    'umber',
    'compass',
    'sorrel',
    'garnet',
    'willow',
  ].map((key) => `proj-${key}`);
  const initiativeOrder = [
    'init-platform',
    'init-insights',
    'init-enterprise',
    'init-growth',
    null,
  ];

  // Why a relation breaks a flow rule, or null when it follows them all.
  function exception(blocker: Issue, blocked: Issue): string | null {
    // Undated milestones (and no milestone) come last.
    const due = (i: Issue): string => {
      const milestone =
        i.milestoneId === null ? undefined : milestoneById.get(i.milestoneId);
      return milestone?.targetDate ?? '9999-12-31';
    };
    const why: string[] = [];
    if (blocker.milestoneId !== blocked.milestoneId) {
      if (due(blocker) > due(blocked)) why.push('backwards in time');
      if (due(blocker) === due(blocked) && blocker.milestoneId !== null) {
        why.push('two milestones due the same day');
      }
    }
    const pa = blocker.projectId ?? '';
    const pb = blocked.projectId ?? '';
    if (pa !== pb && projectOrder.indexOf(pa) > projectOrder.indexOf(pb)) {
      why.push('against the project order');
    }
    const ia = blocker.projectId === null ? null : home.get(blocker.projectId);
    const ib = blocked.projectId === null ? null : home.get(blocked.projectId);
    if (
      ia !== ib &&
      initiativeOrder.indexOf(ia ?? null) > initiativeOrder.indexOf(ib ?? null)
    ) {
      why.push('against the initiative order');
    }
    return why.length === 0 ? null : why.join(', ');
  }

  test('every project is in the flow order', () => {
    expect([...projectOrder].sort()).toEqual(
      data.projects.map((p) => p.id).sort()
    );
  });

  test('relations flow forward, except the designed cycles and the base chain', () => {
    const exceptions = data.relations.flatMap((r) => {
      const blocker = issueById.get(r.blockerId) as Issue;
      const blocked = issueById.get(r.blockedId) as Issue;
      const why = exception(blocker, blocked);
      return why === null
        ? []
        : [`${blocker.identifier} > ${blocked.identifier}: ${why}`];
    });
    expect(exceptions).toEqual([
      // The base workspace's cross-project chain (fixture.ts).
      'ENG-23 > OPS-20: against the initiative order',
      'ENG-243 > ENG-215: backwards in time',
      'ENG-215 > ENG-244: against the project order',
      'OPS-73 > OPS-55: backwards in time, against the project order',
    ]);
  });

  test('the designed cycles are the only cycles', () => {
    expect(
      cyclesOf(
        data.issues.map((i) => i.identifier),
        relationPairs
      )
    ).toEqual(sortedCycles(SHOWCASE_CYCLES));
    for (const cycle of SHOWCASE_CYCLES) {
      for (const id of cycle) expect(isOpen(issue(id))).toBe(true);
    }
  });

  test('the critical path is a chain of open issues across projects and initiatives', () => {
    const pairs = new Set(relationPairs.map(([a, b]) => `${a}>${b}`));
    SHOWCASE_CRITICAL_PATH.forEach((id, index) => {
      expect(isOpen(issue(id))).toBe(true);
      const next = SHOWCASE_CRITICAL_PATH[index + 1];
      if (next !== undefined) expect(pairs.has(`${id}>${next}`)).toBe(true);
    });
    const projects = new Set(
      SHOWCASE_CRITICAL_PATH.map((id) => issue(id).projectId)
    );
    const homes = new Set(
      SHOWCASE_CRITICAL_PATH.map((id) => home.get(issue(id).projectId ?? ''))
    );
    expect(SHOWCASE_CRITICAL_PATH.length).toBeGreaterThanOrEqual(10);
    expect(SHOWCASE_CRITICAL_PATH.length).toBeLessThanOrEqual(14);
    expect(projects.size).toBeGreaterThanOrEqual(5);
    expect(homes.size).toBeGreaterThanOrEqual(3);
    // It waits on an unassigned issue: a risk chain from its third step.
    expect(issue('ENG-187').assigneeId).toBeNull();
  });

  test('the critical path is the one longest chain', () => {
    // Longest path in issues over the relations outside the cycles, by
    // dynamic programming in topological order, counting ties.
    const inCycle = new Set(SHOWCASE_CYCLES.flat());
    const edges = relationPairs.filter(
      ([a, b]) => !(inCycle.has(a) && inCycle.has(b))
    );
    const out = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const i of data.issues) {
      out.set(i.identifier, []);
      indegree.set(i.identifier, 0);
    }
    for (const [a, b] of edges) {
      out.get(a)?.push(b);
      indegree.set(b, (indegree.get(b) ?? 0) + 1);
    }
    const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
    const length = new Map<string, number>(queue.map((id) => [id, 1]));
    const ways = new Map<string, number>(queue.map((id) => [id, 1]));
    const before = new Map<string, string>();
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head] ?? '';
      for (const w of out.get(v) ?? []) {
        const candidate = (length.get(v) ?? 1) + 1;
        if (candidate > (length.get(w) ?? 0)) {
          length.set(w, candidate);
          ways.set(w, ways.get(v) ?? 1);
          before.set(w, v);
        } else if (candidate === length.get(w)) {
          ways.set(w, (ways.get(w) ?? 0) + (ways.get(v) ?? 1));
        }
        indegree.set(w, (indegree.get(w) ?? 1) - 1);
        if (indegree.get(w) === 0) queue.push(w);
      }
    }
    const longest = Math.max(...length.values());
    const ends = [...length].filter(([, n]) => n === longest);
    expect(ends).toHaveLength(1);
    const [end] = ends[0] ?? [''];
    expect(ways.get(end)).toBe(1);
    const path = [end];
    while (before.has(path[0] ?? ''))
      path.unshift(before.get(path[0] ?? '') ?? '');
    expect(path).toEqual([...SHOWCASE_CRITICAL_PATH]);
  });

  test('fan-in and fan-out hubs', () => {
    const blocks = (id: string) =>
      relationPairs.filter(([a]) => a === id).length;
    const blockedBy = (id: string) =>
      relationPairs.filter(([, b]) => b === id).length;
    // Exact, so architecture §4 "Showcase demo workspace" cannot drift.
    expect(blocks('DATA-45')).toBe(9);
    expect(blocks('OPS-52')).toBe(5);
    expect(blocks('ENG-73')).toBe(5);
    expect(blockedBy('GRO-40')).toBe(10);
    expect(blockedBy('DATA-75')).toBe(5);
    // The overdue rollout and the unowned capacity plan hold work up.
    expect(assessments.get('ms-plume-2')?.status).toBe('overdue');
    expect(issue('OPS-52').assigneeId).toBeNull();
  });

  test('done blockers, history, cross-project and cross-initiative edges', () => {
    let resolved = 0;
    let history = 0;
    let crossProject = 0;
    let crossInitiative = 0;
    for (const r of data.relations) {
      const blocker = issueById.get(r.blockerId) as Issue;
      const blocked = issueById.get(r.blockedId) as Issue;
      if (!isOpen(blocker)) {
        if (isOpen(blocked)) resolved += 1;
        else history += 1;
      } else {
        // An open issue never blocks a closed one in the demo.
        expect(isOpen(blocked)).toBe(true);
      }
      if (blocker.projectId !== blocked.projectId) crossProject += 1;
      const ha = home.get(blocker.projectId ?? '');
      const hb = home.get(blocked.projectId ?? '');
      if (ha != null && hb != null && ha !== hb) crossInitiative += 1;
    }
    expect(resolved).toBeGreaterThanOrEqual(10);
    expect(history).toBeGreaterThanOrEqual(10);
    expect(crossProject).toBeGreaterThanOrEqual(30);
    // A minority, so the layered layout is not spaghetti.
    expect(crossProject / data.relations.length).toBeLessThan(0.25);
    expect(crossInitiative).toBeGreaterThanOrEqual(15);
  });

  test('every milestone mixes linked and unlinked work (the paused Fjord aside)', () => {
    const linked = new Set(relationPairs.flat());
    const unmixed = data.milestones.flatMap((m) => {
      const issues = snapshot.issuesByMilestone.get(m.id) ?? [];
      if (issues.length < 2) return [];
      const n = issues.filter((i) => linked.has(i.identifier)).length;
      return n === 0 || n === issues.length ? [m.id] : [];
    });
    expect(unmixed).toEqual(['ms-fjord-1']);
    const unlinked = data.issues.filter((i) => !linked.has(i.identifier));
    expect(unlinked.length).toBeGreaterThanOrEqual(150);
  });
});

describe('showcase: core builds every graph level', () => {
  const ids = (cycles: string[][]): string[][] =>
    sortedCycles(cycles.map((cycle) => cycle.map(identifierOf)));

  test('workspace levels, with exactly the designed cycles', () => {
    expect(ids(graph({ level: 'issue' }).cycles)).toEqual(
      sortedCycles(SHOWCASE_CYCLES)
    );
    // Above the issue level the cycles are the ones the issue cycles span,
    // plus the base workspace's Platform <-> Growth chain (ENG-12 > ENG-23
    // > OPS-20), which no showcase relation extends.
    expect(ids(graph({ level: 'milestone' }).cycles)).toEqual([
      ['ms-marble-2', 'ms-nettle-2'],
      ['ms-ridge-3', 'ms-thistle-3'],
    ]);
    expect(ids(graph({ level: 'project' }).cycles)).toEqual([
      ['proj-marble', 'proj-nettle'],
      ['proj-ridge', 'proj-thistle'],
    ]);
    expect(ids(graph({ level: 'initiative' }).cycles)).toEqual([
      ['init-growth', 'init-platform'],
    ]);
    for (const level of ['initiative', 'project', 'milestone'] as const) {
      expect(graph({ level }).edges.length).toBeGreaterThan(5);
    }
  });

  test('inside every initiative, project and milestone', () => {
    for (const initiative of [...data.initiatives.map((i) => i.id), 'none']) {
      for (const level of ['project', 'milestone', 'issue'] as const) {
        const g = graph({ level, initiativeId: initiative });
        expect(g.fallback).toBeNull();
        expect(g.edges.length).toBeGreaterThan(0);
      }
    }
    for (const project of data.projects) {
      graph({ level: 'issue', projectId: project.id });
      graph({ level: 'milestone', projectId: project.id });
    }
    for (const milestone of data.milestones) {
      graph({ level: 'issue', milestoneId: milestone.id });
    }
  });

  test('each critical-path issue has a readable chain', () => {
    for (const id of SHOWCASE_CRITICAL_PATH) {
      const chain = graph({ level: 'issue', issueId: issue(id).id });
      expect(chain.chain?.hidden).toBe(0);
      expect(chain.nodes.length).toBeGreaterThan(SHOWCASE_CRITICAL_PATH.length);
      expect(chain.nodes.length).toBeLessThan(150);
      // A chain may pass a designed cycle (the go/no-go waits on the
      // failover work), never another one.
      const designed = sortedCycles(SHOWCASE_CYCLES).map((c) => c.join());
      for (const cycle of ids(chain.cycles)) {
        expect(designed).toContain(cycle.join());
      }
    }
  });
});

describe('showcase: issue-page content', () => {
  const details = createShowcaseIssueDetails(TODAY);
  const labels = new Map(details.labels.map((l) => [l.id, l]));

  test('every issue has fields; labels are valid for its team', () => {
    for (const i of data.issues) {
      const fields = details.issueFields[i.id];
      if (baseIssueIds.has(i.id)) continue;
      expect(fields).toBeDefined();
      const groups = new Set<string>();
      for (const id of fields?.labelIds ?? []) {
        const label = labels.get(id);
        expect(label).toBeDefined();
        expect(label?.archived).toBe(false);
        expect(label?.isGroup).toBe(false);
        expect(label?.teamId === null || label?.teamId === i.teamId).toBe(true);
        if (label?.parentId != null) {
          expect(groups.has(label.parentId)).toBe(false);
          groups.add(label.parentId);
        }
      }
    }
  });

  test('estimates are on the team scale; due dates are dates', () => {
    let estimated = 0;
    let dated = 0;
    for (const i of data.issues) {
      const fields = details.issueFields[i.id];
      if (fields === undefined) continue;
      if (fields.estimate !== null) {
        estimated += 1;
        const scale = details.estimateScales[i.teamId];
        if (scale === undefined) throw new Error(`no scale for ${i.teamId}`);
        expect(estimateOptions(scale).map((o) => o.value)).toContain(
          fields.estimate
        );
      }
      if (fields.dueDate !== null) {
        dated += 1;
        expect(fields.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    expect(estimated).toBeGreaterThan(250);
    expect(dated).toBe(98);
    expect(Object.keys(details.estimateScales).sort()).toEqual(
      data.teams.map((t) => t.id).sort()
    );
  });

  test('seeded comments name real issues and people, replies point back', () => {
    const ids = details.seededComments.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const users = new Set(data.users.map((u) => u.id));
    details.seededComments.forEach((comment, index) => {
      expect(issueById.has(comment.issueId)).toBe(true);
      expect(users.has(comment.authorId)).toBe(true);
      expect(Date.parse(comment.createdAt)).toBeLessThan(
        Date.parse(`${TODAY}T00:00:00.000Z`)
      );
      if (comment.parentId !== undefined) {
        const parent = details.seededComments.findIndex(
          (c) => c.id === comment.parentId
        );
        expect(parent).toBeGreaterThanOrEqual(0);
        expect(parent).toBeLessThan(index);
        expect(details.seededComments[parent]?.issueId).toBe(comment.issueId);
      }
    });
    // The story's issues explain themselves.
    for (const id of [...SHOWCASE_CRITICAL_PATH.slice(1, 6), 'DATA-45']) {
      const description = details.issueFields[issue(id).id]?.description;
      if (id === 'ENG-60') continue;
      expect(description ?? '').not.toBe('');
    }
  });
});

// Issue due dates (Issue.dueDate, read by the mirror since the Issues view,
// 2026-10-22): about a quarter of the issues carry one, as in a real
// workspace where most work rides on its milestone, all relative to
// today, a few overdue and a few due today or tomorrow, and never at odds
// with the milestone they are planned into.
describe('showcase: due dates', () => {
  /** Days from `today` to `date`. */
  const daysFrom = (today: string, date: string) =>
    Math.round((Date.parse(date) - Date.parse(today)) / DAY_MS);

  /** The due-date facts of the showcase on `today`. */
  function dueFacts(today: string) {
    const workspace = createShowcaseWorkspace(today);
    const fields = createShowcaseIssueDetails(today).issueFields;
    const types = new Map(workspace.states.map((x) => [x.id, x.type]));
    const targets = new Map(
      workspace.milestones.map((m) => [m.id, m.targetDate])
    );
    const rows = workspace.issues.map((i) => {
      const type = types.get(i.stateId);
      return {
        issue: i,
        due: fields[i.id]?.dueDate ?? null,
        open: type !== 'completed' && type !== 'canceled',
        canceled: type === 'canceled',
        target:
          i.milestoneId === null ? null : (targets.get(i.milestoneId) ?? null),
      };
    });
    const openDated = rows.filter((r) => r.open && r.due !== null);
    const keys = (list: typeof rows) =>
      list.map((r) => r.issue.identifier).sort();
    return {
      rows,
      dated: rows.filter((r) => r.due !== null).length,
      overdue: keys(openDated.filter((r) => daysFrom(today, r.due ?? '') < 0)),
      dueToday: keys(
        openDated.filter((r) => daysFrom(today, r.due ?? '') === 0)
      ),
      dueTomorrow: keys(
        openDated.filter((r) => daysFrom(today, r.due ?? '') === 1)
      ),
    };
  }

  const facts = dueFacts(TODAY);

  test('a realistic minority: about a quarter of the issues', () => {
    expect(facts.dated).toBe(98);
    const share = facts.dated / data.issues.length;
    expect(share).toBeGreaterThanOrEqual(0.2);
    expect(share).toBeLessThanOrEqual(0.3);
    // The base keeps its own 9; the new issues carry the rest.
    const baseDated = facts.rows.filter(
      (r) => baseIssueIds.has(r.issue.id) && r.due !== null
    ).length;
    expect(baseDated).toBe(9);
    // Closed work keeps a date too, but most dates are on open work.
    const closedDated = facts.rows.filter(
      (r) => !r.open && r.due !== null
    ).length;
    expect(closedDated).toBe(25);
    expect(facts.rows.filter((r) => r.canceled && r.due !== null)).toEqual([]);
  });

  test('a few overdue, a few due today or tomorrow', () => {
    expect(facts.overdue).toEqual([
      'DATA-46',
      'DATA-48',
      'DATA-50',
      'ENG-10',
      'ENG-12',
      'ENG-165',
      'ENG-167',
      'ENG-256',
      'ENG-257',
    ]);
    expect(facts.dueToday).toEqual([
      'ENG-234',
      'ENG-235',
      'GRO-52',
      'OPS-77',
      'OPS-81',
    ]);
    expect(facts.dueTomorrow).toEqual([
      'ENG-188',
      'ENG-232',
      'ENG-54',
      'GRO-54',
      'OPS-90',
    ]);
  });

  test('relative to today: the same issues on any day', () => {
    for (const today of ['2026-10-23', '2026-12-30', '2027-03-01']) {
      const other = dueFacts(today);
      expect(other.dated).toBe(facts.dated);
      expect(other.overdue).toEqual(facts.overdue);
      expect(other.dueToday).toEqual(facts.dueToday);
      expect(other.dueTomorrow).toEqual(facts.dueTomorrow);
      // Each date sits the same number of days from that day.
      other.rows.forEach((row, index) => {
        const mine = facts.rows[index];
        expect(row.issue.id).toBe(mine?.issue.id ?? '');
        expect(row.due === null).toBe((mine?.due ?? null) === null);
        if (row.due !== null && mine?.due != null) {
          expect(daysFrom(today, row.due)).toBe(daysFrom(TODAY, mine.due));
        }
      });
    }
  });

  test('consistent with their milestones and when they were filed', () => {
    for (const row of facts.rows) {
      if (row.due === null || baseIssueIds.has(row.issue.id)) continue;
      // Never after the milestone's target.
      if (row.target !== null) expect(row.due <= row.target).toBe(true);
      // Never before the issue was filed.
      expect(row.due >= row.issue.createdAt.slice(0, 10)).toBe(true);
      // Open work is overdue only in a milestone that is overdue itself.
      if (row.open && row.due < TODAY) {
        expect(row.target !== null && row.target < TODAY).toBe(true);
      }
    }
    // Open work in a milestone due within two days is due by then, and
    // most of it carries a date.
    const soon = facts.rows.filter(
      (r) =>
        r.open &&
        !baseIssueIds.has(r.issue.id) &&
        r.target !== null &&
        r.target >= TODAY &&
        daysFrom(TODAY, r.target) <= 2
    );
    const soonDated = soon.filter((r) => r.due !== null);
    expect(soonDated.length * 2).toBeGreaterThan(soon.length);
    for (const r of soonDated) expect((r.due ?? '') >= TODAY).toBe(true);
  });

  test('the mirror reads them: every issue the gateway returns carries its date', async () => {
    const gateway = createFixtureGateway(
      createShowcaseStore(TODAY),
      'user-chloe'
    );
    const issues = (await gateway.fetchWorkspace()).issues;
    expect(issues.filter((i) => i.dueDate != null)).toHaveLength(facts.dated);
    const due = new Map(facts.rows.map((r) => [r.issue.id, r.due]));
    for (const i of issues)
      expect(i.dueDate ?? null).toBe(due.get(i.id) ?? null);
  });
});

describe('showcase: store, gateway and My week', () => {
  test('a fresh store per call; the base gateway serves it and writes to it', async () => {
    const one = createShowcaseStore(TODAY);
    const two = createShowcaseStore(TODAY);
    expect(one.data).toEqual(data);
    expect(one.data).not.toBe(two.data);
    expect(one.lastRelationNumber).toBe(data.relations.length);
    const gateway = createFixtureGateway(one, 'user-chloe');
    expect((await gateway.fetchWorkspace()).issues).toHaveLength(
      data.issues.length
    );
    const created = await gateway.createBlockingRelation(
      issue('ENG-290').id,
      issue('ENG-291').id
    );
    expect(created.id).toBe(`rel-${data.relations.length + 1}`);
    expect(two.data.relations).toHaveLength(data.relations.length);
    const detail = await gateway.fetchIssueDetail(issue('ENG-187').id);
    expect(detail?.comments.length).toBeGreaterThanOrEqual(2);
  });

  test('createDemoStore and demoMilestoneMeta choose the dataset', () => {
    const strip = (store: ReturnType<typeof createDemoStore>) => ({
      ...store,
      now: null,
    });
    expect(strip(createDemoStore(TODAY, 'base'))).toEqual(
      strip(createFixtureStore(TODAY))
    );
    expect(strip(createDemoStore(TODAY, 'showcase'))).toEqual(
      strip(createShowcaseStore(TODAY))
    );
    expect(demoMilestoneMeta('base')).toBe(FIXTURE_MILESTONE_META);
    expect(demoMilestoneMeta('showcase')).toBe(SHOWCASE_MILESTONE_META);
  });

  test('Chloe (the browser smoke sign-in) and the watchers have a full week', () => {
    for (const [userId, issues, milestones] of [
      ['user-chloe', 10, 6],
      ['user-ana', 8, 5],
      ['user-ben', 6, 4],
    ] as const) {
      const open = data.issues.filter(
        (i) => i.assigneeId === userId && isOpen(i)
      );
      expect(open.length).toBeGreaterThanOrEqual(issues);
      expect(
        new Set(open.map((i) => i.milestoneId).filter((m) => m !== null)).size
      ).toBeGreaterThanOrEqual(milestones);
    }
  });
});
