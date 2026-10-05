import {
  DISPATCH_DIR,
  loadConfig,
  parseTeam,
  resolvePeople,
  TeamParseError,
  UNRESOLVED_LINEAR_ASSIGNEE,
  UNRESOLVED_LINEAR_PERSON,
} from '@dispatch/core';
import type { Person, TeamMember } from '@dispatch/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ApiContext } from '../api.js';
import { humanActor } from './caller.js';
import { jsonResponse } from './http.js';

/** GET /api/people's body: everyone a picker offers, and who is asking. */
interface PeopleSnapshot {
  /** The caller's own ref. */
  me: string;
  /** The daemon's own human, whom a legacy bare `human` assignee means when a
   *  fan-out asks whose a task is (core's fanoutHolder). */
  local: string;
  people: Person[];
}

// team.yml's members; an unreadable roster (conflict markers) contributes
// nobody rather than failing the picker.
export function rosterMembers(rootDir: string): TeamMember[] {
  const file = join(rootDir, DISPATCH_DIR, 'team.yml');
  if (!existsSync(file)) return [];
  try {
    return parseTeam(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err instanceof TeamParseError) return [];
    throw err;
  }
}

// GET /api/people — the team roster merged with config `people` (see core's
// resolvePeople). Agents are not listed: executors come from /api/executors.
// While a task holds the Linear placeholder assignee, it is listed under a
// name that says so, never as a person called "linear-user".
export function listPeople(
  ctx: Pick<ApiContext, 'rootDir' | 'caller' | 'actorContext' | 'cache'>
): Response {
  const configured = loadConfig(ctx.rootDir).people ?? [];
  const people = resolvePeople(configured, rosterMembers(ctx.rootDir));
  if (
    ctx.cache.hasAssignee(UNRESOLVED_LINEAR_ASSIGNEE) &&
    !people.some((p) => p.ref === UNRESOLVED_LINEAR_ASSIGNEE)
  ) {
    people.push(UNRESOLVED_LINEAR_PERSON);
  }
  const snapshot: PeopleSnapshot = {
    me: humanActor(ctx),
    local: ctx.actorContext.humanRef,
    people,
  };
  return jsonResponse(snapshot);
}
