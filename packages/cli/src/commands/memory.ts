import type { Command } from 'commander';
import { resolve } from 'node:path';

import type {
  ApiClient,
  ClaudeImportReport,
  MemoryEntry,
  MemoryProposal,
  MemorySaveResult,
} from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { appTokenClient } from './appToken.js';

const TOKEN_HELP =
  'the daemon app token (or DISPATCH_APP_TOKEN), or a teammate token';
// The most entries one list page asks for; the daemon's own ceiling.
const PAGE = 200;
const BULK_ORIGINS = ['ledger', 'claude'] as const;

type TokenOpts = { token?: string };

function entryLine(e: MemoryEntry): string {
  return `${e.handle}  ${e.kind}  ${e.scope}  ${e.state}  ${e.title}`;
}

function proposalLine(p: MemoryProposal): string {
  const about = p.content?.title ?? p.target ?? '';
  return `${p.id}  ${p.state}  ${p.action}  ${p.scope}  ${about}`;
}

// What a save, retire or promote did; a proposal says where a human decides it.
function saveLine(result: MemorySaveResult): string {
  if (result.status === 'proposed')
    return `proposed as ${result.proposal}, waiting for a human in Needs you`;
  return `${result.status === 'retired' ? 'retired' : 'saved'} ${result.handle}`;
}

// What an import of the owner's Claude notes did; an unconfirmed one lists
// where the notes may be and how to answer.
function claudeImportLines(r: ClaudeImportReport, dryRun: boolean): string[] {
  const from = r.source === null ? '' : ` from ${r.source}`;
  const counts = `imported ${r.imported} · updated ${r.updated} · unchanged ${r.unchanged} · duplicates ${r.duplicates} · tombstoned ${r.tombstoned}`;
  const lines = [`${dryRun ? 'dry run, ' : ''}${r.state}${from}: ${counts}`];
  for (const p of r.problems) lines.push(`problem: ${p}`);
  if (r.state !== 'unconfirmed') return lines;
  for (const c of r.candidates) lines.push(`candidate: ${c}`);
  lines.push(
    'answer with `dispatch memory import-claude --from <dir>` or `--none`'
  );
  return lines;
}

// Confirms every agent-trust entry from `origin`, a page at a time; an entry
// that comes back still unconfirmed means a confirm did not take, so it stops.
async function confirmFromOrigin(
  client: ApiClient,
  origin: (typeof BULK_ORIGINS)[number]
): Promise<number> {
  const confirmed = new Set<string>();
  for (;;) {
    const { entries } = await client.listMemory({
      origin,
      trust: 'agent',
      limit: PAGE,
    });
    if (entries.length === 0) return confirmed.size;
    const stuck = entries.find((e) => confirmed.has(e.id));
    if (stuck !== undefined)
      throw new CliError(
        `stopped after ${confirmed.size} confirmations: ${stuck.handle} is still agent trust`
      );
    for (const e of entries) {
      await client.confirmMemory(e.handle);
      confirmed.add(e.id);
    }
  }
}

