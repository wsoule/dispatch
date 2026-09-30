import { describe, expect, it } from 'bun:test';

import {
  bodyWithLinearDescription,
  bodyWithLinks,
  canonicalMarkdown,
  ISSUE_FIELDS,
  issuePatch,
  issuePush,
  issueTaskCreate,
  issueValues,
  labelFor,
  linearDescriptionFromBody,
  linksFromBody,
  missingLabels,
  normalizeMarkdown,
  PULL_ONLY_ISSUE_FIELDS,
  replaceableIssueFields,
  stateIdFor,
  taskIssueValues,
  untrustedIssueFields,
} from '../src/linearFields.js';
import type { LinearMapContext } from '../src/linearFields.js';
import type {
  LinearIssue,
  LinearLabel,
  LinearRelation,
  LinearWorkflowState,
} from '../src/linearMap.js';
import { mergeFields, nextBase, UNMAPPED } from '../src/linearMerge.js';
import { peopleIndex } from '../src/linearPeople.js';
import { statusesFromTeams } from '../src/linearStatuses.js';
import { fanoutHolder } from '../src/people.js';
import { isDoneStatus } from '../src/status.js';
import { applyUpdatePatch } from '../src/store.js';
import { getSection } from '../src/taskfile.js';
import type { TaskDoc, TaskMeta } from '../src/types.js';
import {
  blankIssue,
  context,
  doc,
  LABELS,
  linked,
  materialize,
  pick,
  rng,
  STATES,
  TEMPLATE_BODY,
} from './linearFixtures.js';

const NOW = '2026-07-10T00:00:00.000Z';

// The linked workspace every property run maps against: a project with a
// milestone, and five issues arranged as a small hierarchy.
function workspace(): TaskMeta[] {
  return [
    linked('t-proj', 'project', 'p-1'),
    linked('t-ms', 'milestone', 'm-1', 'milestone', { parent: 't-proj' }),
    linked('t-i1', 'issue', 'i-1', 'task', { parent: 't-ms' }),
    linked('t-i2', 'issue', 'i-2', 'task', { parent: 't-proj' }),
    linked('t-i3', 'issue', 'i-3'),
    linked('t-i4', 'issue', 'i-4', 'task', { parent: 't-i1' }),
    linked('t-i5', 'issue', 'i-5', 'task', { parent: 't-i3' }),
  ];
}

// Consistent Linear hierarchies: an issue's project and milestone agree with
// its parent's, as Linear keeps them.
const HIERARCHIES: Pick<
  LinearIssue,
  'parentId' | 'projectId' | 'projectMilestoneId'
>[] = [
  { parentId: null, projectId: null, projectMilestoneId: null },
  { parentId: null, projectId: 'p-1', projectMilestoneId: null },
  { parentId: null, projectId: 'p-1', projectMilestoneId: 'm-1' },
  { parentId: 'i-1', projectId: 'p-1', projectMilestoneId: 'm-1' },
  { parentId: 'i-2', projectId: 'p-1', projectMilestoneId: null },
  { parentId: 'i-3', projectId: null, projectMilestoneId: null },
  { parentId: 'i-4', projectId: 'p-1', projectMilestoneId: 'm-1' },
];

const DESCRIPTIONS = [
  '',
  'Plain text.',
  'Lead paragraph.\n\n## Notes\n\n- one\n- two',
  '## Only a heading block\n\nbody',
  'Lead\n\n## Acceptance Criteria\n\n- [ ] ships\n\n## Rollout\n\nslowly',
  'Mentions ## Activity inline\n## Activity\nstays text',
  'Code:\n\n```\n## not a heading in code\n```',
  'Lead\n\n## Empty\n\n## Next\n\nbody',
];

const URLS = [
  { url: 'https://github.com/acme/app/pull/1', title: 'PR #1' },
  { url: 'https://figma.com/file/x', title: 'Design' },
  { url: 'https://example.com/doc', title: 'Doc' },
];

function subset<T>(random: () => number, items: readonly T[]): T[] {
  return items.filter(() => random() < 0.5);
}

