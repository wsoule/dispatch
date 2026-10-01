import type { PolicyRuling, TaskRisk } from '@dispatch/core';
import { describePolicyAuthorization } from '@dispatch/core';
import type { DeliveryEngine, Message } from '@dispatch/protocol';
import { gateOf, MessagingError, SYSTEM_ADDRESS } from '@dispatch/protocol';
import { isAbsolute, posix, relative } from 'node:path';

import { scopeRequestEscapesRepo } from '../floor.js';
import { scopeExtensionTitle } from '../ledger.js';
import type { LedgerStorePort } from '../ledger.js';
import { consultProjectPolicy } from '../policyEngine.js';
import { SYSTEM_SENDER } from './gates.js';

// Under the MCP's 30-minute wait, so the daemon's deny is what the agent hears.
export const SCOPE_GATE_TTL_MS = 29 * 60_000;
export const SCOPE_EXPIRY_SWEEP_MS = 30_000;

const SCOPE_EXPIRED_BODY = `Expired: no one decided within ${SCOPE_GATE_TTL_MS / 60_000} minutes. Treat this as denied: proceed within your original fence, and report the blocker in your final summary and in a task_comment.`;

/**
 * Whether every path an agent asked to edit lies inside one of the given
 * checkouts (its run worktree, the project root) and outside `.git/`. The
 * policy engine auto-grants only such requests (rung 2 of the ladder,
 * docs/design/autonomy-ladder.md): a path that escapes the checkout, or the
 * repository's own metadata, blocks for a human at every rung. Paths are
 * taken as the agent wrote them — relative to its worktree, or absolute.
 */
export function scopePathsInsideRepo(
  paths: string[],
  roots: string[]
): boolean {
  return paths.every((path) => {
    const candidates = isAbsolute(path)
      ? roots.map((root) => relative(root, path))
      : [posix.normalize(path)];
    return candidates.some(
      (rel) =>
        rel !== '' &&
        rel !== '.' &&
        rel !== '..' &&
        !rel.startsWith('../') &&
        !isAbsolute(rel) &&
        rel !== '.git' &&
        !rel.startsWith('.git/')
    );
  });
}

type AutoRuling = Extract<PolicyRuling, { mode: 'auto' }>;

interface ScopePolicyDeps {
  rootDir: string;
  runOf(runId: string): { taskId: string; worktreePath: string } | null;
  taskOf(
    taskId: string
  ): { meta: { risk?: TaskRisk; parent: string | null } } | null;
}

interface ScopeEffectDeps extends ScopePolicyDeps {
  owner: string;
  ledgerStore: Pick<LedgerStorePort, 'add' | 'entriesFor'>;
  appendPolicyActivity(taskId: string, text: string): void;
  broadcastLedgerChanged(): void;
}

// The auto-grant ruling for a run's scope request, or null for a human: a path
// out of the repo or into .git/, a critical task, or an unknown run or task.
function scopeRulingFor(
  deps: ScopePolicyDeps,
  runId: string,
  paths: string[]
): AutoRuling | null {
  if (scopeRequestEscapesRepo(paths).length > 0) return null;
  const run = deps.runOf(runId);
  const task = run === null ? null : deps.taskOf(run.taskId);
  if (run === null || task === null) return null;
  if (!scopePathsInsideRepo(paths, [run.worktreePath, deps.rootDir]))
    return null;
  const ruling = consultProjectPolicy(deps.rootDir, 'scope', task.meta.risk);
  return ruling.mode === 'auto' ? ruling : null;
}

