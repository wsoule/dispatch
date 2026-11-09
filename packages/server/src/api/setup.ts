import {
  ACCOUNT_EXECUTORS,
  addAgentAccount,
  defaultSetupCheckDeps,
  providerById,
  readAgentAccounts,
  removeAgentAccount,
  runSetupCheck,
  setAccountFailover,
  type SetupCheckDeps,
  writeAgentKey,
} from '@dispatch-foo/core';

import type { ApiContext } from '../api.js';
import { refreshExecutors } from '../index.js';
import { errorResponse, jsonResponse, readJsonBody } from './http.js';

// The routes under /api/setup: what this machine still needs before an agent can
// run, saving an agent API key, picking up agents installed since boot, and the
// subscription accounts a usage-limited run fails over to.

type SetupRouteContext = Pick<
  ApiContext,
  'rootDir' | 'orchestrator' | 'planManager' | 'overseerManager'
>;

let depsFactory: () => SetupCheckDeps = defaultSetupCheckDeps;

/** Tests swap in scripted probes; null restores the real ones. */
export function setSetupCheckDepsForTest(
  factory: (() => SetupCheckDeps) | null
): void {
  depsFactory = factory ?? defaultSetupCheckDeps;
}

async function report(ctx: SetupRouteContext): Promise<Response> {
  return jsonResponse(
    await runSetupCheck(
      {
        rootDir: ctx.rootDir,
        defaultExecutor: ctx.orchestrator.defaultExecutorName(),
      },
      depsFactory()
    )
  );
}

export async function handleSetupRoute(
  req: Request,
  method: string,
  segments: readonly string[],
  ctx: SetupRouteContext
): Promise<Response | null> {
  if (segments.length === 1 && method === 'GET') return report(ctx);

  if (
    segments.length === 2 &&
    segments[1] === 'agent-key' &&
    method === 'POST'
  ) {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value as { provider?: unknown; apiKey?: unknown };
    const spec =
      typeof body.provider === 'string'
        ? providerById(body.provider)
        : undefined;
    if (spec?.apiKeyEnv === undefined)
      return errorResponse(400, 'provider takes no API key');
    if (body.apiKey !== null && typeof body.apiKey !== 'string')
      return errorResponse(400, 'apiKey must be a string or null');
    writeAgentKey(spec.apiKeyEnv, body.apiKey);
    return report(ctx);
  }

  if (segments[1] === 'accounts') {
    return handleAccountsRoute(req, method, segments, ctx);
  }

  if (segments.length === 2 && segments[1] === 'refresh' && method === 'POST') {
    return jsonResponse({
      added: refreshExecutors(ctx.orchestrator, ctx.rootDir, ctx),
    });
  }
  return null;
}

/** One executor's accounts in failover order, default login first, with
 *  which are out of usage. Tokens are never returned. */
interface AccountsReportEntry {
  executor: string;
  failover: boolean;
  accounts: { label: string; addedAt?: string; limitedUntil?: string }[];
}

function accountsReport(ctx: SetupRouteContext): Response {
  const executors: AccountsReportEntry[] = ACCOUNT_EXECUTORS.map((executor) => {
    const stored = readAgentAccounts(executor);
    const addedAt = new Map(stored.accounts.map((a) => [a.label, a.addedAt]));
    return {
      executor,
      failover: stored.failover,
      accounts: ctx.orchestrator.accounts.status(executor).map((status) => {
        const added = addedAt.get(status.label);
        return added === undefined ? status : { ...status, addedAt: added };
      }),
    };
  });
  return jsonResponse({ executors });
}

function accountExecutor(value: unknown): string | null {
  return typeof value === 'string' &&
    (ACCOUNT_EXECUTORS as readonly string[]).includes(value)
    ? value
    : null;
}

// /api/setup/accounts: GET lists them; POST stores one ({ executor, label,
// token }); POST /failover switches failover ({ executor, enabled }); DELETE
// /:executor/:label removes one. Every write answers with the new list.
async function handleAccountsRoute(
  req: Request,
  method: string,
  segments: readonly string[],
  ctx: SetupRouteContext
): Promise<Response | null> {
  if (segments.length === 2 && method === 'GET') return accountsReport(ctx);

  if (segments.length === 2 && method === 'POST') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value as {
      executor?: unknown;
      label?: unknown;
      token?: unknown;
    };
    const executor = accountExecutor(body.executor);
    if (executor === null) {
      return errorResponse(400, 'executor does not take stored accounts');
    }
    if (typeof body.label !== 'string' || typeof body.token !== 'string') {
      return errorResponse(400, 'label and token must be strings');
    }
    try {
      addAgentAccount(executor, body.label, body.token);
    } catch (err) {
      return errorResponse(400, (err as Error).message);
    }
    return accountsReport(ctx);
  }

  if (
    segments.length === 3 &&
    segments[2] === 'failover' &&
    method === 'POST'
  ) {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value as { executor?: unknown; enabled?: unknown };
    const executor = accountExecutor(body.executor);
    if (executor === null) {
      return errorResponse(400, 'executor does not take stored accounts');
    }
    if (typeof body.enabled !== 'boolean') {
      return errorResponse(400, 'enabled must be a boolean');
    }
    setAccountFailover(executor, body.enabled);
    return accountsReport(ctx);
  }

  if (segments.length === 4 && method === 'DELETE') {
    const executor = accountExecutor(segments[2]);
    if (executor === null) {
      return errorResponse(400, 'executor does not take stored accounts');
    }
    const label = decodeURIComponent(segments[3]);
    if (!removeAgentAccount(executor, label)) {
      return errorResponse(404, `no account named ${label}`);
    }
    return accountsReport(ctx);
  }
  return null;
}
