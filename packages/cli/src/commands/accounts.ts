import {
  ACCOUNT_EXECUTORS,
  addAgentAccount,
  DEFAULT_ACCOUNT,
  readAgentAccounts,
  removeAgentAccount,
  setAccountFailover,
} from '@dispatch-foo/core';
import type { Command } from 'commander';

import type { CliContext } from '../context.js';
import { CliError } from '../context.js';
import { readSecret } from './secret.js';

// `dispatch accounts`: the extra subscription accounts a usage-limited run
// fails over to (t-2299c8c6). They live in ~/.dispatch/credentials.json, which
// the daemon reads fresh on every run, so these write the file directly and
// work whether or not a daemon is up.

function executorOption(value: string | undefined): string {
  const executor = value ?? 'claude';
  if (!(ACCOUNT_EXECUTORS as readonly string[]).includes(executor)) {
    throw new CliError(
      `${executor} does not take stored accounts (only ${ACCOUNT_EXECUTORS.join(', ')})`
    );
  }
  return executor;
}

/** The failover order as a person reads it, one account per line. */
function describeAccounts(executor: string): string[] {
  const view = readAgentAccounts(executor);
  return [
    `${executor}: failover ${view.failover ? 'on' : 'off'}`,
    `  1. ${DEFAULT_ACCOUNT} (your own \`${executor} login\`)`,
    ...view.accounts.map(
      (a, i) => `  ${i + 2}. ${a.label} (added ${a.addedAt.slice(0, 10)})`
    ),
  ];
}

export function registerAccountsCommands(
  program: Command,
  ctx: CliContext
): void {
  const accounts = program
    .command('accounts')
    .description(
      'List the subscription accounts a run moves to when one hits its usage limit'
    )
    .option('--executor <name>', 'the executor (default: claude)')
    .action((opts: { executor?: string }) => {
      for (const line of describeAccounts(executorOption(opts.executor))) {
        ctx.log(line);
      }
    });

  accounts
    .command('add <label>')
    .description(
      'Store another account, last in failover order. The token is read from stdin or a prompt; make one with `claude setup-token` while signed in to that account'
    )
    .option('--executor <name>', 'the executor (default: claude)')
    .action(async (label: string, opts: { executor?: string }) => {
      const executor = executorOption(
        opts.executor ?? accounts.opts<{ executor?: string }>().executor
      );
      const token = await readSecret(
        ctx,
        `OAuth token for ${label} (from \`claude setup-token\`): `
      );
      try {
        addAgentAccount(executor, label, token);
      } catch (err) {
        throw new CliError((err as Error).message);
      }
      for (const line of describeAccounts(executor)) ctx.log(line);
      if (!readAgentAccounts(executor).failover) {
        ctx.log(
          'Failover is off; turn it on with `dispatch accounts failover on`.'
        );
      }
    });

  accounts
    .command('remove <label>')
    .description('Forget a stored account')
    .option('--executor <name>', 'the executor (default: claude)')
    .action((label: string, opts: { executor?: string }) => {
      const executor = executorOption(
        opts.executor ?? accounts.opts<{ executor?: string }>().executor
      );
      if (!removeAgentAccount(executor, label)) {
        throw new CliError(`no ${executor} account named ${label}`);
      }
      for (const line of describeAccounts(executor)) ctx.log(line);
    });

  accounts
    .command('failover <state>')
    .description(
      'Turn failover on or off: on, a run that hits a usage limit continues its session on the next account with usage left'
    )
    .option('--executor <name>', 'the executor (default: claude)')
    .action((state: string, opts: { executor?: string }) => {
      if (state !== 'on' && state !== 'off') {
        throw new CliError('failover takes "on" or "off"');
      }
      const executor = executorOption(
        opts.executor ?? accounts.opts<{ executor?: string }>().executor
      );
      setAccountFailover(executor, state === 'on');
      for (const line of describeAccounts(executor)) ctx.log(line);
    });
}
