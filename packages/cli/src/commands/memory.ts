import type { Command } from 'commander';

import { type CliContext, CliError } from '../context.js';
import { appTokenClient } from './appToken.js';

export function registerMemoryCommands(
  program: Command,
  ctx: CliContext
): void {
  const memory = program
    .command('memory')
    .description(
      'Inspect and manage Dispatch memory (needs the daemon app token)'
    );

  memory
    .command('import-ledger')
    .description(
      'Import ledger lessons into memory and print the count-parity report'
    )
    .option('--dry-run', 'report without writing')
    .option('--json')
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .action(
      async (opts: { dryRun?: boolean; json?: boolean; token?: string }) => {
        const client = await appTokenClient(
          ctx,
          opts.token,
          'dispatch memory import-ledger'
        );
        const { report, text } = await client.importLedger(
          opts.dryRun === true
        );
        ctx.log(opts.json === true ? JSON.stringify(report, null, 2) : text);
        // The daemon rolled the import back, so the report is all there is.
        if (report.outcome === 'MISMATCH') {
          throw new CliError('ledger import MISMATCH: nothing was written');
        }
      }
    );
}