function randomIssue(random: () => number): LinearIssue {
  const others = ['i-1', 'i-2', 'i-3', 'i-4', 'i-5'];
  const relations: LinearRelation[] = [];
  let n = 0;
  for (const blocker of subset(random, others)) {
    relations.push({
      id: `r-${n++}`,
      type: 'blocks',
      issueId: blocker,
      relatedIssueId: 'i-x',
    });
  }
  for (const other of subset(random, others)) {
    relations.push(
      random() < 0.5
        ? {
            id: `r-${n++}`,
            type: 'related',
            issueId: 'i-x',
            relatedIssueId: other,
          }
        : {
            id: `r-${n++}`,
            type: 'related',
            issueId: other,
            relatedIssueId: 'i-x',
          }
    );
  }
  if (random() < 0.3) {
    relations.push({
      id: `r-${n++}`,
      type: 'duplicate',
      issueId: 'i-x',
      relatedIssueId: pick(random, others),
    });
  }
  // A relation that points out of this issue is someone else's field.
  relations.push({
    id: `r-${n++}`,
    type: 'blocks',
    issueId: 'i-x',
    relatedIssueId: 'i-2',
  });
  return blankIssue('i-x', {
    title: pick(random, ['Ship it', 'Fix the thing', 'Ship 出荷 🚀']),
    description: pick(random, DESCRIPTIONS),
    state: pick(random, STATES),
    priority: Math.floor(random() * 5),
    estimate: pick(random, [null, 1, 2, 3, 5, 8]),
    assigneeId: pick(random, [null, 'u-me', 'u-ana']),
    creatorId: pick(random, [null, 'u-me', 'u-ana']),
    labels: subset(random, LABELS).map((l) => ({ id: l.id, name: l.name })),
    dueDate: pick(random, [null, '2026-08-01']),
    cycle: pick(random, [
      null,
      { id: 'c-1', number: 7, name: null, startsAt: 'a', endsAt: 'b' },
    ]),
    ...pick(random, HIERARCHIES),
    relations,
    attachments: subset(random, URLS).map((u, i) => ({
      id: `a-${i}`,
      ...u,
      subtitle: null,
      sourceType: null,
    })),
    archivedAt: random() < 0.2 ? '2026-07-05T00:00:00.000Z' : null,
  });
}

// Pulls every field of `issue` into `start`, the way an import does.
function pull(issue: LinearIssue, start: TaskDoc, tasks: TaskMeta[]): TaskDoc {
  const ctx = context([...tasks, start.meta]);
  const patch = issuePatch(issue, ISSUE_FIELDS, start, ctx);
  return applyUpdatePatch(start, patch, NOW);
}

describe('Linear -> Dispatch -> Linear', () => {
  it('is the identity for every issue field over 300 random issues', () => {
    const random = rng(42);
    for (let run = 0; run < 300; run++) {
      const issue = randomIssue(random);
      const tasks = workspace();
      const pulled = pull(issue, doc(linked('t-x', 'issue', 'i-x')), tasks);
      const ctx = context([...tasks, pulled.meta]);
      const remote = issueValues(issue, ctx);
      const local = taskIssueValues(pulled, ctx);
      for (const field of ISSUE_FIELDS) {
        if (
          field === 'archived' &&
          isDoneStatus(pulled.meta.status, ctx.model)
        ) {
          // A finished task's archive belongs to Linear's own schedule.
          expect(local.archived).toBe(UNMAPPED);
          continue;
        }
        if (JSON.stringify(local[field]) !== JSON.stringify(remote[field])) {
          throw new Error(
            `run ${run}, field ${field}: ${JSON.stringify(local[field])} != ${JSON.stringify(remote[field])}`
          );
        }
      }
    }
  });

  it('keeps a custom workflow state exactly', () => {
    const issue = blankIssue('i-x', {
      state: STATES.find((s) => s.name === 'QA') ?? null,
    });
    const pulled = pull(issue, doc(linked('t-x', 'issue', 'i-x')), workspace());
    expect(pulled.meta.status).toBe('QA');
    const ctx = context([...workspace(), pulled.meta]);
    // Compared as the status it generated; pushed as the team's own state.
    expect(taskIssueValues(pulled, ctx).state).toBe('QA');
    expect(issuePush(pulled, ['state'], issue, ctx).input.stateId).toBe('s-qa');
  });
});