// Records a scope grant in the ledger (and, for a policy grant, the task's
// Activity). A replay finds the entry tagged with the gate id and skips.
export function applyScopeAnswer(
  deps: ScopeEffectDeps,
  question: Message,
  answer: Message
): 'applied' | 'skipped' | 'unresolved' {
  const gate = gateOf(question);
  if (gate?.type !== 'scope' || answer.choice !== 'grant') return 'skipped';
  const runId = question.from.slice('run:'.length);
  const run = deps.runOf(runId);
  const task = run === null ? null : deps.taskOf(run.taskId);
  if (run === null || task === null) return 'unresolved';
  const parent = task.meta.parent;
  const tag = `[gate ${question.id}]`;
  if (
    deps.ledgerStore
      .entriesFor(run.taskId, parent)
      .some((e) => e.detail.endsWith(tag))
  )
    return 'skipped';
  const byPolicy = answer.from === SYSTEM_ADDRESS;
  // Written before the ledger entry: a crash between the two repeats this
  // line on replay rather than losing it.
  if (byPolicy)
    deps.appendPolicyActivity(
      run.taskId,
      `[policy] ${scopeExtensionTitle(runId)}: ${gate.paths.join(', ')} — ${answer.body}`
    );
  const note = answer.body.trim() === '' ? '' : ` (${answer.body})`;
  deps.ledgerStore.add({
    kind: 'decision',
    title: scopeExtensionTitle(runId),
    detail: `${gate.paths.join(', ')} — ${gate.reason}${note} [decided by ${answer.from}] ${tag}`,
    authoredBy: byPolicy ? deps.owner : answer.from,
    epicId: parent,
    sourceTaskId: run.taskId,
  });
  deps.broadcastLedgerChanged();
  return 'applied';
}

// Answers a run's scope gate as the system when the project's policy rung
// covers it, resolving whether it did; never rejects, a failure is logged.
async function grantByPolicy(
  engine: DeliveryEngine,
  deps: ScopePolicyDeps,
  question: Message
): Promise<boolean> {
  const gate = gateOf(question);
  if (
    gate?.type !== 'scope' ||
    question.kind !== 'question' ||
    !question.from.startsWith('run:')
  )
    return false;
  try {
    const ruling = scopeRulingFor(
      deps,
      question.from.slice('run:'.length),
      gate.paths
    );
    if (ruling === null) return false;
    await engine.reply(
      question.id,
      {
        choice: 'grant',
        body: describePolicyAuthorization(ruling),
        data: { type: 'x-policy', gate: 'scope', rung: ruling.rung },
      },
      SYSTEM_SENDER
    );
    return true;
  } catch (err) {
    // A conflict means someone answered first; theirs stands.
    if (!(err instanceof MessagingError && err.code === 'conflict'))
      console.error('messaging: scope auto-grant failed', err);
    return false;
  }
}

// Grants a run's new scope gate as the system when policy covers it; anything
// else waits for a human.
export function installScopePolicy(
  engine: DeliveryEngine,
  deps: ScopePolicyDeps
): () => void {
  return engine.subscribe((e) => {
    if (e.type === 'message') void grantByPolicy(engine, deps, e.message);
  });
}

// Grants every open scope gate policy covers, catching a live grant that
// failed or that a crash cut off after the question was stored.
async function grantScopeGatesByPolicy(
  engine: DeliveryEngine,
  deps: ScopePolicyDeps
): Promise<number> {
  let granted = 0;
  for (const question of engine.openBlocking())
    if (await grantByPolicy(engine, deps, question)) granted++;
  return granted;
}

// One pass of the daemon's scope sweep: grants what policy covers, then
// expires the rest, so a failing grant phase never stops the expiry.
export async function sweepScopeGates(
  engine: DeliveryEngine,
  deps: ScopePolicyDeps,
  nowMs: () => number
): Promise<void> {
  try {
    await grantScopeGatesByPolicy(engine, deps);
  } catch (err) {
    console.error('messaging: scope grant sweep failed', err);
  }
  try {
    await expireScopeGates(engine, nowMs());
  } catch (err) {
    console.error('messaging: scope expiry sweep failed', err);
  }
}

// Denies, as the system, every open scope gate nobody decided within the TTL.
// One that cannot be denied is logged and left for the next sweep.
export async function expireScopeGates(
  engine: DeliveryEngine,
  nowMs: number
): Promise<number> {
  let expired = 0;
  for (const question of engine.openBlocking()) {
    if (gateOf(question)?.type !== 'scope') continue;
    if (nowMs - Date.parse(question.createdAt) <= SCOPE_GATE_TTL_MS) continue;
    try {
      await engine.reply(
        question.id,
        {
          body: SCOPE_EXPIRED_BODY,
          choice: 'deny',
          data: { type: 'x-expired' },
        },
        SYSTEM_SENDER
      );
      expired++;
    } catch (err) {
      if (!(err instanceof MessagingError && err.code === 'conflict'))
        console.error(
          `messaging: could not expire scope gate ${question.id}`,
          err
        );
    }
  }
  return expired;
}
