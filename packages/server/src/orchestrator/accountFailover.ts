import {
  accountToken,
  DEFAULT_ACCOUNT,
  readAgentAccounts,
} from '@dispatch-foo/core';

import type { RunAccount } from './types.js';

// Usage-limit failover across an executor's subscription accounts (t-2299c8c6).
//
// The accounts live in ~/.dispatch/credentials.json (core's agentAccounts.ts),
// read fresh on every decision so a `dispatch accounts add` takes effect on
// the next run without a daemon restart. What this class adds is which of
// them are out of usage right now: an account that stopped a run with a usage
// limit is skipped until its limit resets. That state is in memory only — a
// restarted daemon tries each account again, and the first run to hit a
// still-active limit marks it once more.
//
// The policy, applied in order [DEFAULT_ACCOUNT, ...stored accounts]:
// - with failover off, a run starts on its predecessor's account (or the
//   default) and a usage limit just fails it, as before;
// - with failover on, a run starts on its predecessor's account while that
//   one has usage, else on the first account that does; and a run a usage
//   limit stops continues on the first account that still has usage. When
//   every account is limited the run stays failed, for the limit-reset
//   resume (t-58ec03) to pick up.

// How long an account is skipped when its limit gave no reset time: the
// length of Claude's rolling session window.
export const UNKNOWN_RESET_MS = 5 * 60 * 60 * 1000;

/** Where the stored accounts come from; tests pass a fixed list. */
export interface AccountSource {
  failover(executor: string): boolean;
  /** Stored account labels in failover order, DEFAULT_ACCOUNT excluded. */
  labels(executor: string): string[];
  token(executor: string, label: string): string | undefined;
}

/** The accounts in credentials.json. */
const credentialsAccountSource: AccountSource = {
  failover: (executor) => readAgentAccounts(executor).failover,
  labels: (executor) =>
    readAgentAccounts(executor).accounts.map((a) => a.label),
  token: (executor, label) => accountToken(executor, label),
};

/** One account's place in the policy, as the accounts API reports it. */
export interface AccountStatus {
  label: string;
  /** ISO time its usage limit resets; absent while it has usage. */
  limitedUntil?: string;
}

export class AccountFailover {
  // `${executor}\0${label}` → epoch ms the account's limit resets.
  private readonly limited = new Map<string, number>();

  constructor(
    private readonly source: AccountSource = credentialsAccountSource,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * The account a run on `executor` starts on. `preferred` is the account of
   * the run it continues, if any. Undefined when the executor has no stored
   * accounts, so a machine that never set this up records nothing new.
   */
  accountFor(executor: string, preferred?: string): RunAccount | undefined {
    const order = this.order(executor);
    if (order === null) return undefined;
    const kept =
      preferred !== undefined && order.includes(preferred)
        ? preferred
        : DEFAULT_ACCOUNT;
    if (!this.source.failover(executor) || !this.isLimited(executor, kept)) {
      return this.credential(executor, kept);
    }
    const open = order.find((label) => !this.isLimited(executor, label));
    return this.credential(executor, open ?? kept);
  }

  /**
   * Records that `label` hit its usage limit, until `resetsAt` (ISO) or for
   * UNKNOWN_RESET_MS, and returns the account the stopped run continues on —
   * null when failover is off or no account still has usage.
   */
  afterLimit(
    executor: string,
    label: string,
    resetsAt?: string
  ): RunAccount | null {
    const parsed = resetsAt === undefined ? NaN : Date.parse(resetsAt);
    const until = Number.isFinite(parsed)
      ? parsed
      : this.now() + UNKNOWN_RESET_MS;
    this.limited.set(key(executor, label), until);
    const order = this.order(executor);
    if (order === null || !this.source.failover(executor)) return null;
    const next = order.find(
      (candidate) => candidate !== label && !this.isLimited(executor, candidate)
    );
    return next === undefined ? null : this.credential(executor, next);
  }

  /** Every account of `executor` in failover order, with its limit. */
  status(executor: string): AccountStatus[] {
    return (this.order(executor) ?? [DEFAULT_ACCOUNT]).map((label) => {
      const until = this.limited.get(key(executor, label));
      return until !== undefined && until > this.now()
        ? { label, limitedUntil: new Date(until).toISOString() }
        : { label };
    });
  }

  // [DEFAULT_ACCOUNT, ...stored], or null when nothing is stored.
  private order(executor: string): string[] | null {
    const labels = this.source.labels(executor);
    return labels.length === 0 ? null : [DEFAULT_ACCOUNT, ...labels];
  }

  private isLimited(executor: string, label: string): boolean {
    const until = this.limited.get(key(executor, label));
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.limited.delete(key(executor, label));
    return false;
  }

  /** The account `label` with its token, as a run is started on it. */
  credential(executor: string, label: string): RunAccount {
    const token =
      label === DEFAULT_ACCOUNT
        ? undefined
        : this.source.token(executor, label);
    return token === undefined ? { label } : { label, token };
  }
}

function key(executor: string, label: string): string {
  return `${executor}\0${label}`;
}