describe('Dispatch -> Linear -> Dispatch', () => {
  it('pushes every local change so Linear ends up holding it', () => {
    const random = rng(7);
    for (let run = 0; run < 200; run++) {
      const tasks = workspace();
      const remote = randomIssue(random);
      const pulled = pull(remote, doc(linked('t-x', 'issue', 'i-x')), tasks);
      // Scramble the task locally, then push everything.
      const next = randomIssue(random);
      const edited = pull(next, pulled, tasks);
      const ctx = context([...tasks, edited.meta]);
      const push = issuePush(edited, ISSUE_FIELDS, remote, ctx);
      const after = materialize(remote, push);
      const local = taskIssueValues(edited, ctx);
      const landed = issueValues(after, ctx);
      for (const field of ISSUE_FIELDS) {
        if (local[field] === UNMAPPED || PULL_ONLY_ISSUE_FIELDS.has(field))
          continue;
        if (JSON.stringify(local[field]) !== JSON.stringify(landed[field])) {
          throw new Error(
            `run ${run}, field ${field}: pushed ${JSON.stringify(local[field])}, Linear holds ${JSON.stringify(landed[field])}`
          );
        }
      }
    }
  });

  it('sends only the fields it is asked to', () => {
    const ctx = context(workspace());
    const task = doc(
      linked('t-x', 'issue', 'i-x', 'task', { title: 'New', priority: 'high' })
    );
    const push = issuePush(task, ['title'], blankIssue('i-x'), ctx);
    expect(push.input).toEqual({ title: 'New' });
    expect(push.relations).toEqual({ create: [], remove: [] });
    expect(push.archive).toBeNull();
  });

  it('leaves relation, link and archive writes for after a create', () => {
    const ctx = context(workspace());
    const task = doc(
      linked('t-x', 'issue', 'i-x', 'task', {
        blockedBy: ['t-i1'],
        archivedAt: NOW,
      }),
      `${TEMPLATE_BODY}\n## Links\n\n- [Doc](https://example.com/doc)\n`
    );
    const push = issuePush(task, ISSUE_FIELDS, null, ctx);
    expect(push.relations.create).toEqual([]);
    expect(push.links.add).toEqual([]);
    expect(push.archive).toBeNull();
    expect(push.input.title).toBe('Task');
  });
});

