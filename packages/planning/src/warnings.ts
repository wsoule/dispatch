// The warning plan and daily digests (§2.9). planWarnings decides what is
// worth telling people today given what was already told; buildDigests
// turns those notices into one message per person.

import { DAY_MS, diffDays, elapsedMs, isValidIsoDate } from './dates';
import { missingLine, paceLine, stalledLine, unassignedLine } from './labels';
import { compareIssues, compareMilestones, orderProjects } from './ordering';
import { isIssueOpen, milestoneTargetDate } from './snapshot';
import type {
  AllocationPlan,
  Digest,
  DigestIssue,
  DigestItem,
  EvalContext,
  IsoDate,
  Issue,
  Milestone,
  MilestoneAssessment,
  Notice,
  NoticeKind,
  Snapshot,
  WarningMemory,
  WarningPlan,
} from './types';

const KIND_ORDER: Record<NoticeKind, number> = {
  overdue: 0,
  at_risk: 1,
  invalid_due_soon: 2,
  allocation_blocked: 3,
};

// Memory rows are keyed by subject kind + id (a milestone and a project
// could share an id in fixtures).
function subjectKey(kind: WarningMemory['subjectKind'], id: string): string {
  return `${kind}\u0000${id}`;
}

// Active users from `ids`, first occurrence wins, unknown and deactivated
// users dropped.
function activeRecipients(
  snapshot: Snapshot,
  ids: readonly (string | null)[],
  canSee: (userId: string) => boolean
): string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const id of ids) {
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    if (snapshot.users.get(id)?.active === true && canSee(id)) {
      recipients.push(id);
    }
  }
  return recipients;
}

// Whether a person may hear about a project. Better Tracker hid projects in
// private Linear teams; a Dispatch project is one team everyone on it sees,
// so anyone may, as long as the project exists.
function projectVisibility(
  snapshot: Snapshot
): (userId: string, projectId: string) => boolean {
  return (_userId, projectId) => snapshot.projects.has(projectId);
}

// The open issues of a milestone in display order, plus the unassigned ones
// among them.
function openIssuesOf(
  snapshot: Snapshot,
  milestoneId: string | null
): { open: string[]; unassigned: string[] } {
  if (milestoneId === null) return { open: [], unassigned: [] };
  const issues: Issue[] = (snapshot.issuesByMilestone.get(milestoneId) ?? [])
    .filter((issue) => isIssueOpen(snapshot, issue))
    .sort(compareIssues);
  return {
    open: issues.map((issue) => issue.id),
    unassigned: issues
      .filter((issue) => issue.assigneeId === null)
      .map((issue) => issue.id),
  };
}

// The §2.9 classification of one milestone: which notice kind it calls for
// (null = nothing to report) and the dedupe key that describes its state.
function classifyMilestone(
  milestone: Milestone,
  assessment: MilestoneAssessment,
  warnLeadDays: number
): { kind: NoticeKind | null; key: string } {
  const target = milestoneTargetDate(milestone) ?? '';
  const { daysLeft, rubric, status } = assessment;
  if (status === 'overdue') {
    return { kind: 'overdue', key: `overdue:${target}` };
  }
  // A complete milestone has nothing left to act on, so a rubric gap on it
  // (e.g. it never got a "done means…") is not worth a warning (§4: no spam).
  if (
    status !== 'complete' &&
    !rubric.valid &&
    daysLeft !== null &&
    daysLeft >= 0 &&
    daysLeft <= warnLeadDays
  ) {
    return {
      kind: 'invalid_due_soon',
      key: `invalid:${target}:${rubric.gaps.join(',')}`,
    };
  }
  if (status === 'at_risk') {
    return { kind: 'at_risk', key: `at_risk:${target}` };
  }
  return { kind: null, key: `ok:${status}` };
}

/**
 * The send rule (§2.9): notify when the key differs from the remembered
 * one, or when an overdue subject was last told `overdueRepeatDays` or more
 * days ago. `occurrence` counts consecutive sends for the same key. A
 * remembered notifiable key with no (or an unreadable) last-notified day is
 * sent again rather than kept quiet.
 */
