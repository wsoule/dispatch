import type {
  BlockingRelation,
  Initiative,
  IsoDate,
  IsoDateTime,
  Issue,
  IssueExtras,
  IssueLabel,
  IssuePatch,
  Milestone,
  Project,
  User,
  WorkspaceData,
} from '@dispatch/planning';

/** Registered Linear OAuth application credentials. */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** Must match a callback URL registered on the Linear OAuth app. */
  redirectUri: string;
}

/** Result of a token exchange or refresh. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry computed from expires_in; null if not provided. */
  expiresAt: IsoDateTime | null;
  scopes: string[];
}

/** The identity a Linear access token acts as. */
export interface LinearIdentity {
  /** The viewer: the human for actor=user tokens, the app user for actor=app. */
  user: User;
  workspace: { id: string; name: string; urlKey: string };
}

/**
 * Everything the tool reads from or writes to Linear, behind one interface so
 * the engine can run against the real API, the in-memory fixture workspace
 * (demo mode), or test doubles.
 *
 * Writes are the ones the design allows (§8, and the owner decisions of
 * 2026-10-21 and 2026-10-22): allocation's issue assignee + state and
 * comment, and a signed-in person's milestone target dates, project leads
 * and own issue edits (fields, comments, blocking relations), which the
 * engine always sends with that person's token.
 */
/** A full fetch also names the workspace, so a grant can follow a rename. */
export type FetchedWorkspace = WorkspaceData & {
  organization?: { name: string; urlKey: string };
};

export interface LinearGateway {
  whoAmI(): Promise<LinearIdentity>;

  /**
   * Full mirror of the workspace: all users, teams, workflow states,
   * initiatives, non-archived projects with their milestones, issues that
   * belong to a project (open and closed), open issues without a project,
   * and "blocks" relations. Issue.lastStateChangeAt is the approximation
   * from timestamps; call fetchLastStateChanges to refine it.
   */
  fetchWorkspace(): Promise<FetchedWorkspace>;

  /** When each issue last changed workflow state, from issue history. */
  fetchLastStateChanges(issueIds: string[]): Promise<Map<string, IsoDateTime>>;

  /** null when the issue no longer exists or is archived. */
  fetchIssue(id: string): Promise<Issue | null>;
  /** Every "blocks" relation the issue takes part in, either side. */
  fetchIssueRelations(issueId: string): Promise<BlockingRelation[]>;
  /** The project and all its milestones; null when gone or archived. */
  fetchProject(
    id: string
  ): Promise<{ project: Project; milestones: Milestone[] } | null>;
  fetchMilestone(id: string): Promise<Milestone | null>;
  fetchUser(id: string): Promise<User | null>;
  fetchInitiative(id: string): Promise<Initiative | null>;

  /** Assigns and/or moves an issue; returns the updated issue. */
  updateIssue(
    id: string,
    input: { assigneeId?: string; stateId?: string }
  ): Promise<Issue>;
  createComment(issueId: string, body: string): Promise<{ id: string }>;
  updateMilestoneTargetDate(
    id: string,
    targetDate: IsoDate | null
  ): Promise<Milestone>;
  updateProjectLead(id: string, leadId: string | null): Promise<Project>;

  // --- issue page (owner decision 2026-10-21; additive) -------------------

  /**
   * The issue's fields the mirror does not keep (description, labels,
   * estimate, due date, comments oldest first, the team's estimate scale),
   * read live. Null when the issue no longer exists or is archived.
   * Comments are capped at ISSUE_COMMENTS_MAX (`commentsTruncated` says
   * when Linear holds more).
   */
  fetchIssueDetail(issueId: string): Promise<IssueExtras | null>;
  /**
   * Labels that can be applied to the team's issues: the team's own and
   * the workspace's, archived ones and label groups left out, by name.
   */
  listIssueLabels(teamId: string): Promise<IssueLabel[]>;
  /**
   * Edits an issue (a person's own edit): sends exactly the patch's keys
   * and returns the updated issue in the shape the sync mirrors. Linear's
   * refusals (invalid estimate, label, state…) arrive as LinearApiError
   * with a readable message.
   */
  updateIssueFields(issueId: string, patch: IssuePatch): Promise<Issue>;
  /** Creates "blocker blocks blocked" and returns the relation. */
  createBlockingRelation(
    blockerIssueId: string,
    blockedIssueId: string
  ): Promise<BlockingRelation>;
  /** Deletes an issue relation; LinearApiError('not_found') when it is gone. */
  deleteRelation(relationId: string): Promise<void>;
}

/** Thrown by gateways for API failures, with enough detail to log and show. */
export class LinearApiError extends Error {
  readonly kind:
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'rate_limited'
    | 'invalid_input'
    | 'network'
    | 'server'
    | 'graphql';
  /** For rate_limited: when Linear says the limit resets. */
  readonly retryAt: IsoDateTime | null;

  constructor(
    kind: LinearApiError['kind'],
    message: string,
    options: { retryAt?: IsoDateTime | null; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'LinearApiError';
    this.kind = kind;
    this.retryAt = options.retryAt ?? null;
  }
}