export function registerMemoryCommands(
  program: Command,
  ctx: CliContext
): void {
  const memory = program
    .command('memory')
    .description(
      'Inspect and manage Dispatch memory (needs the daemon app token or a teammate token)'
    );
  const client = (opts: TokenOpts, command: string) =>
    appTokenClient(ctx, opts.token, `dispatch memory ${command}`);

  memory
    .command('list')
    .description('List the memory entries you can see, best-ranked first')
    .option('--scope <scope>', 'personal, project or team')
    .option('--kind <kind>', 'hazard, decision, constraint, preference, …')
    .option('--state <state>', 'active, stale, retired or all')
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(
      async (
        opts: TokenOpts & {
          scope?: string;
          kind?: string;
          state?: string;
          json?: boolean;
        }
      ) => {
        const api = await client(opts, 'list');
        const { entries } = await api.listMemory({
          scope: opts.scope,
          kind: opts.kind,
          state: opts.state,
        });
        if (opts.json === true) {
          ctx.log(JSON.stringify(entries, null, 2));
          return;
        }
        for (const e of entries) ctx.log(entryLine(e));
      }
    );

  memory
    .command('show <ref>')
    .description('Show one entry, by id or #handle')
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(async (ref: string, opts: TokenOpts & { json?: boolean }) => {
      const read = await (await client(opts, 'show')).getMemory(ref);
      if (opts.json === true) {
        ctx.log(JSON.stringify(read, null, 2));
        return;
      }
      const e = read.entry;
      ctx.log(entryLine(e));
      ctx.log(
        `trust ${e.trust}  by ${e.author}  rev ${e.rev}  recalled ${read.recallCount}`
      );
      if (e.body !== '') ctx.log(`\n${e.body}`);
    });

  memory
    .command('save')
    .description(
      'Save an entry; shared memory from anyone but a deciding human is a proposal'
    )
    .requiredOption('--scope <scope>', 'personal, project or team')
    .requiredOption('--kind <kind>', 'hazard, decision, constraint, …')
    .requiredOption('--title <title>', 'one line')
    .option('--body <body>', 'the detail', '')
    .option('--project-only', 'keep a personal entry to this project')
    .option('--token <token>', TOKEN_HELP)
    .action(
      async (
        opts: TokenOpts & {
          scope: string;
          kind: string;
          title: string;
          body: string;
          projectOnly?: boolean;
        }
      ) => {
        const api = await client(opts, 'save');
        const result = await api.saveMemory({
          scope: opts.scope,
          kind: opts.kind,
          title: opts.title,
          body: opts.body,
          ...(opts.projectOnly === true ? { projectOnly: true } : {}),
        });
        ctx.log(saveLine(result));
      }
    );

  memory
    .command('forget <ref>')
    .description('Retire an entry, or propose retiring a shared one')
    .requiredOption('--reason <reason>', 'why it no longer holds')
    .option('--token <token>', TOKEN_HELP)
    .action(async (ref: string, opts: TokenOpts & { reason: string }) => {
      const api = await client(opts, 'forget');
      ctx.log(saveLine(await api.retireMemory(ref, opts.reason)));
    });

  memory
    .command('undo <ref>')
    .description("Restore an entry's previous revision")
    .option('--token <token>', TOKEN_HELP)
    .action(async (ref: string, opts: TokenOpts) => {
      const entry = await (await client(opts, 'undo')).undoMemory(ref);
      ctx.log(`undone: ${entryLine(entry)}`);
    });

  memory
    .command('confirm [ref]')
    .description(
      'Confirm an agent-trust entry, or with --origin every one imported from there'
    )
    .option('--origin <origin>', 'ledger or claude')
    .option('--token <token>', TOKEN_HELP)
    .action(
      async (
        ref: string | undefined,
        opts: TokenOpts & { origin?: string }
      ) => {
        if ((ref === undefined) === (opts.origin === undefined))
          throw new CliError('confirm takes a ref or --origin, not both');
        if (ref !== undefined) {
          const api = await client(opts, 'confirm');
          ctx.log(`confirmed ${(await api.confirmMemory(ref)).handle}`);
          return;
        }
        const origin = BULK_ORIGINS.find((o) => o === opts.origin);
        if (origin === undefined)
          throw new CliError('--origin: expected ledger or claude');
        const api = await client(opts, 'confirm');
        const count = await confirmFromOrigin(api, origin);
        ctx.log(`confirmed ${count} entries from ${origin}`);
      }
    );

  for (const pinned of [true, false]) {
    const verb = pinned ? 'pin' : 'unpin';
    memory
      .command(`${verb} <ref>`)
      .description(
        pinned
          ? 'Keep an entry at the top of every index'
          : 'Let a pinned entry rank as usual'
      )
      .option('--token <token>', TOKEN_HELP)
      .action(async (ref: string, opts: TokenOpts) => {
        const entry = await (await client(opts, verb)).pinMemory(ref, pinned);
        ctx.log(`${verb}ned ${entry.handle}`);
      });
  }

  memory
    .command('delete <ref>')
    .description('Delete an entry and its history for good')
    .option('--token <token>', TOKEN_HELP)
    .action(async (ref: string, opts: TokenOpts) => {
      await (await client(opts, 'delete')).deleteMemory(ref);
      ctx.log(`deleted ${ref}`);
    });

  memory
    .command('promote <ref>')
    .description('Copy a personal entry into shared memory')
    .requiredOption('--scope <scope>', 'project or team')
    .option('--token <token>', TOKEN_HELP)
    .action(async (ref: string, opts: TokenOpts & { scope: string }) => {
      const api = await client(opts, 'promote');
      ctx.log(saveLine(await api.promoteMemory(ref, opts.scope)));
    });

  memory
    .command('proposals')
    .description('List memory proposals: every one for a deciding human')
    .option('--state <state>', 'open, approved, rejected or expired')
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(async (opts: TokenOpts & { state?: string; json?: boolean }) => {
      const api = await client(opts, 'proposals');
      const { proposals } = await api.listMemoryProposals(opts.state);
      if (opts.json === true) {
        ctx.log(JSON.stringify(proposals, null, 2));
        return;
      }
      for (const p of proposals) ctx.log(proposalLine(p));
    });

  memory
    .command('link [code]')
    .description(
      'Print a code that links another project to your personal memory, or use one'
    )
    .option('--fresh', 'start a new, empty personal memory for this handle')
    .option('--token <token>', TOKEN_HELP)
    .action(
      async (
        code: string | undefined,
        opts: TokenOpts & { fresh?: boolean }
      ) => {
        const api = await client(opts, 'link');
        if (code !== undefined) {
          const { identity } = await api.completeMemoryLink(code);
          ctx.log(`linked to identity ${identity}`);
          return;
        }
        const started = await api.startMemoryLink({ fresh: opts.fresh });
        if ('identity' in started) {
          ctx.log(`started a fresh identity ${started.identity}`);
          return;
        }
        ctx.log(
          `run \`dispatch memory link ${started.code}\` in the other project before ${started.expiresAt}`
        );
      }
    );

  memory
    .command('import-claude')
    .description(
      "Import your Claude Code notes for this project as personal memory (the daemon's own human only)"
    )
    .option('--from <dir>', 'import from this directory under your home')
    .option('--none', 'record that you have no Claude notes for this project')
    .option('--dry-run', 'report without writing')
    .option('--json')
    .option('--token <token>', 'the daemon app token (or DISPATCH_APP_TOKEN)')
    .action(
      async (opts: {
        from?: string;
        none?: boolean;
        dryRun?: boolean;
        json?: boolean;
        token?: string;
      }) => {
        if (opts.from !== undefined && opts.none === true)
          throw new CliError('give --from or --none, not both');
        const api = await client(opts, 'import-claude');
        const dryRun = opts.dryRun === true;
        const { report } = await api.importClaude({
          ...(opts.from === undefined
            ? {}
            : { from: resolve(ctx.cwd, opts.from) }),
          none: opts.none === true,
          dryRun,
        });
        if (opts.json === true) ctx.log(JSON.stringify(report, null, 2));
        else
          for (const line of claudeImportLines(report, dryRun)) ctx.log(line);
        if (report.state === 'failed')
          throw new CliError(
            `Claude notes import failed: ${report.problems.join('; ')}`
          );
      }
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
        const api = await client(opts, 'import-ledger');
        const { report, text } = await api.importLedger(opts.dryRun === true);
        ctx.log(opts.json === true ? JSON.stringify(report, null, 2) : text);
        // The daemon rolled the import back, so the report is all there is.
        if (report.outcome === 'MISMATCH') {
          throw new CliError('ledger import MISMATCH: nothing was written');
        }
      }
    );
}