describe('issue field details', () => {
  it('never pushes an assignee Linear cannot hold', () => {
    const ctx = context(workspace());
    const task = doc(
      linked('t-x', 'issue', 'i-x', 'task', { assignee: 'agent:wyat/claude' })
    );
    expect(taskIssueValues(task, ctx).assignee).toBe(UNMAPPED);
    expect(issuePush(task, ['assignee'], blankIssue('i-x'), ctx).input).toEqual(
      {}
    );
  });

  it('keeps an assignee the people registry cannot name somebody’s, never pushed', () => {
    const ctx = context(workspace());
    const task = doc(linked('t-x', 'issue', 'i-x'));
    const issue = blankIssue('i-x', { assigneeId: 'u-unknown' });
    const patch = issuePatch(issue, ['assignee'], task, ctx);
    // Never unassigned: a fan-out would take it for anyone's to start.
    expect(patch.assignee).toBe('human:linear-user');
    expect(fanoutHolder(patch.assignee, 'human:wyat', 'human:wyat')).toBe(
      'human:linear-user'
    );
    const pulled = applyUpdatePatch(task, patch, NOW);
    expect(taskIssueValues(pulled, ctx).assignee).toBe(UNMAPPED);
    expect(issuePush(pulled, ['assignee'], issue, ctx).input).toEqual({});
  });

  it('pulls the person over the placeholder once the registry names them', () => {
    const before = context(workspace());
    const issue = blankIssue('i-x', { assigneeId: 'u-new' });
    const task = doc(linked('t-x', 'issue', 'i-x'));
    const held = applyUpdatePatch(
      task,
      issuePatch(issue, ['assignee'], task, before),
      NOW
    );
    const base = nextBase(
      ISSUE_FIELDS,
      taskIssueValues(held, before),
      issueValues(issue, before),
      null
    );
    expect(replaceableIssueFields(held, issue, before).size).toBe(0);

    // A users sync names u-new; neither side has moved since the base.
    const after = {
      ...before,
      people: peopleIndex(
        [{ ref: 'human:nia', name: 'Nia', external: 'linear:u-new' }],
        'human:wyat'
      ),
    };
    const merge = (current: TaskDoc) =>
      mergeFields({
        fields: ISSUE_FIELDS,
        local: taskIssueValues(current, after),
        remote: issueValues(issue, after),
        base,
        localUpdated: NOW,
        remoteUpdated: NOW,
        localDirty: false,
        refresh: replaceableIssueFields(current, issue, after),
      }).filter((d) => d.field === 'assignee');
    // A pull, not a conflict or a push: the placeholder was never an edit.
    expect(merge(held)).toEqual([
      { field: 'assignee', action: 'pull', conflict: false },
    ]);
    const resolved = applyUpdatePatch(
      held,
      issuePatch(issue, ['assignee'], held, after),
      NOW
    );
    expect(resolved.meta.assignee).toBe('human:nia');
    expect(replaceableIssueFields(resolved, issue, after).size).toBe(0);
    expect(taskIssueValues(resolved, after).assignee).toBe('u-new');
  });

  it('reads the legacy bare human as the local user', () => {
    const ctx = context(workspace());
    const task = doc(
      linked('t-x', 'issue', 'i-x', 'task', { assignee: 'human' })
    );
    expect(taskIssueValues(task, ctx).assignee).toBe('u-me');
  });

  it('keeps local-only blockers and parents that Linear cannot see', () => {
    const local = linked('t-x', 'issue', 'i-x', 'task', {
      blockedBy: ['t-local', 't-i1'],
      parent: 't-legacy',
    });
    const tasks = [
      ...workspace(),
      meta('t-local'),
      meta('t-legacy', 'project'),
    ];
    const ctx = context([...tasks, local]);
    const patch = issuePatch(
      blankIssue('i-x', {
        relations: [
          { id: 'r', type: 'blocks', issueId: 'i-2', relatedIssueId: 'i-x' },
        ],
      }),
      ['blockedBy', 'parent'],
      doc(local),
      ctx
    );
    expect(patch.blockedBy).toEqual(['t-i2', 't-local']);
    expect(patch.parent).toBe('t-legacy');
  });

  it('parents an issue on its parent issue, else its milestone, else its project', () => {
    const ctx = context(workspace());
    const task = doc(linked('t-x', 'issue', 'i-x'));
    const parentOf = (h: (typeof HIERARCHIES)[number]) =>
      issuePatch(blankIssue('i-x', h), ['parent'], task, ctx).parent;
    expect(parentOf(HIERARCHIES[3])).toBe('t-i1');
    expect(parentOf(HIERARCHIES[2])).toBe('t-ms');
    expect(parentOf(HIERARCHIES[1])).toBe('t-proj');
    expect(parentOf(HIERARCHIES[0])).toBeNull();
  });

  it('turns relation edits into creates and deletes by relation id', () => {
    const ctx = context(workspace());
    const remote = blankIssue('i-x', {
      relations: [
        { id: 'r-old', type: 'blocks', issueId: 'i-1', relatedIssueId: 'i-x' },
        { id: 'r-rel', type: 'related', issueId: 'i-3', relatedIssueId: 'i-x' },
        {
          id: 'r-dup',
          type: 'duplicate',
          issueId: 'i-x',
          relatedIssueId: 'i-4',
        },
      ],
    });
    const task = doc(
      linked('t-x', 'issue', 'i-x', 'task', {
        blockedBy: ['t-i2'],
        relatedTo: [],
        duplicateOf: 't-i5',
      })
    );
    const push = issuePush(
      task,
      ['blockedBy', 'relatedTo', 'duplicateOf'],
      remote,
      ctx
    );
    expect(push.relations.remove.sort()).toEqual(['r-dup', 'r-old', 'r-rel']);
    expect(push.relations.create).toEqual([
      { issueId: 'i-2', relatedIssueId: 'i-x', type: 'blocks' },
      { issueId: 'i-x', relatedIssueId: 'i-5', type: 'duplicate' },
    ]);
  });

  it('lists labels to create, and resolves grouped ones by Group/Name', () => {
    const ctx = context(workspace());
    const task = doc(
      meta('t-x', 'task', { labels: ['Type/Bug', 'WEB', 'brand-new'] })
    );
    expect(missingLabels(task, ctx)).toEqual(['brand-new']);
    expect(
      issuePush(task, ['labels'], blankIssue('i-x'), ctx).input.labelIds
    ).toEqual(['l-bug', 'l-web']);
  });

  it('rounds an estimate, since Linear takes an integer', () => {
    const ctx = context(workspace());
    const task = doc(meta('t-x', 'task', { estimate: 2.6 }));
    expect(
      issuePush(task, ['estimate'], blankIssue('i-x'), ctx).input.estimate
    ).toBe(3);
  });

  it('does not push the archive of a finished task, only of live work', () => {
    const ctx = context(workspace());
    const done = doc(meta('t-x', 'task', { status: 'Done', archivedAt: NOW }));
    const live = doc(meta('t-y', 'task', { status: 'Todo', archivedAt: NOW }));
    expect(taskIssueValues(done, ctx).archived).toBe(UNMAPPED);
    expect(issuePush(live, ['archived'], blankIssue('i-y'), ctx).archive).toBe(
      true
    );
    const unarchived = doc(meta('t-z', 'task', { status: 'Todo' }));
    expect(
      issuePush(unarchived, ['archived'], blankIssue('i-z'), ctx).archive
    ).toBe(false);
  });

  it('distrusts exactly the fields a cut-short list feeds', () => {
    expect(
      [...untrustedIssueFields(['relations', 'attachments'])].sort()
    ).toEqual(['blockedBy', 'duplicateOf', 'links', 'relatedTo']);
  });

  it('creates a linked task in the state’s status', () => {
    const ctx = context(workspace());
    const input = issueTaskCreate(
      blankIssue('i-x', { state: STATES[4], priority: 1 }),
      ctx
    );
    expect(input).toEqual({
      title: 'Issue',
      kind: 'task',
      status: 'QA',
      priority: 'urgent',
      external: 'linear:i-x',
    });
  });
});

