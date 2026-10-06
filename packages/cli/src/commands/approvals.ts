import type { Command } from 'commander';

import type { Message } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { formatTable } from '../output.js';
import { appTokenClient } from './appToken.js';

const TOKEN_HELP = 'the daemon app token (or DISPATCH_APP_TOKEN)';

// Each gate type names its yes and no differently (approve/deny, grant/deny,
// confirm/cancel, approve/reject, approve/decline).
const APPROVE_CHOICES = ['approve', 'grant', 'confirm', 'accept', 'yes'];
const DENY_CHOICES = ['deny', 'reject', 'decline', 'cancel', 'no'];

interface GateFields {
  type?: unknown;
  agent?: unknown;
  requestId?: unknown;
  runId?: unknown;
  tool?: unknown;
  paths?: unknown;
}

function gateFields(item: Message): GateFields {
  const data = item.data;
  return data !== null && typeof data === 'object' ? (data as GateFields) : {};
}

// What kind of Needs you item this is: its gate type, or a plain question.
function approvalKind(item: Message): string {
  const { type } = gateFields(item);
  return typeof type === 'string' ? type : item.kind;
}

// One line saying what the item asks, with the detail its kind carries.
function approvalSummary(item: Message): string {
  const data = gateFields(item);
  const firstLine = item.body.split('\n')[0] ?? '';
  const detail =
    typeof data.tool === 'string'
      ? `${data.tool} on run ${String(data.runId)}`
      : Array.isArray(data.paths)
        ? `paths ${data.paths.join(', ')}`
        : typeof data.agent === 'string'
          ? data.agent
          : '';
  const text = detail === '' ? firstLine : `${detail}: ${firstLine}`;
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

// The open item `ref` names: its message id, a pending agent's address, or a
// tool call's request id.
function findApproval(items: Message[], ref: string): Message {
  const found = items.find((m) => {
    const data = gateFields(m);
    return m.id === ref || data.agent === ref || data.requestId === ref;
  });
  if (found !== undefined) return found;
  throw new CliError(
    items.length === 0
      ? `${ref} is not awaiting a decision: nothing is pending`
      : `${ref} is not awaiting a decision; pending: ${items.map((m) => m.id).join(', ')} (see dispatch approvals)`
  );
}

// The item's own choice for yes or no, so each gate type gets its word.
function pickChoice(
  item: Message,
  want: 'approve' | 'deny',
  session: boolean
): string {
  const choices = item.choices ?? [];
  if (session) {
    if (choices.includes('approve-session')) return 'approve-session';
    throw new CliError(
      `--session applies only to tool approvals; ${item.id} is a ${approvalKind(item)}`
    );
  }
  const words = want === 'approve' ? APPROVE_CHOICES : DENY_CHOICES;
  const choice = words.find((w) => choices.includes(w));
  if (choice !== undefined) return choice;
  throw new CliError(
    choices.length === 0
      ? `${item.id} is a free-text question, not an approval; answer it in the Dispatch app's Needs you queue`
      : `${item.id} has no ${want} choice; its choices: ${choices.join(', ')}`
  );
}

export function registerApprovalsCommands(
  program: Command,
  ctx: CliContext
): void {
  const approvals = program
    .command('approvals')
    .description(
      'List and decide what is waiting on you: tool approvals, scope requests, new agents and other Needs you items (needs the daemon app token)'
    );

  approvals
    .command('list', { isDefault: true })
    .description('List the open Needs you items, oldest first')
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(async (opts: { json?: boolean; token?: string }) => {
      const client = await appTokenClient(
        ctx,
        opts.token,
        'dispatch approvals'
      );
      const { items } = await client.openDecisions();
      if (opts.json === true) {
        ctx.log(JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        ctx.log('Nothing is waiting on you.');
        return;
      }
      ctx.log(
        formatTable([
          ['ID', 'KIND', 'FROM', 'CHOICES', 'ASKS'],
          ...items.map((m) => [
            m.id,
            approvalKind(m),
            m.from,
            (m.choices ?? []).join('/'),
            approvalSummary(m),
          ]),
        ])
      );
      ctx.log('');
      ctx.log(
        'Decide one with: dispatch approvals approve <id>  or  dispatch approvals deny <id>'
      );
    });

  approvals
    .command('approve <id>')
    .description(
      'Approve or grant an open item by its id (a pending agent address or tool request id works too)'
    )
    .option('--session', 'for a tool approval: allow the tool for the run')
    .option('--token <token>', TOKEN_HELP)
    .action(
      async (ref: string, opts: { session?: boolean; token?: string }) => {
        const client = await appTokenClient(
          ctx,
          opts.token,
          'dispatch approvals approve'
        );
        const item = findApproval((await client.openDecisions()).items, ref);
        const choice = pickChoice(item, 'approve', opts.session === true);
        await client.replyToMessage(item.id, { body: '', choice });
        ctx.log(`${item.id} ${choice} (${approvalKind(item)})`);
      }
    );

  approvals
    .command('deny <id>')
    .description('Deny an open item by its id')
    .option('--reason <text>', 'why, recorded with the answer')
    .option('--token <token>', TOKEN_HELP)
    .action(async (ref: string, opts: { reason?: string; token?: string }) => {
      const client = await appTokenClient(
        ctx,
        opts.token,
        'dispatch approvals deny'
      );
      const item = findApproval((await client.openDecisions()).items, ref);
      const choice = pickChoice(item, 'deny', false);
      await client.replyToMessage(item.id, { body: opts.reason ?? '', choice });
      ctx.log(`${item.id} ${choice} (${approvalKind(item)})`);
    });
}
