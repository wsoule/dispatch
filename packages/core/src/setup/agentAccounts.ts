import {
  type CredentialsFile,
  readCredentials,
  type StoredAgentAccount,
  type StoredAgentAccounts,
  updateCredentialsFile,
} from '../credentials.js';

// Extra subscription accounts an executor can fail over to when the one it is
// running on hits its usage limit. Each is a long-lived OAuth token (from
// `claude setup-token`) the executor is handed as CLAUDE_CODE_OAUTH_TOKEN, so
// the CLI's own config directory, and with it every session transcript a
// resume needs, stays the same whichever account runs. The machine's normal
// `claude login` is the implicit DEFAULT_ACCOUNT, always first in order.

/** The executors that take stored accounts. */
export const ACCOUNT_EXECUTORS = ['claude'] as const;

/** The label of the executor's own login, which no stored account may take. */
export const DEFAULT_ACCOUNT = 'default';

// Labels are shown in Activity lines and typed on the CLI.
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** One executor's accounts as a caller sees them; tokens never leave here
 *  except through accountToken. */
export interface AgentAccountsView {
  executor: string;
  failover: boolean;
  /** Stored accounts in failover order, after DEFAULT_ACCOUNT. */
  accounts: { label: string; addedAt: string }[];
}

function stored(executor: string): StoredAgentAccounts {
  try {
    return readCredentials().agentAccounts?.[executor] ?? {};
  } catch {
    // An unreadable credentials file costs failover, not the run.
    return {};
  }
}

function requireExecutor(executor: string): void {
  if (!(ACCOUNT_EXECUTORS as readonly string[]).includes(executor)) {
    throw new Error(`${executor} does not take stored accounts`);
  }
}

// Applies `change` to one executor's entry and drops it once it is empty.
function updateExecutor(
  executor: string,
  change: (entry: StoredAgentAccounts) => StoredAgentAccounts
): void {
  updateCredentialsFile((file) => {
    const all = { ...(file.agentAccounts ?? {}) };
    const next = change({ ...(all[executor] ?? {}) });
    if ((next.accounts ?? []).length === 0 && next.failover !== true) {
      delete all[executor];
    } else {
      all[executor] = next;
    }
    const out: CredentialsFile = { ...file, agentAccounts: all };
    if (Object.keys(all).length === 0) delete out.agentAccounts;
    return out;
  });
}

/** One executor's stored accounts and failover switch, without tokens. */
export function readAgentAccounts(executor: string): AgentAccountsView {
  const entry = stored(executor);
  return {
    executor,
    failover: entry.failover === true,
    accounts: (entry.accounts ?? []).map(({ label, addedAt }) => ({
      label,
      addedAt,
    })),
  };
}

/** The token stored under `label`, or undefined (DEFAULT_ACCOUNT has none). */
export function accountToken(
  executor: string,
  label: string
): string | undefined {
  return stored(executor).accounts?.find((a) => a.label === label)?.token;
}

/** Stores (or replaces the token of) the account `label`. A new label goes
 *  last in failover order; a replaced one keeps its place. */
export function addAgentAccount(
  executor: string,
  label: string,
  token: string,
  now: string = new Date().toISOString()
): void {
  requireExecutor(executor);
  if (!LABEL.test(label)) {
    throw new Error(
      'account label must be 1-64 letters, digits, ".", "_", "@" or "-"'
    );
  }
  if (label === DEFAULT_ACCOUNT) {
    throw new Error(`"${DEFAULT_ACCOUNT}" is the executor's own login`);
  }
  const trimmed = token.trim();
  if (trimmed === '') throw new Error('account token is empty');
  updateExecutor(executor, (entry) => {
    const accounts: StoredAgentAccount[] = [...(entry.accounts ?? [])];
    const at = accounts.findIndex((a) => a.label === label);
    if (at === -1) accounts.push({ label, token: trimmed, addedAt: now });
    else accounts[at] = { ...accounts[at], token: trimmed };
    return { ...entry, accounts };
  });
}

/** Removes the account `label`; false when there was none. */
export function removeAgentAccount(executor: string, label: string): boolean {
  requireExecutor(executor);
  let removed = false;
  updateExecutor(executor, (entry) => {
    const accounts = (entry.accounts ?? []).filter((a) => a.label !== label);
    removed = accounts.length !== (entry.accounts ?? []).length;
    return { ...entry, accounts };
  });
  return removed;
}

/** Turns usage-limit failover on or off for one executor. */
export function setAccountFailover(executor: string, enabled: boolean): void {
  requireExecutor(executor);
  updateExecutor(executor, (entry) => {
    const next = { ...entry };
    if (enabled) next.failover = true;
    else delete next.failover;
    return next;
  });
}