export function decideSend(input: {
  previous: WarningMemory | undefined;
  kind: NoticeKind | null;
  key: string;
  today: IsoDate;
  overdueRepeatDays: number;
}): { send: boolean; occurrence: number } {
  const { previous, kind, key } = input;
  if (kind === null) return { send: false, occurrence: 0 };
  if (previous === undefined || previous.lastKey !== key) {
    return { send: true, occurrence: 1 };
  }
  const repeat = { send: true, occurrence: previous.occurrence + 1 };
  const last = previous.lastNotifiedOn;
  if (last === null || !isValidIsoDate(last)) return repeat;
  if (
    kind === 'overdue' &&
    diffDays(input.today, last) >= input.overdueRepeatDays
  ) {
    return repeat;
  }
  return { send: false, occurrence: previous.occurrence };
}

/**
 * Evaluates every milestone and project in active projects against the
 * remembered warning state (§2.9) and returns today's notices plus the
 * memory rows to save (one per evaluated subject, including quiet ones, so
 * a milestone that recovers and slips again is announced again).
 */
export function planWarnings(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  allocationPlan: AllocationPlan;
  memory: readonly WarningMemory[];
  watcherUserIds: readonly string[];
}): WarningPlan {
  const { snapshot, ctx, assessments } = input;
  const { tuning, today } = ctx;
  const active = new Set(tuning.activeProjectStatuses);
  const isActiveProject = (projectId: string): boolean => {
    const project = snapshot.projects.get(projectId);
    return project !== undefined && active.has(project.statusType);
  };
  const remembered = new Map<string, WarningMemory>();
  for (const row of input.memory) {
    remembered.set(subjectKey(row.subjectKind, row.subjectId), row);
  }

  const notices: Notice[] = [];
  const memory: WarningMemory[] = [];
  const sees = projectVisibility(snapshot);

  // Records the outcome for one subject and, when the rule says so, emits
  // its notice.
  const evaluate = (
    subjectKind: WarningMemory['subjectKind'],
    subjectId: string,
    kind: NoticeKind | null,
    key: string,
    buildNotice: (kind: NoticeKind, occurrence: number) => Notice
  ): void => {
    const previous = remembered.get(subjectKey(subjectKind, subjectId));
    const { send, occurrence } = decideSend({
      previous,
      kind,
      key,
      today,
      overdueRepeatDays: tuning.overdueRepeatDays,
    });
    if (send && kind !== null) notices.push(buildNotice(kind, occurrence));
    memory.push({
      subjectKind,
      subjectId,
      lastKey: key,
      lastNotifiedOn: send ? today : (previous?.lastNotifiedOn ?? null),
      occurrence,
    });
  };

  const milestones = snapshot.data.milestones
    .filter((m) => isActiveProject(m.projectId))
    .sort(compareMilestones(snapshot, ctx, assessments));
  for (const milestone of milestones) {
    const assessment = assessments.get(milestone.id);
    if (assessment === undefined) continue;
    const { kind, key } = classifyMilestone(
      milestone,
      assessment,
      tuning.warnLeadDays
    );
    evaluate('milestone', milestone.id, kind, key, (noticeKind, occurrence) => {
      const issues = openIssuesOf(snapshot, milestone.id);
      const project = snapshot.projects.get(milestone.projectId);
      return {
        kind: noticeKind,
        subjectKind: 'milestone',
        subjectId: milestone.id,
        projectId: milestone.projectId,
        milestoneId: milestone.id,
        key,
        targetDate: milestoneTargetDate(milestone),
        daysLeft: assessment.daysLeft,
        reasons: [...assessment.reasons],
        gaps: [...assessment.rubric.gaps],
        blockReason: null,
        openIssueIds: issues.open,
        unassignedIssueIds: issues.unassigned,
        recipientIds: activeRecipients(
          snapshot,
          [project?.leadId ?? null, ...input.watcherUserIds],
          (id) => sees(id, milestone.projectId)
        ),
        occurrence,
      };
    });
  }

  for (const plan of input.allocationPlan.projects) {
    if (!isActiveProject(plan.projectId)) continue;
    const blocked = plan.outcome === 'blocked' && plan.blockReason !== null;
    const key = blocked
      ? `blocked:${plan.blockReason}:${plan.nextMilestoneId ?? ''}:${plan.gaps.join(',')}`
      : 'ok';
    evaluate(
      'project',
      plan.projectId,
      blocked ? 'allocation_blocked' : null,
      key,
      (noticeKind, occurrence) => {
        const issues = openIssuesOf(snapshot, plan.nextMilestoneId);
        const next =
          plan.nextMilestoneId === null
            ? undefined
            : snapshot.milestones.get(plan.nextMilestoneId);
        const project = snapshot.projects.get(plan.projectId);
        return {
          kind: noticeKind,
          subjectKind: 'project',
          subjectId: plan.projectId,
          projectId: plan.projectId,
          milestoneId: plan.nextMilestoneId,
          key,
          targetDate: next === undefined ? null : milestoneTargetDate(next),
          daysLeft:
            plan.nextMilestoneId === null
              ? null
              : (assessments.get(plan.nextMilestoneId)?.daysLeft ?? null),
          reasons: [],
          gaps: [...plan.gaps],
          blockReason: plan.blockReason,
          openIssueIds: issues.open,
          unassignedIssueIds: issues.unassigned,
          recipientIds: activeRecipients(
            snapshot,
            [...input.watcherUserIds, project?.leadId ?? null],
            (id) => sees(id, plan.projectId)
          ),
          occurrence,
        };
      }
    );
  }

  return { notices, memory };
}

