import type { Command } from 'commander';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, parseTaskFile } from '@dispatch/core';
import type { TaskDoc } from '@dispatch/core';
import { CliError, type CliContext } from '../context.js';
import { requireStore } from './task.js';

interface Issue { file: string; problem: string; }

export function registerDoctorCommand(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('Validate task files and references')
    .option('--json')
    .action((opts: { json?: boolean }) => {
      const store = requireStore(ctx);
      const config = loadConfig(ctx.cwd);
      const issues: Issue[] = [];
      const docs: TaskDoc[] = [];

      for (const file of readdirSync(store.tasksDir).filter(f => f.endsWith('.md'))) {
        try {
          docs.push(parseTaskFile(readFileSync(join(store.tasksDir, file), 'utf8'), file));
        } catch (err) {
          issues.push({ file, problem: (err as Error).message });
        }
      }

      const ids = new Set(docs.map(d => d.meta.id));
      for (const d of docs) {
        const file = `${d.meta.id}`;
        if (d.meta.parent && !ids.has(d.meta.parent)) {
          issues.push({ file, problem: `dangling parent: ${d.meta.parent}` });
        }
        for (const dep of d.meta.blockedBy) {
          if (!ids.has(dep)) issues.push({ file, problem: `dangling blocked-by: ${dep}` });
        }
        if (!config.statuses.includes(d.meta.status)) {
          issues.push({ file, problem: `status not in config: ${d.meta.status}` });
        }
      }

      if (opts.json) {
        ctx.log(JSON.stringify({ ok: issues.length === 0, tasks: docs.length, issues }, null, 2));
      } else if (issues.length === 0) {
        ctx.log(`ok — ${docs.length} task${docs.length === 1 ? '' : 's'} checked`);
      } else {
        for (const i of issues) ctx.log(`${i.file}: ${i.problem}`);
      }
      if (issues.length > 0) {
        throw new CliError(`${issues.length} issue${issues.length === 1 ? '' : 's'} found`);
      }
    });
}