describe('description round trip', () => {
  const cases: [string, string][] = [
    ['plain', 'Just text.'],
    ['lead and sections', 'Lead.\n\n## Notes\n\nnote\n\n## Plan\n\n1. a\n2. b'],
    ['no lead', '## Notes\n\nnote'],
    ['reserved heading stays text', 'Lead\n\n## Activity\n\nnot ours'],
    ['nested headings', 'Lead\n\n### Sub\n\ntext\n\n## Top\n\n#### deeper'],
    ['empty section', 'Lead\n\n## Empty\n\n## After\n\nx'],
    ['escaped-looking line', 'Lead\n\\## literally'],
    [
      'heading inside a fence',
      'Code:\n\n```\n## not a heading\n```\n\n## Real\n\nx',
    ],
  ];
  for (const [name, md] of cases) {
    it(`round-trips: ${name}`, () => {
      const body = bodyWithLinearDescription(TEMPLATE_BODY, md, true);
      expect(linearDescriptionFromBody(body, true)).toBe(
        canonicalMarkdown(md, true)
      );
      expect(canonicalMarkdown(md, true)).toBe(normalizeMarkdown(md));
    });
  }

  it('publishes Acceptance Criteria by default and keeps it local when opted out', () => {
    const body =
      '\n## Description\n\nLead\n\n## Acceptance Criteria\n\n- [ ] works\n\n## Activity\n\n- did a thing\n';
    expect(linearDescriptionFromBody(body, true)).toBe(
      'Lead\n\n## Acceptance Criteria\n\n- [ ] works'
    );
    expect(linearDescriptionFromBody(body, false)).toBe('Lead');
    const pulled = bodyWithLinearDescription(body, 'New lead', false);
    expect(getSection(pulled, 'Acceptance Criteria')).toBe('- [ ] works');
    expect(getSection(pulled, 'Activity')).toBe('- did a thing');
  });

  it('never publishes Activity or Links, and keeps both on a pull', () => {
    const body =
      '\n## Description\n\nLead\n\n## Links\n\n- [x](https://x.test)\n\n## Activity\n\n- log\n';
    expect(linearDescriptionFromBody(body, true)).toBe('Lead');
    const pulled = bodyWithLinearDescription(body, 'Other', true);
    expect(getSection(pulled, 'Links')).toBe('- [x](https://x.test)');
    expect(getSection(pulled, 'Activity')).toBe('- log');
    expect(pulled.indexOf('## Links')).toBeLessThan(
      pulled.indexOf('## Activity')
    );
  });
});