// Plain-language lines explaining one notice (§2.9), e.g. "3 open issues
// unassigned", "no state change in 9 days", "2/7 done with 2 days left",
// "missing: done means…".
function noticeLines(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessment: MilestoneAssessment | undefined,
  notice: Notice
): string[] {
  const lines: string[] = [];
  const unassigned = notice.unassignedIssueIds.length;

  if (notice.subjectKind === 'project') {
    const project = snapshot.projects.get(notice.projectId);
    const lead =
      project?.leadId == null ? undefined : snapshot.users.get(project.leadId);
    const milestone =
      notice.milestoneId === null
        ? undefined
        : snapshot.milestones.get(notice.milestoneId);
    if (notice.blockReason === 'no_lead') {
      lines.push('no project lead, so nothing is being assigned');
    } else if (notice.blockReason === 'lead_inactive') {
      const who =
        lead === undefined ? 'project lead' : `project lead ${lead.name}`;
      lines.push(
        `${who} is deactivated in Linear, so nothing is being assigned`
      );
    } else if (notice.blockReason === 'next_milestone_invalid') {
      const which =
        milestone === undefined
          ? 'next milestone'
          : `next milestone ${milestone.name}`;
      lines.push(`${which} is ${missingLine(notice.gaps)}`);
    }
    if (unassigned > 0) lines.push(unassignedLine(unassigned));
    return lines;
  }

  const progress = assessment?.progress;
  const daysLeft = notice.daysLeft;
  const paceText =
    progress !== undefined && daysLeft !== null
      ? paceLine(progress.completed, progress.scope, daysLeft)
      : null;
  // An overdue notice always says how far along it is and how late.
  if (
    notice.kind === 'overdue' &&
    paceText !== null &&
    !notice.reasons.includes('behind_pace')
  ) {
    lines.push(paceText);
  }
  for (const reason of notice.reasons) {
    if (reason === 'unassigned_open') {
      lines.push(unassignedLine(unassigned));
    } else if (reason === 'stalled') {
      const since =
        assessment?.lastStateChangeAt == null
          ? null
          : elapsedMs(ctx.now, assessment.lastStateChangeAt);
      if (since !== null) lines.push(stalledLine(Math.floor(since / DAY_MS)));
    } else if (paceText !== null) {
      lines.push(paceText);
    }
  }
  if (notice.gaps.length > 0) lines.push(missingLine(notice.gaps));
  return lines;
}

/**
 * A link that leaves the planner (a digest's, architecture §7 "Links that
 * leave the app"), naming the workspace it is about: `ws=<org id>` is
 * appended with `?` or `&`, so a browser that holds several workspaces
 * (owner decision 2026-10-25) opens it in the right one (the planner's
 * /open interstitial). In-app links never carry it.
 */