describe('links section', () => {
  it('round-trips attachments through the body', () => {
    const links = [
      { url: 'https://a.test/1', title: 'One' },
      { url: 'https://b.test/2', title: 'Two [draft]' },
    ];
    const body = bodyWithLinks(TEMPLATE_BODY, links);
    expect(linksFromBody(body)).toEqual([
      { url: 'https://a.test/1', title: 'One' },
      { url: 'https://b.test/2', title: 'Two draft' },
    ]);
    expect(body.indexOf('## Links')).toBeLessThan(body.indexOf('## Activity'));
    expect(bodyWithLinks(body, [])).not.toContain('## Links');
  });

  it('reads a bare URL bullet as a link titled by its URL', () => {
    const body = bodyWithLinks(TEMPLATE_BODY, []).replace(
      '## Activity',
      '## Links\n\n- https://c.test/3\n\n## Activity'
    );
    expect(linksFromBody(body)).toEqual([
      { url: 'https://c.test/3', title: 'https://c.test/3' },
    ]);
  });
});

function meta(
  id: string,
  kind: TaskMeta['kind'] = 'task',
  overrides: Partial<TaskMeta> = {}
): TaskMeta {
  return doc({ id, kind, ...overrides }).meta;
}

describe('several linked teams', () => {
  const OPS_STATES: LinearWorkflowState[] = [
    { id: 'o-todo', name: 'Todo', type: 'unstarted', position: 0 },
    { id: 'o-progress', name: 'In Progress', type: 'started', position: 0 },
    { id: 'o-done', name: 'Done', type: 'completed', position: 0 },
  ];
  const WEB_OPS: LinearLabel = {
    id: 'l-web-ops',
    name: 'web',
    color: '#111111',
    group: null,
    teamId: 'team-2',
  };

  function twoTeams(tasks: TaskMeta[]): LinearMapContext {
    const generated = statusesFromTeams([STATES, OPS_STATES]);
    return {
      ...context(tasks, { labels: [...LABELS, WEB_OPS] }),
      statusByState: new Map(Object.entries(generated.names)),
      teamStates: new Map([
        ['team-1', STATES],
        ['team-2', OPS_STATES],
      ]),
    };
  }

  it('reads an issue that moved between them as the same status', () => {
    const ctx = twoTeams(workspace());
    const here = blankIssue('i-x', { state: STATES[3] });
    const moved = blankIssue('i-x', {
      team: { id: 'team-2', key: 'OPS' },
      state: OPS_STATES[1],
    });
    expect(issueValues(here, ctx).state).toBe('In Progress');
    expect(issueValues(moved, ctx).state).toBe('In Progress');
  });

  it('pushes a status as the issue’s own team’s state, by type when it lacks one', () => {
    const ctx = twoTeams(workspace());
    const issue = blankIssue('i-x', {
      team: { id: 'team-2', key: 'OPS' },
      state: OPS_STATES[0],
    });
    const stateFor = (status: string) =>
      issuePush(
        doc(linked('t-x', 'issue', 'i-x', 'task', { status })),
        ['state'],
        issue,
        ctx
      ).input.stateId;
    expect(stateFor('In Progress')).toBe('o-progress');
    // QA is team-1's alone: team-2's first started state stands in.
    expect(stateFor('QA')).toBe('o-progress');
    expect(stateIdFor('team-1', 'QA', ctx)).toBe('s-qa');
    expect(stateIdFor('team-2', 'Triage', ctx)).toBeNull();
  });

  it('names the issue’s team’s label, else a workspace one', () => {
    const ctx = twoTeams(workspace());
    const issue = blankIssue('i-x', { team: { id: 'team-2', key: 'OPS' } });
    const task = doc(
      linked('t-x', 'issue', 'i-x', 'task', {
        labels: ['web', 'infra', 'Type/Bug'],
      })
    );
    expect(issuePush(task, ['labels'], issue, ctx).input.labelIds).toEqual([
      'l-infra',
      'l-web-ops',
    ]);
    expect(labelFor('WEB', 'team-1', ctx)?.id).toBe('l-web');
    // Type/Bug is team-1's own: team-2 would need one of its own.
    expect(missingLabels(task, ctx, 'team-2')).toEqual(['Type/Bug']);
    expect(missingLabels(task, ctx, 'team-1')).toEqual([]);
  });
});