export function withWorkspaceParam(url: string, workspaceId: string): string {
  const hash = url.indexOf('#');
  const base = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? '' : url.slice(hash);
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}ws=${encodeURIComponent(workspaceId)}${fragment}`;
}

// The open issues a notice counts, named so the message says what is open
// and what is unassigned (§7.5), each linked to its planner issue page.
// Keeps `openIssueIds` order (display order); ids missing from the snapshot
// are skipped.
function digestIssues(
  snapshot: Snapshot,
  notice: Notice,
  baseUrl: string,
  workspaceId: string
): DigestIssue[] {
  const unassigned = new Set(notice.unassignedIssueIds);
  const issues: DigestIssue[] = [];
  for (const id of notice.openIssueIds) {
    const issue = snapshot.issues.get(id);
    if (issue === undefined) continue;
    issues.push({
      id,
      identifier: issue.identifier,
      title: issue.title,
      unassigned: unassigned.has(id),
      url: withWorkspaceParam(
        `${baseUrl}/issues/${encodeURIComponent(issue.identifier)}`,
        workspaceId
      ),
    });
  }
  return issues;
}

/**
 * One digest per recipient for today (§6.8). Items are sorted overdue →
 * at_risk → invalid_due_soon → allocation_blocked, then by milestone
 * display order (project notices by their next milestone, else timeline
 * order). Digests are ordered by recipient name. Unknown or deactivated
 * recipients get nothing. Every link carries `ws=<workspaceId>`
 * (withWorkspaceParam).
 */
export function buildDigests(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  notices: readonly Notice[];
  appUrl: string;
  /** The workspace the digests are about (its Linear org id). */
  workspaceId: string;
}): Digest[] {
  const { snapshot, ctx, assessments } = input;
  const baseUrl = input.appUrl.replace(/\/+$/, '');
  const milestoneOrder = compareMilestones(snapshot, ctx, assessments);
  const projectRank = new Map<string, number>();
  orderProjects(snapshot).forEach((project, index) =>
    projectRank.set(project.id, index)
  );

  // Item order: notice kind, then milestone display order (items without a
  // milestone last), then timeline project order, then subject id.
  const compareItems = (a: DigestItem, b: DigestItem): number => {
    const byKind = KIND_ORDER[a.notice.kind] - KIND_ORDER[b.notice.kind];
    if (byKind !== 0) return byKind;
    const ma =
      a.notice.milestoneId === null
        ? undefined
        : snapshot.milestones.get(a.notice.milestoneId);
    const mb =
      b.notice.milestoneId === null
        ? undefined
        : snapshot.milestones.get(b.notice.milestoneId);
    if (ma !== undefined && mb !== undefined) {
      const byMilestone = milestoneOrder(ma, mb);
      if (byMilestone !== 0) return byMilestone;
    } else if (ma !== undefined) {
      return -1;
    } else if (mb !== undefined) {
      return 1;
    }
    const byProject =
      (projectRank.get(a.notice.projectId) ?? Number.MAX_SAFE_INTEGER) -
      (projectRank.get(b.notice.projectId) ?? Number.MAX_SAFE_INTEGER);
    if (byProject !== 0) return byProject;
    const sa = a.notice.subjectId;
    const sb = b.notice.subjectId;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };

  const itemsByRecipient = new Map<string, DigestItem[]>();
  for (const notice of input.notices) {
    const project = snapshot.projects.get(notice.projectId);
    const milestone =
      notice.milestoneId === null
        ? undefined
        : snapshot.milestones.get(notice.milestoneId);
    const assessment =
      notice.milestoneId === null
        ? undefined
        : assessments.get(notice.milestoneId);
    const lead =
      project?.leadId == null ? undefined : snapshot.users.get(project.leadId);
    const url = withWorkspaceParam(
      notice.subjectKind === 'milestone'
        ? `${baseUrl}/timeline?milestone=${encodeURIComponent(notice.subjectId)}`
        : `${baseUrl}/timeline?project=${encodeURIComponent(notice.subjectId)}`,
      input.workspaceId
    );
    const item: DigestItem = {
      notice,
      projectName: project?.name ?? notice.projectId,
      milestoneName: milestone?.name ?? null,
      leadName: lead?.name ?? null,
      openCount: notice.openIssueIds.length,
      unassignedCount: notice.unassignedIssueIds.length,
      openIssues: digestIssues(snapshot, notice, baseUrl, input.workspaceId),
      lines: noticeLines(snapshot, ctx, assessment, notice),
      url,
    };
    for (const recipientId of new Set(notice.recipientIds)) {
      if (snapshot.users.get(recipientId)?.active !== true) continue;
      const items = itemsByRecipient.get(recipientId);
      if (items === undefined) itemsByRecipient.set(recipientId, [item]);
      else items.push(item);
    }
  }

  const digests: Digest[] = [];
  for (const [recipientId, items] of itemsByRecipient) {
    const user = snapshot.users.get(recipientId);
    if (user === undefined) continue;
    digests.push({
      recipientId,
      recipientName: user.name,
      recipientEmail: user.email,
      day: ctx.today,
      items: items.sort(compareItems),
    });
  }
  return digests.sort((a, b) => {
    const na = a.recipientName.toLowerCase();
    const nb = b.recipientName.toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    return a.recipientId < b.recipientId
      ? -1
      : a.recipientId > b.recipientId
        ? 1
        : 0;
  });
}
